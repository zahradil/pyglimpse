import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HOST_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "host.py");

function resolveUvPath(): string {
  // 1. settings.json override: pyglimpse.uvPath
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const uvPath = (settings?.pyglimpse as Record<string, unknown>)?.uvPath;
    if (uvPath && typeof uvPath === "string") return uvPath;
  } catch {}

  // 2. uv.exe in PATH (WSL with Windows uv)
  try {
    const result = execSync("which uv.exe", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (result) return result;
  } catch {}

  // 3. uv in PATH (Linux / macOS)
  try {
    const result = execSync("which uv", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (result) return result;
  } catch {}

  throw new Error(
    "[pyglimpse] uv not found. Install uv (https://docs.astral.sh/uv/getting-started/installation/) " +
    "or set pyglimpse.uvPath in ~/.pi/agent/settings.json"
  );
}

// ─── Host process manager ──────────────────────────────────────────────────

class PyGlimpseHost extends EventEmitter {
  private proc: ChildProcess | null = null;
  private hostReady = false;
  private queue: string[] = [];

  start() {
    const uvPath = resolveUvPath();
    this.proc = spawn(uvPath, ["run", "--with", "pywebview", HOST_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr?.on("data", (d) => {
      const text = d.toString().trim();
      if (text) console.log("[pyglimpse:py]", text);
    });

    // Ignoruj EPIPE na stdin — nastane kdyz Python exituje pres os._exit(0)
    // bez tohoto by Node.js hodil unhandled error a mohl destabilizovat pi
    this.proc.stdin?.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") console.error("[pyglimpse] stdin error:", e.message);
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);

        if (msg.type === "ready" && !msg.id && !this.hostReady) {
          this.hostReady = true;
          for (const queued of this.queue) {
            this.proc!.stdin!.write(queued + "\n");
          }
          this.queue = [];
        }

        this.emit(msg.type, msg);
      } catch {
        console.error("[pyglimpse] Bad JSON from host:", line);
      }
    });

    this.proc.on("exit", (_code) => {
      rl.close();
      this.hostReady = false;
      this.proc = null;
    });

    this.proc.on("error", (err) => {
      console.error("[pyglimpse] Spawn error:", err.message);
    });
  }

  send(msg: object) {
    const line = JSON.stringify(msg);
    if (this.hostReady && this.proc?.stdin) {
      this.proc.stdin.write(line + "\n");
    } else {
      this.queue.push(line);
      if (!this.proc) this.start();
    }
  }

  show(id: string, html: string, options: Record<string, unknown> = {}) {
    // Pokud je url, html ignorujeme — Python host pozna url v options
    const msg: Record<string, unknown> = { type: "show", id, ...options };
    if (!options.url) msg.html = html;
    this.send(msg);
  }

  eval(id: string, js: string) {
    this.send({ type: "eval", id, js });
  }

  close(id: string) {
    this.send({ type: "close", id });
  }

  stop() {
    this.proc?.stdin?.end();
    this.proc = null;
    this.hostReady = false;
    this.queue = [];
  }

  get running() {
    return !!this.proc;
  }
}

// ─── HTML helpers ──────────────────────────────────────────────────────────

const BASE = "background:#0f172a;color:#e2e8f0;font-family:system-ui;margin:0";

function notifyHtml(message: string, title: string): string {
  return `<body style="${BASE}">
    <div style="padding:18px 24px;border-radius:14px;border:1px solid #67e8f9;
                box-shadow:0 20px 25px -5px rgba(0,0,0,0.4);
                display:flex;align-items:center;gap:14px;">
      <div>
        <div style="font-weight:600;color:#67e8f9;margin-bottom:4px">${title}</div>
        <div style="font-size:14px;opacity:0.9">${message}</div>
      </div>
    </div>
  </body>`;
}

function testHtml(): string {
  return `<body style="${BASE};height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px;text-align:center;">
    <h1 style="color:#67e8f9;margin:0;font-size:28px">pyglimpse</h1>
    <p style="max-width:360px;color:#94a3b8;line-height:1.6">
      Okno bezi jako <strong>persistent host</strong>.<br>
      TypeScript a Python komunikuji pres<br>stdin/stdout JSON Lines.
    </p>
    <button
      style="padding:14px 36px;background:#67e8f9;color:#0f172a;border:none;border-radius:9999px;font-weight:700;cursor:pointer;font-size:15px;"
      onclick="
        const st = document.getElementById('st');
        st.textContent = 'Sending...';
        st.style.color = '#67e8f9';
        window.pyglimpse.send({ action: 'button_click', value: 42 });
        setTimeout(() => { st.textContent = 'Sent! Check pi console.'; st.style.color = '#a5f3fc'; }, 600);
      ">
      Send to Python
    </button>
    <div id="st" style="font-size:13px;color:#64748b;min-height:20px"></div>
  </body>`;
}

// ─── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const host = new PyGlimpseHost();
  let hostStarted = false;

  function ensureHost() {
    if (!hostStarted) {
      hostStarted = true;
      host.start();
    }
  }

  // ─── Event buffering & watches ──────────────────────────────────────────

  // Pasivní eventy se bufferují a pošlou jako jeden batch po 300ms tichu.
  // triggerTurn: false — agent nedostane tah, jen vidí co se dělo.
  const eventBuffer = new Map<string, { events: unknown[]; timer: ReturnType<typeof setTimeout> | null }>();

  // Watches nastavené agentem přes pyglimpse_watch.
  // Když přijde matching event, agent dostane tah (triggerTurn: true).
  // repeat: false = single-fire (výchozí), repeat: true = opakující se
  const watches = new Map<string, Array<{ match: string | undefined; repeat: boolean }>>();

  function flushBuffer(windowId: string) {
    const buf = eventBuffer.get(windowId);
    if (!buf || buf.events.length === 0) return;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    const events = [...buf.events];
    buf.events.length = 0;
    eventBuffer.delete(windowId);
    const content = events.length === 1
      ? `'${windowId}': ${JSON.stringify(events[0])}`
      : `'${windowId}' (${events.length} events):\n${events.map(e => `  • ${JSON.stringify(e)}`).join("\n")}`;
    pi.sendMessage({ customType: "pyglimpse-event", content, display: true }, { triggerTurn: false });
  }

  function handleMessage(windowId: string, data: unknown) {
    const dataStr = JSON.stringify(data);
    const windowWatches = watches.get(windowId) ?? [];

    for (let i = windowWatches.length - 1; i >= 0; i--) {
      const watch = windowWatches[i];
      if (!watch.match || dataStr.includes(watch.match)) {
        if (!watch.repeat) {
          windowWatches.splice(i, 1);
          if (windowWatches.length === 0) watches.delete(windowId);
          else watches.set(windowId, windowWatches);
        }
        // Flush pending passive events first, then fire watch with triggerTurn
        flushBuffer(windowId);
        pi.sendMessage(
          { customType: "pyglimpse-event", content: `[watch] '${windowId}': ${dataStr}`, display: true },
          { triggerTurn: true },
        );
        return;
      }
    }

    // Žádný watch — zařadit do debounce bufferu
    let buf = eventBuffer.get(windowId);
    if (!buf) {
      buf = { events: [], timer: null };
      eventBuffer.set(windowId, buf);
    }
    buf.events.push(data);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushBuffer(windowId), 1500);
  }

  host.on("message", (msg: { id: string; data: unknown }) => {
    handleMessage(msg.id, msg.data);
  });

  host.on("ready", (msg: { id?: string }) => {
    void msg;
  });

  host.on("closed", (msg: { id: string }) => {
    flushBuffer(msg.id); // vyprázdni buffer před zavřením
    pi.sendMessage(
      { customType: "pyglimpse-event", content: `Window '${msg.id}' closed.`, display: true },
      { triggerTurn: false },
    );
  });

  // ─── /py <subcommand> ──────────────────────────────────────────────────

  pi.registerCommand("py", {
    description: "pyglimpse: show | notify <text> | close <id> | eval <id> <js> | stop",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? "show";

      ensureHost();

      switch (sub) {
        case "show":
        case "test": {
          host.show("test", testHtml(), { width: 520, height: 420, title: "pyglimpse" });
          ctx.ui.notify("Window opening...", "info");
          return;
        }

        case "notify": {
          const text = parts.slice(1).join(" ") || "Hello from pi agent";
          const id = `notify-${Date.now()}`;
          host.show(id, notifyHtml(text, "pyglimpse"), {
            width: 400, height: 100, frameless: true,
          });
          setTimeout(() => host.close(id), 3500);
          ctx.ui.notify(`Notification: "${text}"`, "info");
          return;
        }

        case "close": {
          const id = parts[1] ?? "test";
          host.close(id);
          ctx.ui.notify(`Closed '${id}'`, "info");
          return;
        }

        case "eval": {
          const id = parts[1] ?? "test";
          const js = parts.slice(2).join(" ");
          if (!js) {
            ctx.ui.notify("Usage: /py eval <id> <js>", "error");
            return;
          }
          host.eval(id, js);
          ctx.ui.notify(`Eval sent to '${id}'`, "info");
          return;
        }

        case "stop": {
          host.stop();
          hostStarted = false;
          ctx.ui.notify("Host stopped", "info");
          return;
        }

        default:
          ctx.ui.notify(`Nezname: ${sub}. Prikazy: show, notify, close, eval, stop`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    host.stop();
  });

  // ─── Tool: agent muze sam otevrit okno ────────────────────────────────

  pi.registerTool({
    name: "pyglimpse_show",
    label: "Show Window",
    description: "Otevre nativni okno s HTML obsahem. Pouzij kdyz chces uzivateli neco vizualne ukazat — diagram, vysledek, formular, potvrzeni. Okno bezi jako persistent host. Zpravy z okna (kliknuti, zavreni) se objevi v konverzaci.",
    promptSnippet: "Show an HTML window to the user (charts, diagrams, confirmations, forms)",
    parameters: Type.Object({
      id:     Type.String({ description: "Unikatni ID okna, napr. 'result', 'dev-server'" }),
      html:   Type.Optional(Type.String({ description: "HTML obsah okna (kompletni <body>...</body>). Pouzij bud html nebo url." })),
      url:    Type.Optional(Type.String({ description: "URL stranky ktera se ma otevrit (napr. http://localhost:5173). Pouzij bud html nebo url." })),
      width:  Type.Optional(Type.Number({ description: "Sirka okna v pixelech (default: html=600, url=1024)" })),
      height: Type.Optional(Type.Number({ description: "Vyska okna v pixelech (default: html=400, url=768)" })),
      title:  Type.Optional(Type.String({ description: "Titulek okna" })),
      frameless: Type.Optional(Type.Boolean({ description: "Bez titulkoveho pruhu (default false)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      ensureHost();
      host.show(params.id, params.html ?? "", {
        url:       params.url,
        width:     params.width,
        height:    params.height,
        title:     params.title     ?? (params.url ? params.url : "pyglimpse"),
        frameless: params.frameless ?? false,
      });
      const target = params.url ? `URL '${params.url}'` : "HTML content";
      return {
        content: [{ type: "text", text: `Window '${params.id}' opened (${target}). Messages from the window will appear in the conversation.` }],
        details: { id: params.id },
      };
    },
  });

  pi.registerTool({
    name: "pyglimpse_close",
    label: "Close Window",
    description: "Zavre okno otevrene pres pyglimpse_show.",
    parameters: Type.Object({
      id: Type.String({ description: "ID okna ktere chces zavrit" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      host.close(params.id);
      return {
        content: [{ type: "text", text: `Window '${params.id}' closed.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pyglimpse_eval",
    label: "Eval in Window",
    description: "Spusti JavaScript v otevrene okne. Pouzij pro live aktualizaci obsahu bez zavreni okna.",
    parameters: Type.Object({
      id: Type.String({ description: "ID okna" }),
      js: Type.String({ description: "JavaScript ktery se ma spustit v okne" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      host.eval(params.id, params.js);
      return {
        content: [{ type: "text", text: `Eval sent to '${params.id}'.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pyglimpse_watch",
    label: "Watch Window Event",
    description: "Nastav watch na event z okna. Až přijde matching event, dostáneš tah a budeš moct reagovat (např. zavolat pyglimpse_eval a aktualizovat okno). POUZIVEJ STRIDME — jen na klíčové momenty jako potvrzení nebo odeslání formuláře. Není vhodné na každé kliknutí.",
    promptSnippet: "Watch for a specific event from a window and get a turn to react",
    parameters: Type.Object({
      id:     Type.String({ description: "ID okna" }),
      match:  Type.Optional(Type.String({ description: "Substring který musí být obsažen v JSON dat eventu (např. 'submit', 'confirm'). Bez tohoto matchuje cokoliv z okna." })),
      repeat: Type.Optional(Type.Boolean({ description: "true = opakující se watch (nesmazá se po prvním eventu). false = single-fire (výchozí)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const windowWatches = watches.get(params.id) ?? [];
      windowWatches.push({ match: params.match, repeat: params.repeat ?? false });
      watches.set(params.id, windowWatches);
      const mode = params.repeat ? "repeat" : "single-fire";
      return {
        content: [{ type: "text", text: `Watch (${mode}) set on '${params.id}'${params.match ? ` matching "${params.match}"` : " (any event)"}. You'll get a turn when triggered.` }],
        details: {},
      };
    },
  });

  console.log("[pyglimpse] Extension loaded. Use /py show to open a window.");
}
