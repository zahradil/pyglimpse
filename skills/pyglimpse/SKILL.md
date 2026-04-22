---
name: pyglimpse
description: Show native HTML windows from pi agent using Python + pywebview. Use when you need to display HTML to the user, collect input, show a chart, or create any visual interaction. Provides pyglimpse_show, pyglimpse_close, pyglimpse_eval, pyglimpse_watch tools.
---

# pyglimpse Skill

Nativní okna s HTML/CSS/JS nebo URL z WSL2 — přes pywebview + Edge WebView2 na Windows.
Pi extension poskytuje nástroje pro agenta i uživatele.

## Nástroje

| Nástroj | Popis |
|---|---|
| `pyglimpse_show` | Otevře okno s HTML nebo URL |
| `pyglimpse_close` | Zavře okno |
| `pyglimpse_eval` | Spustí JS v okně (live update bez zavření) |
| `pyglimpse_watch` | Jednorázový watch — agent dostane tah až přijde event |

Slash příkaz: `/py show | notify <text> | close <id> | eval <id> <js> | stop`

## Otevření okna

### HTML obsah
```
pyglimpse_show(id="result", html="<body>...</body>", width=600, height=400)
```

### URL (lokální server nebo web)
```
pyglimpse_show(id="dev", url="http://localhost:5173", width=1200, height=800)
```

Python host běží jako **Windows proces** (přes `uv.exe`), takže `localhost` odkazuje na Windows.
Z WSL2 servery jsou dostupné pokud má uživatel nastavené port forwarding (stejně jako v Chrome).

## Komunikace (JS → agent)

V HTML okně (ne URL) jsou dostupné tyto funkce:

```js
// Pasivní event — zobrazí se v chatu, agent nedostane tah
window.pyglimpse.send({ action: 'toggle', item: 'A' })

// Zavřít okno
window.pyglimpse.close()
```

**Poznámka:** `pyglimpse.send()` není dostupné v URL režimu (cizí stránka).
`pyglimpse_eval` funguje v obou režimech.

### Debounce (pasivní eventy)
Eventy ze stejného okna přicházející v krátkém sledu se sloučí do jednoho batche.
Debounce okno je **1500 ms** — pokrývá latenci WebView2 → Python IPC → Node.js.
Po 1.5s tichu se buffered eventy pošlou jako jedna zpráva:
```
'form' (3 events):
  • {"action":"pick","color":"red"}
  • {"action":"pick","color":"green"}
  • {"action":"pick","color":"blue"}
```

## Jak dát agentovi tah (pyglimpse_watch)

Agent si sám nastaví watch přes `pyglimpse_watch`. Až přijde matching event,
agent dostane tah a může reagovat (např. `pyglimpse_eval` pro update obsahu okna).

```
// Agent nastaví watch na event obsahující "submit"
pyglimpse_watch(id="form", match="submit")

// JS v okně — toto probudí agenta
window.pyglimpse.send({ type: "submit", data: { name: "Jan" } })
```

**Používej střídmě** — jen na klíčové momenty (potvrzení, odeslání formuláře).
Ne na každé kliknutí. Na běžné interakce stačí pasivní eventy.

## Typický workflow

```
1. agent: pyglimpse_show(id, html)        — otevře okno
2. agent: pyglimpse_watch(id, "confirm")  — nastaví wake-up
3. uživatel: zkoumá, kliká (pasivní eventy se logují v chatu jako batch)
4. uživatel: klikne "Potvrdit"            — pošle {type:"confirm",...}
5. agent: dostane tah, přečte co se dělo, zavolá pyglimpse_eval nebo close
```

## Constraints

- **WSL2 + Windows**: host.py běží přes `uv.exe run --with pywebview`
- **WebView2**: emoji a znaky nad U+FFFF se automaticky převedou na HTML entity
- **Jeden host process** — při zavření všech oken host exituje, při příštím `show` se automaticky restartuje
- **HTTP server není potřeba** — HTML se předává přímo jako string; URL režim otevírá přímo webovou stránku

## Architektura

```
pi extension (TS)  ←stdin/stdout JSON Lines→  host.py (Python/Windows)  →  WebView2
```

- `pyglimpse/host.py` — Python host process
- `pyglimpse/pi-extension/index.ts` — pi extension
