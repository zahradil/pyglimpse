# pyglimpse

Native HTML windows for [pi coding agent](https://pi.dev/) via Python + pywebview.

- inspired by pi package [glimpse by HazAT](https://github.com/hazat/glimpse)
- works on **WSL2** - renders as native Windows window via WebView2 via python runtime
- should work on **Linux** and **macOS** via python runtime too
- reactive, bidirectional communication:
  
```
pi extension (TS)  ←stdin/stdout JSON Lines→  host.py (Python/Windows)  →  WebView2
```


## Install

```bash
pi install git:github.com/zahradil/pyglimpse
```

## Requirements

- [uv](https://docs.astral.sh/uv/getting-started/installation/) — used to run `host.py` with pywebview
- On WSL2: `uv.exe` (Windows binary) recommended for native Windows windows

## Configuration

By default pyglimpse looks for `uv` / `uv.exe` in PATH. Override in `~/.pi/agent/settings.json`:

```json
{
  "pyglimpse": {
    "uvPath": "/mnt/c/Users/you/tools/uv.exe"
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `pyglimpse_show` | Open a window with HTML content or a URL |
| `pyglimpse_close` | Close a window |
| `pyglimpse_eval` | Run JavaScript in an open window (live update) |
| `pyglimpse_watch` | Watch for an event from a window — agent gets a turn when triggered |

Slash command: `/py show | notify <text> | close <id> | eval <id> <js> | stop`




