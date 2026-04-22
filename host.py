#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pywebview>=5.0"]
# ///
"""
pyglimpse host - persistent WebView process.

Spousti se jednou jako child process z TypeScript pi extension.
Komunikuje pres stdin/stdout JSON Lines.

TypeScript -> Python (stdin):
  {"type": "show",  "id": "w1", "html": "...", "width": 500, "height": 400, "title": "..."}
  {"type": "eval",  "id": "w1", "js": "document.title = 'Hi'"}
  {"type": "close", "id": "w1"}

Python -> TypeScript (stdout):
  {"type": "ready"}              -- host je nahore, ceka na prikazy
  {"type": "ready", "id": "w1"} -- okno nacteno
  {"type": "message", "id": "w1", "data": {...}} -- zprava z JS
  {"type": "closed", "id": "w1"}  -- okno zavreno
"""

import sys
import os
import io
import json
import re
import threading
import webview

# Explicitni UTF-8 pro stdin/stdout — dulezite na Windows kde default muze byt cp1252
if hasattr(sys.stdin, "buffer"):
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

_windows: dict = {}
_lock = threading.Lock()


def emit(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def make_api(win_id: str):
    class API:
        def send(self, data):
            # __close__ je prikaz k zavreni okna z JS (window.pyglimpse.close())
            if isinstance(data, dict) and data.get("__close__"):
                with _lock:
                    win = _windows.get(win_id)
                if win:
                    win.destroy()
            else:
                emit({"type": "message", "id": win_id, "data": data})
    return API()


BRIDGE = """
<script>
window.pyglimpse = {
    send: function(data) {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.send(data);
        } else {
            window.addEventListener('pywebviewready', function() {
                window.pywebview.api.send(data);
            });
        }
    },
    close: function() { window.pyglimpse.send({__close__: true}); }
};
</script>
"""


def encode_supplementary(html: str) -> str:
    """Enkoduje znaky nad U+FFFF a osamocene surrogaty jako HTML entity.
    WebView2 pouziva UTF-16 a nesnasa: (a) supplementary znaky bez entity, (b) lone surrogates.
    Lone surrogates mohou vzniknout pokud stdin encoding nebyl UTF-8 a emoji se rozpadlo.
    """
    result = []
    for ch in html:
        cp = ord(ch)
        if cp >= 0x10000 or (0xD800 <= cp <= 0xDFFF):
            result.append(f'&#{cp};')
        else:
            result.append(ch)
    return ''.join(result)


def cmd_show(msg: dict):
    win_id = msg["id"]
    url = msg.get("url")
    html = msg.get("html", "<body></body>")

    if url:
        # URL mode — nacteme stranku primo, bez html injection
        win = webview.create_window(
            title=msg.get("title", "pyglimpse"),
            url=url,
            js_api=make_api(win_id),
            width=msg.get("width", 1024),
            height=msg.get("height", 768),
            frameless=msg.get("frameless", False),
            transparent=msg.get("transparent", False),
        )
    else:
        html = encode_supplementary(html)

        if "</body>" in html:
            html = html.replace("</body>", BRIDGE + "</body>", 1)
        else:
            html = html + BRIDGE

        win = webview.create_window(
            title=msg.get("title", "pyglimpse"),
            html=html,
            js_api=make_api(win_id),
            width=msg.get("width", 800),
            height=msg.get("height", 600),
            frameless=msg.get("frameless", False),
            transparent=msg.get("transparent", False),
            background_color="#0f172a",
        )

    def on_loaded():
        emit({"type": "ready", "id": win_id})

    def on_closed():
        emit({"type": "closed", "id": win_id})
        with _lock:
            _windows.pop(win_id, None)

    win.events.loaded += on_loaded
    win.events.closed += on_closed

    with _lock:
        _windows[win_id] = win


def cmd_eval(msg: dict):
    win_id = msg.get("id")
    with _lock:
        win = _windows.get(win_id)
    if win:
        try:
            win.evaluate_js(msg.get("js", ""))
        except Exception as e:
            emit({"type": "error", "id": win_id, "error": str(e)})


def cmd_close(msg: dict):
    win_id = msg.get("id")
    with _lock:
        win = _windows.get(win_id)
    if win:
        try:
            win.destroy()
        except Exception:
            pass


def handle(msg: dict):
    t = msg.get("type")
    if t == "show":
        cmd_show(msg)
    elif t == "eval":
        cmd_eval(msg)
    elif t == "close":
        cmd_close(msg)
    else:
        emit({"type": "error", "error": f"unknown command: {t}"})


def stdin_loop():
    """Cte dalsi prikazy po startu GUI loopu."""
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            handle(json.loads(raw))
        except Exception as e:
            emit({"type": "error", "error": str(e)})

    # stdin se zavrel = TS skoncil
    with _lock:
        wins = list(_windows.values())
    for win in wins:
        try:
            win.destroy()
        except Exception:
            pass


if __name__ == "__main__":
    # Oznamime TS, ze jsme ready
    emit({"type": "ready"})

    # pywebview vyzaduje aspon jedno okno pred webview.start().
    # Proto cekame synchronne na prvni "show" prikaz ze stdinu.
    while True:
        raw = sys.stdin.readline()
        if not raw:
            sys.exit(0)
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
            handle(msg)
            if msg.get("type") == "show":
                break  # mame okno, muzeme spustit GUI loop
        except Exception as e:
            emit({"type": "error", "error": str(e)})

    # Spustime GUI loop; stdin_loop bezi v background threadu
    webview.start(func=stdin_loop)

    # webview.start() se vratil = vsechna okna zavrena.
    # Ukoncime process - TS extension detekuje exit a pri pristim
    # volani show() spusti novy host automaticky.
    os._exit(0)
