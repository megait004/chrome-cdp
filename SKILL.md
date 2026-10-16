---
name: chrome-cdp
description: Drive a real Chrome over the DevTools Protocol to audit a live page - dump forms and hidden inputs, capture raw HTTP and WebSocket frames for Burp, trace event listeners and postMessage handlers back to source, search and deobfuscate loaded JS bundles, query the V8 heap, and extract page content as Markdown. Use this whenever the question is about what a real site actually does at runtime rather than what its static HTML says - reverse engineering a signing or token algorithm, finding an undocumented API, replaying a request, auditing a login flow, inspecting a WebSocket protocol, unminifying a bundle, or debugging why a page behaves the way it does. It also drives canvas games and iframes (list frames, click and hold keys by coordinates, read canvases). Reach for it even when the user only says "look at this site", "how does this site do X", or "find the API behind this page" without naming Chrome, CDP, or DevTools.
license: ISC
compatibility: Windows with Git Bash, Google Chrome installed, Node.js. Run npm install in this skill directory if node_modules is missing.
---

# Chrome CDP

Toolkit for inspecting a **live** page: real Chrome (visible, never headless), real JS, real network. Use it against targets you are authorized to test. It reads and records; it does not attack.

Every path below is relative to this skill's directory (the one holding `SKILL.md`, `cli.js`, `index.js`). Run commands from there.

## Start here

1. **Chrome must be running.** The CLI never launches it: `node cli.js start` (uses its own `AutomationProfile`, port 9222). Otherwise every command fails with that same hint.
2. **Look before acting.** `node cli.js snapshot <url>` lists the page's elements *and* each iframe under `frames[]` (url, canvases, elements). Read it before every action; pick selectors from it, never from memory.
3. **Act.** `click`, `type`, `fill`, `press` by selector. For canvas games with no selectors: `click-at <x> <y> --frame <part>` and `key <code> --hold <ms>`.
4. **Read state.** `eval [--frame <part>] <expr>`, `traffic`, `search-sources`, and the bundle commands below.
5. **Tidy up.** `node cli.js clean` removes the scratch folder `.tmp/`. Put scratch files there, never in the repo.

## Which command for what

| Need | Command |
|---|---|
| What is on the page (and in each iframe) | `snapshot [url]` |
| Which iframes exist and which have canvases | `frames` (index, canvas count, element count, url) |
| Which tabs are open | `tabs`; every command accepts `--tab N` |
| Click, type, fill, press a DOM element | `click`, `type`, `fill`, `press` |
| Click or hold keys in a canvas game | `click-at <x> <y> --frame <part>`, `key <code> --hold <ms>` |
| Read a canvas | `canvas --frame <part> [--index N] [--out f.png] [--preserve]` |
| Run JavaScript in the page or an iframe | `eval [url] [--frame <part>] <expr>` |
| Record HTTP and WebSocket traffic | `traffic [url] [--bodies] [--wait S]` |
| Find and reverse a script bundle | `search-sources`, `download-bundle`, `deobfuscate`, `unpack`, `ast-search` |
| Pause at a line | `break` |
| Forms, storage, event listeners | `dump-forms`, `dump-storage`, `listeners` |
| Article as Markdown | `markdown [url] [out.md]` |

`<part>` is a substring of the frame URL, or the frame index from `frames`. `node cli.js --help` is the full list.

## Rules that prevent wasted runs

- **Snapshot, don't screenshot.** The CLI has no screenshot command. Text drawn on a canvas is invisible to `snapshot`: read the app's state with `eval --frame`, or the pixels with `canvas --out` only when the state cannot answer the question.
- **Recording starts at connect.** `traffic <url>` captures the load; anything before the attach is invisible. A live tab is read with `traffic --wait S` (no URL).
- **Git Bash rewrites a leading `/`** into `C:/Program Files/Git/`. Frame and tab arguments strip that prefix, but `--frame game.html` or a frame index from `frames` (`--frame 1`) is safer than `--frame /game`.
- **Keys go to the focused element.** Click the game first, or `key` does nothing visible.
- **A minimized or covered Chrome window** drops synthesized keys and hangs screenshots. `type` revives the window itself; see `references/guide.md`.

## Canvas games and iframes

Games draw on `<canvas>` inside an iframe, so there are no selectors. The loop:

```bash
node cli.js frames                                   # find the game frame (index, canvases, url)
node cli.js snapshot https://target.com/game         # canvas size and any elements per frame
node cli.js click-at 160 80 --frame game.html        # frame-relative coordinates
node cli.js key KeyW --hold 300 --frame game.html    # hold a key (game must be focused)
node cli.js eval --frame game.html "JSON.stringify(window.someState)"
```

- **2D canvas** reads back with `canvas --out` as soon as it is drawn.
- **WebGL canvas** reads back blank unless its drawing buffer is preserved. `canvas --preserve` reloads the tab (the game restarts) and installs that. Use it deliberately.
- **Game state can be better than pixels.** GameMaker HTML5 exports expose `g_pBuiltIn` (room, health, score), `g_instance_names`, and `gml_Script_*` functions, all readable through `eval --frame`. Other engines expose different globals: find them the same way, comparing against a clean iframe.

## Setup

Run `npm install` in the skill directory if `node_modules/` is missing. The failure is a bare `Cannot find module 'puppeteer-extra'`.

```bash
node cli.js start        # or: npm start
```

The library's `connect()` launches Chrome if none is running; the CLI does not, on purpose.

### When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `Chrome is not running on port N` | No Chrome on that port | `node cli.js start`, or pass `--port` |
| `Chrome executable not found` | Chrome is not in a standard install path | Set `CHROME_PATH` to the chrome.exe path |
| Connects but logged out everywhere | Chrome runs a **separate** `AutomationProfile`, by design | Log in once inside the automation browser (it persists), or point `CHROME_USER_DATA_DIR` at another profile with your normal Chrome fully closed |
| `ECONNREFUSED 127.0.0.1:9222` | Chrome died, or another process owns the port | `node cli.js start`, or `--port` |
| `Tab N does not exist` | Fewer tabs than the index | `node cli.js tabs`, then `--tab` with a listed index |
| `No frame whose URL matches …` | Wrong part, or the frame is not loaded yet | `node cli.js frames`, then use an index or a listed substring |
| WebGL canvas reads blank | Drawing buffer not preserved | `canvas --preserve` (reloads the tab) |
| Page opens `chrome://newtab` and reads empty | `connect()` reuses tab 0 and resets `chrome://` to `about:blank` | Expected: `goto()` your target |
| Hangs about 30 s, then `ProtocolError` | A CDP call exceeded the protocol timeout | `connect({ protocolTimeout: 120000 })` for heavy work |
| `Page.captureScreenshot timed out` (raw CDP) | The window is **minimized**; compositing is suspended | `Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } })` |

## Going deeper

- **`references/guide.md`**: the timing traps (`waitUntil` vs `assertEventually`, proving a negative), response bodies that expire, the interaction loop, workflows (replay in Burp, WebSocket protocols, bundles, live memory, pause and step), and how to write up findings.
- **`references/api.md`**: every controller method and CLI command, with signatures.
- **`references/devtools-protocol/`**: vendored protocol JSON. Grep `json/browser_protocol.json` and `json/js_protocol.json` when you need a CDP method that the library does not wrap.
