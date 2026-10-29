---
name: chrome-cdp
description: 'Drives a real Chrome over the DevTools Protocol to audit a live page: dumps forms and hidden inputs, captures raw HTTP and WebSocket frames for Burp, traces event listeners and postMessage handlers to source, searches and deobfuscates loaded JS bundles, and saves every resource a page loads. Use whenever the question is what a real site does at runtime rather than what its static HTML says: reverse engineering a signing or token algorithm, finding an undocumented API, replaying a request, auditing a login flow, inspecting a WebSocket protocol, unminifying a bundle, or debugging page behavior. Also drives canvas games and iframes: lists frames, clicks and holds keys by coordinates, reads canvases. Works one action per command: looks, acts once, reads the output, then decides. Use even when the user only says "look at this site", "how does this site do X", or "find the API behind this page", without naming Chrome, CDP, or DevTools.'
license: ISC
compatibility: Windows with Git Bash, Google Chrome installed, Node.js. Run npm install in this skill directory if node_modules is missing.
---

# Chrome CDP

Toolkit for inspecting a **live** page: real Chrome (visible, never headless), real JS, real network.

Every path below is relative to this skill's directory (the one holding `SKILL.md`, `cli.js`, `index.js`). Run commands from there.

## Start here

1. **Chrome must be running.** The CLI never launches it: `node cli.js start` (uses its own `AutomationProfile`, port 9222). Check with `node cli.js status`. Otherwise every command fails with the same hint.
2. **Put JavaScript in a file.** Write the expression to `.tmp/x.js` and run `node cli.js eval --file .tmp/x.js`. Never inline regexes or nested quotes in `node -e` or `rg` from PowerShell: they fail with ParserError or get mangled.
3. **Look before acting.** `node cli.js snapshot <url>` lists the page's elements _and_ each iframe under `frames[]` (url, canvases, elements). Pick selectors from it, never from memory. Run `node cli.js frames` before any `--frame` command.
4. **Act.** `click`, `type`, `fill`, `press` by selector. For canvas games with no selectors: `click-at <x> <y> --frame <part> --canvas` and `key <code> --hold <ms>`.
5. **Read state.** `eval [--frame <part>] <expr>`, `traffic`, `search-sources`, and the bundle commands below.
6. **Scratch per run.** Write each run's files to `.tmp/<task>/` and do not read or reuse another run's folder, so each run stays independent. `node cli.js clean` removes all of `.tmp/`. Never write into the repo.

## How to work: one step at a time

Work the way a person does: look, act once, read what changed, then decide.

**Hard rules (these caused the failed runs):**

- **One `node cli.js` command per tool call.** Never put two or more commands in one call with `;`, `&&`, `|`, or a newline. A chained call hangs as a unit, and when it stalls you cannot tell which command stalled or what it changed.
- **No `Start-Job`, no background jobs, no `Receive-Job -Wait`, no `Wait-Job`, no `Start-Sleep` to time a game.** Use the CLI's own waits (`wait`, `waitForFrame`, `traffic --wait N`) inside one command.
- **No `| Out-Null`, no `2>$null` to hide output.** Read the output and the exit code of every command.
- **Read the exit code and the output before the next command.** A non-zero exit stops the sequence. Do not retry the same command with a longer timeout or a sleep.
- **If a command hangs or you are stuck, run `node cli.js status` alone.** It shows the tab, the frames, and whether a pause is held. Then decide the next single step.

- **One action per command.** A single click, key, or navigation. Read its output before the next one.
- **Keep the action and its read separate.** Act in one call, read the state in the next. The game or page can change between calls, so the read must come after the action it checks.
- **Keep reads small and named.** One `eval --file` that answers one question. If a read needs more than about ten lines, the question is too big: split it.
- **Record each step.** Write the command and its output to `.tmp/<task>/` as you go. A later reader can then see which action caused which change.
- **Long waits are for capture only.** `traffic --wait N` or `mirror start` may run while you act. Act with separate commands, not inside the same one. `break --trigger` and `traffic --wait` act and wait in one command: read their output before the next step.
- **A non-zero exit means stop.** Read the error and its hint. If a command hangs, run `node cli.js status` (it shows the tab, frames, and any pause). Do not retry with a longer timeout.
- **Actions report what they did.** `click-at` and `key` print `{ok: true, ...}`. `click` and `type` refuse a disabled or covered element with an error rather than doing nothing. `changed` is true when an interactive element appeared, disappeared, or changed its text or value (a typed value counts), or the URL changed. `changed: false` does not prove nothing changed: canvas drawing and updates outside the interactive elements are not in the diff.

## Which command for what

| Need                                                                    | Command                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is Chrome up, is a recording running                                    | `status`                                                                                                                                                                                                                                                                                                                                           |
| What is on the page (and in each iframe)                                | `snapshot [url]`                                                                                                                                                                                                                                                                                                                                   |
| Which iframes exist and which have canvases                             | `frames` (index, canvas count and size, element count, url)                                                                                                                                                                                                                                                                                        |
| Which tabs are open                                                     | `tabs`; every command accepts `--tab N`                                                                                                                                                                                                                                                                                                            |
| Click, type, fill, press a DOM element                                  | `click`, `type`, `fill`, `press`                                                                                                                                                                                                                                                                                                                   |
| Click a canvas game                                                     | `click-at <x> <y> --frame <part> [--canvas]`                                                                                                                                                                                                                                                                                                       |
| Hold a key in a canvas game                                             | `key <code> [--hold MS]` (keys go to the focused element)                                                                                                                                                                                                                                                                                          |
| Read a canvas                                                           | `canvas --frame <part> [--index N] [--out f.png] [--preserve]`                                                                                                                                                                                                                                                                                     |
| Run JavaScript in the page or an iframe                                 | `eval [url] [--frame <part>] <expr>` or `eval --file script.js`                                                                                                                                                                                                                                                                                    |
| Record HTTP and WebSocket traffic                                       | `traffic [url] [--bodies] [--wait S] [--headers] [--json]`                                                                                                                                                                                                                                                                                         |
| Console messages and uncaught exceptions                                | `console [url] [--level error] [--limit N] [--wait S]`                                                                                                                                                                                                                                                                                             |
| Raw HTTP request/response for Burp Repeater                             | `raw [url] <id|url-part> [--response]`                                                                                                                                                                                                                                                                                                            |
| Find a string inside recorded response bodies                           | `search-bodies [url] <text|/regex/>`                                                                                                                                                                                                                                                                                                              |
| WebSocket frames, including binary                                      | `ws-frames [url] [--direction sent|received] [--query text] [--hex] [--limit N]`                                                                                                                                                                                                                                                                  |
| What the page put on `window` (engine, state, tokens)                   | `globals [--frame <part>] [--filter text]`                                                                                                                                                                                                                                                                                                        |
| Live instances of a class                                              | `objects <SomeClass.prototype>`                                                                                                                                                                                                                                                                                                                   |
| Why a command fails (Chrome, tab, page, debugger, mirror)              | `doctor`
| Step through a function you stopped in (or the running page)            | `step <query> <line> --trigger "<js>" --times 5 --eval expr`, `step --pause --times 3` |
| Who talks to whom over `postMessage`                                    | `postmessage <url> --wait 5` |
| Re-send a request, find one by body/header                              | `replay <id\|url-part>`, `search-traffic <text\|/re/>` |
| Search a game's binary WebSocket frames                                 | `ws-search <text> --direction sent` (decodes msgpack/protobuf before matching) |
| Dump an object that breaks `JSON.stringify`                             | `inspect <expression>` |
| Workers, or wipe the profile cache/cookies                              | `workers`, `purge --cache --cookies` |
| Machine-readable health check                                           | `status --json` |                                                                                                                                                                                                                                                                                                                                          |
| Find and reverse a script bundle                                        | `search-sources`, `download-bundle`, `deobfuscate`, `unpack`, `ast-search`                                                                                                                                                                                                                                                                         |
| Find code the page created at runtime (eval, Function)                  | `vm-scripts` lists them; `find-function <id> <name>` finds where a function is defined                                                                                                                                                                                                                                                             |
| Find what makes the page slow to render                                 | `layout [url] [--wait S]`: style, layout, pre-paint and paint with the script that forced each one                                                                                                                                                                                                                                                 |
| Map which handlers respond to events, and what runs                     | `events [url]` lists listeners by type and handler location; `profile [url] [--wait S]` shows the functions that ran and their callers                                                                                                                                                                                                             |
| Reverse a payload the page builds at runtime                            | `catch-script <url> --min-bytes N [--break-line N] [--eval <expr>]`: pauses before that script runs, shows the stack and the call site that built it, then breaks inside it and reads variables; `break <scriptId> <line>` for a later stop; `find-function <id> <name>` and `snippet <id> <line> --col N` to read a position in a minified script |
| Pause at a line                                                         | `break [url] <query> <line> --trigger "<js>"`                                                                                                                                                                                                                                                                                                      |
| Release a page paused by another command                                | `resume`                                                                                                                                                                                                                                                                                                                                           |
| Forms, storage, event listeners                                         | `dump-forms`, `dump-storage`, `listeners`                                                                                                                                                                                                                                                                                                          |
| Record every request, response, cookie and lazy load while you interact | `mirror start <url>`, then `mirror stop`                                                                                                                                                                                                                                                                                                           |
| Unpack a mirror run's JS with webcrack                | `index-site <stampDir>`                                                                                                                                                                                                                                                                                                                            |

`<part>` is a substring of the frame URL, or the frame index from `frames`. `node cli.js --help` is the full list.

## Rules that prevent wasted runs

- **Snapshot, don't screenshot.** The CLI has no screenshot command. Text drawn on a canvas is invisible to `snapshot`: read the app's state with `eval --frame`, or the pixels with `canvas --out` only when the state cannot answer the question.
- **Recording starts at connect.** `traffic <url>` captures the load; anything before the attach is invisible. A live tab is read with `traffic --wait S` (no URL).
- **Keys go to the focused element.** Click the game first, or `key` does nothing visible. `key` refuses `--frame`. Click an empty spot in the game (not a button) to focus it without triggering anything.
- **Movement may use the right mouse button.** Check the game's input handlers, then send it with `click-at <x> <y> --frame <part> --canvas --button right`. A left click on an empty spot does not move the player in such games.
- **A covered or minimized Chrome window** does not block synthetic keys: `ensureVisible` turns on `Emulation.setFocusEmulationEnabled` instead of raising the window. Only if that fails does it minimize and restore the window, which is the one case where a game may lose focus.
- **Never discard output with `Out-Null` or `Select-Object -Last 1`.** A run that prints nothing can still have failed. Check the exit code and the summary line.
- **Git Bash rewrites a leading `/`** into `C:/Program Files/Git/`. Frame arguments strip that prefix, but a frame index (`--frame 1`) or `--frame game.html` is safer than `--frame /game`.

## Canvas games and iframes

Game loop, measured on `https://deadshot.io/` (game canvas inside an iframe):

```bash
node cli.js frames                                           # find the game frame (index, canvases, sizes, url)
node cli.js canvas --list                                    # every canvas: index, bitmap/CSS size, visible
node cli.js snapshot https://target.com/game                 # canvas size and any elements per frame
node cli.js click-at 160 80 --frame game.html --canvas       # x/y in canvas pixels; bitmap->CSS scale is applied
node cli.js key KeyW --hold 300                              # hold a key (click the game first to focus it)
node cli.js key KeyW+ShiftLeft --hold 200                    # chords: modifiers + one key, pressed in order
node cli.js drag 100 100 400 300 --frame game.html --canvas  # press, move in steps, release
node cli.js wheel 0 -400 --frame game.html                   # scroll / zoom at the last pointer position
node cli.js canvas --screen --out .tmp/game.png              # compositor capture: WebGL pixels, no reload
node cli.js canvas --record 10 --fps 5 --out .tmp/frames     # 10 s at 5 fps = 50 frames
node cli.js eval --frame game.html "JSON.stringify(window.someState)"
```

- **`canvas --list` first.** A page has ad and UI canvases too (deadshot.io has nine); `--list` names the bitmap size, CSS size and visibility of each, and the biggest visible one is chosen when you omit `--index`. Indexes are page order, so they change between loads: prefer `--list` over a remembered index.
- **`canvas --screen` for WebGL.** `Page.captureScreenshot` with the canvas rectangle reads the composited frame, so it works without `preserveDrawingBuffer` and without reloading the game. Plain `canvas --out` (2D readback) is the fast path; `canvas --out --preserve` is the fallback that reloads the tab.
- **`click-at --canvas` converts bitmap to CSS pixels.** It multiplies by `rect.width / canvas.width` (same for height) and returns the `scale` it used. A 2× backing store therefore needs coordinates in backing-store pixels, as drawn in the image, not CSS pixels.
- **Canvas size settles after load.** `canvas --frame` waits for the frame and for the canvas size to hold across two samples. Its output names the frame it read. The main page has no canvas unless you read it on purpose.
- **Click the visible center of a button.** A hit area can start at the drawn corner, and an edge click may not register. Find the button with a canvas read or the game's own state, then click its center.
- **Game state can be better than pixels.** Some engines keep state in globals or in functions on `window` that `eval --frame` can read. Find them with one recipe in `references/guide.md` ("Find state in a canvas game"). Do not assume names from another game. A bare identifier that is not defined throws `is not defined`, so check `typeof` first.
- **A game's own socket speaks binary.** `ws-frames --hex` turns a binary frame into hex; a protobuf or msgpack payload stays opaque until decoded, so dump it with `--out` and decode it offline.

## Setup

Run `npm install` in the skill directory if `node_modules/` is missing. The failure is a bare `Cannot find module 'puppeteer-extra'`.

```bash
node cli.js start        # or: npm start
```

The library's `connect()` launches Chrome if none is running; the CLI does not, on purpose.

### When it does not work

| Symptom                                        | Cause                                                                                                                     | Fix                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Chrome is not running on port N`              | No Chrome on that port                                                                                                    | `node cli.js start`, or pass `--port`                                                                                                            |
| `Chrome executable not found`                  | Chrome is not in a standard install path                                                                                  | Set `CHROME_PATH` to the chrome.exe path                                                                                                         |
| Connects but logged out everywhere             | Chrome runs a **separate** `AutomationProfile`, by design                                                                 | Log in once inside the automation browser (it persists), or point `CHROME_USER_DATA_DIR` at another profile with your normal Chrome fully closed |
| `ECONNREFUSED 127.0.0.1:9222`                  | Chrome died, or another process owns the port                                                                             | `node cli.js start`, or `--port`                                                                                                                 |
| `Tab N does not exist`                         | Fewer tabs than the index                                                                                                 | `node cli.js tabs`, then `--tab` with a listed index                                                                                             |
| `Waited 30s for a frame whose URL contains …`  | The frame never appeared, or the part does not match                                                                      | Read the "Frames seen" list; use a listed substring. A numeric index does not wait, so load the page first                                       |
| `No frame at index N`                          | Index past the frame list                                                                                                 | `node cli.js frames`                                                                                                                             |
| WebGL canvas reads blank                       | Drawing buffer not preserved                                                                                              | `canvas --preserve` (reloads the tab)                                                                                                            |
| Page opens `chrome://newtab` and reads empty   | `connect()` reuses tab 0 and resets `chrome://` to `about:blank`                                                          | Expected: `goto()` your target                                                                                                                   |
| `eval` hangs about 10 s, then `ProtocolError`  | Synchronous `XMLHttpRequest` (or another blocking call) in the page. Chrome blocks the page's JS thread, so CDP times out | Use `await fetch(...)` in an async expression; do not raise the timeout to hide it                                                               |
| Hangs about 30 s, then `ProtocolError` (other) | A CDP call exceeded the protocol timeout                                                                                  | `connect({ protocolTimeout: 120000 })` for heavy work                                                                                            |
| `Page.captureScreenshot timed out` (raw CDP)   | The window is **minimized**; compositing is suspended                                                                     | `Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } })`                                                                       |

## Reading a reply

- **A reply over 60 KB goes to a file.** `emit` writes it to `.tmp/results/result-<time>.json` and prints `{savedTo, bytes, keys, note}` instead of the payload, so one capture cannot flood the context. Pass `--out <file>` to choose the path, or read the saved file.
- **Credentials are redacted in stdout.** `traffic`, `raw` and `console` mask `Cookie`, `Authorization`, `Set-Cookie` and API-key headers (`[REDACTED]`). `--out` writes the real values, and `--no-redact` keeps them on stdout when you need to see them.
- **`raw` is made for Burp.** `raw <id|url-part>` prints the request with its original header order and casing (`:authority`, `sec-ch-ua`), and `--response` prints the response the same way.
- **Flags accept both spellings.** `--wait 5` and `--wait=5` parse the same. `--version` prints the version; `--help` prints every command.
- **A JSON flag is a projection, not the raw object.** `traffic --json` keeps id, URL, method, status, type, MIME, protocol, timing, size, request headers and post body, dropping raw header maps, initiator and cookie bookkeeping (3.3 MB → 218 KB on deadshot.io). `--full` restores everything.

## Gotchas

- **JSON.stringify on game objects fails** with "circular structure". Select fields in the expression instead, e.g. `JSON.stringify({x: o.x, y: o.y})`. `inspectObject` exists in the library only.
- **Commands that take one script (`download-bundle`, `deobfuscate`, `ast-search`) refuse an ambiguous query** and list the matching scriptIds. Pass the scriptId.
- **`eval` reports a paused page after 3 seconds** and names the process holding the pause. `node cli.js resume` releases it.
- **A tab blocked by a busy loop stays blocked.** `resume` only releases a debugger pause; it cannot interrupt a synchronous call, and no page handle exists for that tab, so `close` and `goto` cannot run on it either. Every command on that tab fails in about 5 s with `Tab N (url) is not answering: … Close that tab in Chrome or restart Chrome`. Other tabs keep working (`--tab`).
- **Read installed code, not guesses: beautify first.** A minified or string-tabled script tells you nothing by search: real names are not text until the file is deobfuscated. One `npx --no-install webcrack <file> -o <dir> -f` (or `deobfuscate` / `unpack` for a live scriptId) turns it into something `rg`, `ast-grep` and `srcwalk` can read. Search the clean copy, then map a position back to the live script with `find-function` + `snippet` before you arm a breakpoint, which needs the script's own coordinates. `references/workflows.md` has the recipes, including a bundle whose strings resolve at runtime.
- **Re-check a claim before writing it up.** A command that printed nothing is not proof of a negative: read the exit code and the output again.

More command details (mirror, wait, break, traffic JSON, storage, tests) are in `references/guide.md` under "Command details".

## Going deeper

- **`references/guide.md`**: the timing traps (`waitUntil` vs `assertEventually`, proving a negative), response bodies that expire, the interaction loop, the render pipeline, and how to write up findings.
- **`references/workflows.md`**: the recipes for anything longer than one command — replay a request, WebSocket protocol, bundles, mirror a site, pause and step, reverse-engineering a payload built at runtime. Read it _before_ starting that kind of work, not after a command fails.
- **`references/api.md`**: every controller method and CLI command, with signatures and the units of the numbers they return.
