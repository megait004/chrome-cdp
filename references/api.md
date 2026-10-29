# chrome-cdp API reference

Complete surface of `connect()` and its controllers. `SKILL.md` covers the common workflows; this file is the lookup table for everything else.

- [Getting a client](#getting-a-client)
- [client — page level](#client--page-level)
- [client.dom](#clientdom--domcontroller)
- [client.network](#clientnetwork--networkcontroller)
- [client.websocket](#clientwebsocket--websocketcontroller)
- [client.console](#clientconsole--consolecontroller)
- [client.sources](#clientsources--sourcecontroller)
- [client.debug](#clientdebug--debugcontroller)
- [client.workers](#clientworkers--workercontroller)
- [client.performance](#clientperformance--performancecontroller)
- [client.visual](#clientvisual--visualcontroller)
- [Shared conventions](#shared-conventions)
- [CLI commands](#cli-commands)

---

## Getting a client

```javascript
const { connect, waitForEvent, waitUntil, assertEventually, startChrome, findChromePath, checkCdpReady, webcrack, astGrep } = require('../index');
```

`connect(options)` → `Promise<ChromeClient>`

| Option | Default | Notes |
| --- | --- | --- |
| `port` | `9222` | CDP port |
| `autoLaunch` | `true` | Launches Chrome if the port is not already answering |
| `browserURL` | `http://127.0.0.1:<port>` | Explicit HTTP endpoint |
| `browserWSEndpoint` | — | Attach by WebSocket URL instead of port |
| `autoEnableAll` | `true` | Starts network + websocket + console + sources recording on connect. Set `false` only if you want to enable them selectively |
| `tab` | `0` | Index into `browser.pages()`: which tab to attach to. Out-of-range throws and points at `node cli.js tabs` |
| `protocolTimeout` | `30000` | Per-CDP-call timeout in ms. Raise it for `unpackBundle` / `deobfuscateBundle` on large bundles |

`connect()` opens the browser connection first and then starts the controllers. A failure after that point disconnects
before rethrowing, so nothing is left open. Two caveats for scripts of your own:

- A failure *inside* `puppeteer.connect()` itself (a `Target.getBrowserContexts` or `Network.enable` timeout on a busy
  page) can leave its socket open with no handle to close: the error prints and then the process can sit idle
  instead of exiting. The CLI exits explicitly with its status in that case; a `.tmp/` script that must end should
  say so itself (`process.exitCode` plus an explicit exit after the error is printed).
- `disconnect()` leaves Chrome running — only the script's breakpoints and recordings go with the session, which is
  why a breakpoint armed in one command cannot be hit by the next.

### Waiting

Three primitives share one bounded-wait engine. The names keep synchronization and claims apart: a wait that gave up must not be reported as an observed absence.

| Function | Purpose | On timeout |
| --- | --- | --- |
| `waitForEvent(emitter, eventName, options)` | **Listening.** Subscribe to `client.websocket` / `client.network` / `client.console` and return on the event itself | Resolves with the payloads collected so far |
| `waitUntil(fn, options)` | **Sampling, synchronization.** Poll for state with no event behind it | Returns the last value observed |
| `assertEventually(fn, options)` | **Sampling, claim.** The next thing you write depends on this being true | Throws with a diagnostic naming the condition and the last value |

Prefer `waitForEvent` when an event exists — it neither lags a poll interval behind nor misses a value that appeared and was replaced between two samples. Emitted events: `frame`, `frameSent`, `frameReceived`, `socketCreated`, `handshakeRequest`, `handshakeResponse`, `socketError`, `socketClosed` (websocket); `request`, `response`, `finished`, `failed` (network); `message`, `exception` (console).

| Option | Default | Applies to | Notes |
| --- | --- | --- | --- |
| `timeout` | `20000` | all | Every wait is bounded; there is no unbounded form on purpose |
| `every` | `300` | the sampling pair | Poll interval |
| `min` | `1` | the sampling pair | For array/string results, how many items count as ready. `{ min: 10 }` = "wait for enough frames to see the pattern" |
| `describe` | — | `assertEventually` | Names the condition in the thrown message |
| `count` | `1` | `waitForEvent` | How many payloads to collect |
| `where` | — | `waitForEvent` | Predicate to filter payloads, e.g. `(f) => f.direction === 'received'` |

Ready means truthy, and for anything with a `.length` at least `min` items.

**Proving a negative** needs a marker, not a long sleep. Wait for something the page reliably does that completes *after* the event you are checking for would have occurred, then report the absence together with the window it holds over: "no control frame across 630 frames / 76s", never "the server sends no PING". A predicate that cannot become true (`frames.length >= 100000` on a page that produces 700) is a fixed sleep in disguise and is worse than an honest one, because the next reader believes a condition was checked.

Also exported: `startChrome({ port })`, `findChromePath()`, `checkCdpReady(port)` (resolves the `/json/version` payload or `null`), plus the raw `webcrack` and `astGrep` modules if you want to run them on code you obtained some other way.

---

## client — page level

| Method | Returns | Notes |
| --- | --- | --- |
| `newPage({ autoEnableAll })` | `ChromeClient` | New tab with its own CDP session and controllers; shares the worker tracker |
| `goto(url, options)` | navigation response or `null` | Defaults `waitUntil: 'domcontentloaded'`, `timeout: 15000`. Returns `null` instead of throwing when it times out but the DOM already parsed |
| `setViewport({ width, height, deviceScaleFactor, isMobile })` | — | Only when you need a specific viewport; an unconditional override puts the tab under Emulation, which can stop background frame production |
| `title()` / `content()` / `url()` | `string` | Rendered title / full HTML / current URL (sync). `url()` is the truth after redirects — not the URL you passed to `goto()` |
| `evaluate(expressionOrFn, ...args)` | value | Runs in page context |
| `closePage()` | — | Closes this tab |
| `disconnect()` | — | Detaches, leaves Chrome running |
| `closeBrowser()` | — | Kills Chrome entirely |

Pair `closePage()` + `disconnect()` in a `finally`.

**Escape hatch: `client.page`** — the underlying Puppeteer `Page` for anything no controller covers (route interception, `page.waitForSelector`, `page.setCookie`, …). Prefer a controller method when one exists; `client.page.url()` and `client.page.goto()` work but bypass the recording guarantees of `goto()`. Also exposed: `client.browser`, `client.cdpSession` (raw CDP `send()`).

---

## client.dom — DOMController

**Interaction** (needed for anything behind a login or a click):

| Method | Notes |
| --- | --- |
| `interactiveSnapshot(selector?)` | Compact list of the interactive elements (buttons, links, inputs, `role=button`, …) **currently visible** — tag, id, name, type, role, text, href, placeholder, value, ariaLabel, checked, selected, expanded, disabled, `inViewport` — plus `{ url, readyState, count, truncated }`. `role` is the explicit role or the implicit one; `ariaLabel` is `aria-label` or the resolved `aria-labelledby`; `disabled` also covers `aria-disabled="true"`. Visibility uses `Element.checkVisibility` (ancestors, opacity, `content-visibility`) plus a non-zero box, and the scan descends into open shadow roots. `count` is every visible interactive element, `elements` stops at 150 and `truncated: true` says the list was cut. The agent's eyes: read it before acting and after every action, and pick selectors from it, never from memory |
| `click(selector, options)` | Scrolls into view and clicks (DOM-level, works in background windows) |
| `clickByText(text)` | Human-style: matches an interactive element by visible text (exact beats substring, case-insensitive); returns what was clicked, `null` if nothing matched |
| `type(selector, text, options)` | Keystroke-by-keystroke; fires the events a real user would. Revives an occluded window first (`visibilityState: 'hidden'` makes Chromium drop synthesized keys entirely — a minimize→normal dance is the only revival; `bringToFront` does nothing). Self-verifying: if the keys still did not land, it falls back to `Input.insertText` (delivered even occluded; replaces the field, fires `input` only — no keydown/keyup) |
| `press(key)` | Keyboard key on the focused element (`Enter`, `Tab`, `Escape`, …) |
| `fill(selector, value)` | Sets the value through the native setter (frameworks like React ignore plain assignment — their value tracker dedupes it) and fires `input`/`change`. Faster than `type`. If the app still ignores the new value, switch to `type()` — per-key events cannot be deduped |
| `getValue(selector)` / `getText(selector)` | |
| `getAttribute(selector, attribute)` | |
| `getOuterHtml(selector)` / `getHtml()` | |
| `inspectElement(selector)` | Tag, attributes, computed box, position |
| `$(selector)` / `$$(selector)` | Raw puppeteer `ElementHandle` / handle array, for the cases the helpers above do not cover |

**Audit:**

| Method | Returns |
| --- | --- |
| `getEventListeners(target = 'window')` | Listeners via CDP `DOMDebugger`, each with `type`, `scriptId`, `lineNumber`, `columnNumber`, `useCapture`. `target` is a selector or the literal `'window'` |
| `dumpForms()` | Every form: action, method, and all inputs including hidden ones |
| `dumpHiddenInputs()` | `type=hidden` **and** CSS-hidden elements |
| `dumpStorage()` | `{ localStorage, sessionStorage }` |
| `hookPostMessage()` | Installs a `postMessage` + message-listener recorder. **Must be called before `goto()`** — it uses `evaluateOnNewDocument` and only affects subsequent loads |
| `getPostMessageLogs()` | `{ direction, origin/targetOrigin, data, timestamp }[]` |

---

## client.network — NetworkController

| Method | Notes |
| --- | --- |
| `startRecording()` / `stopRecording()` / `clear()` | Recording is already on after `connect()` unless `autoEnableAll: false` |
| `getTraffic(filter)` | Filter: `url` (string/RegExp), `method`, `resourceType`, `status`, `failedOnly` |
| `getRequestPostData(query)` | Raw request body |
| `getResponseBody(query)` | `{ body, base64Encoded, parsedJson? }`. Bodies are stored durably (`Network.configureDurableMessages`, enabled by `startRecording()`) so they survive cross-process navigations — bounded by a 100 MB total / 5 MB per-resource buffer, and silently unavailable on older Chrome builds that reject the call. Still drain fresh when it matters |
| `toRawRequest(query)` | RFC 7230 text with unnormalized headers, including `:method` / `:path` / `:authority`. Paste straight into Burp Repeater |
| `toRawResponse(query)` | Same, for the response |
| `searchTraffic(query)` | Scans URL + headers + request postData across every recorded request |
| `searchBodies(query, { requestId })` | Searches response bodies. Hybrid: native `Network.searchInResponseBody` first; entries Chrome can't search natively (durable-stored, evicted) fall back to a local match over `getResponseBody`. Accepts a substring, or `/pattern/flags` / a RegExp |
| `getCookies(urls)` | Cookies for the given URLs; omit for the current page |
| `replayXHR(requestId)` | Resends the XHR identical to the original (method, url, body, headers); the replay is recorded like any other request. **Only XHR requests can be replayed**: Chrome rejects `fetch()` requests with "Given id does not correspond to XHR" |
| `clearCache()` / `clearCookies()` | Useful to force a cold load |

`query` for the per-request methods is a `requestId` string, a URL substring, a RegExp, or `{ url }` / `{ requestId }`.

**Redirects.** Chrome reuses one `requestId` for a whole redirect chain, so each hop is recorded separately under the id `<requestId>:redirect:<n>` and the final hop keeps the bare `requestId`. This matters for login and OAuth flows: the request worth auditing is usually the one that redirected away, and it would otherwise be overwritten by its own destination. Each hop carries `redirectedFrom` / `redirectedTo` and the status that caused it, so `getTraffic({ method: 'POST' })` still finds the POST with its body and its `Set-Cookie` intact. `getResponseBody` throws on a redirect hop rather than answering: Chrome keeps no body for a redirect, and the underlying call would hand back the *final* hop's body under the earlier hop's id.

---

## client.websocket — WebSocketController

| Method | Notes |
| --- | --- |
| `startRecording()` / `stopRecording()` / `clear()` | |
| `getSockets(filter)` | Filter: `url`, `state` (`connecting` \| `open` \| `closed` \| `error`). Each socket carries handshake headers and its `frames` array. **Limitation:** when a navigation tears a socket down, no `webSocketClosed` arrives, so the record stays `open` with no `endTime` |
| `getFrames(socketIdOrUrl, filter)` | Omit the first argument for all sockets. Filter: `direction` (`sent` \| `received`), `opcode`, `query`, `jsonOnly` (only frames that parsed as JSON — `frame.parsedJson` holds the object) |
| `searchFrames(query, { direction })` | `{ socketId, url, frame }[]` across every connection |

Frames only exist after the handshake, and many only appear in response to interaction. See the timing section in `SKILL.md`.

---

## client.console — ConsoleController

| Method | Notes |
| --- | --- |
| `startRecording()` / `stopRecording()` / `clear()` | |
| `getLogs(filter)` | Filter: `type` (`log`, `error`, `warning`, …), `query`, `hasStackTrace`. Entries carry the full call stack with file, line, and column. An object argument is rendered from its CDP preview (`Object {a: 1}`), so `console.log(obj)` is readable text |
| `evaluate(expressionOrFn, ...args)` | Via CDP `Runtime.evaluate`, returns the unwrapped value |
| `inspectObject(objectIdOrExpression, { ownProperties })` | Deep property dump that survives objects `JSON.stringify` chokes on (cycles, DOM nodes, functions) |
| `queryObjects(prototypeExpression)` | Every live instance of a class in the V8 heap, e.g. `'UserSession.prototype'`. The class must be reachable from the page's global scope |

---

## client.sources — SourceController

| Method | Notes |
| --- | --- |
| `enable()` / `disable()` / `clear()` | |
| `getScripts(filter)` | Filter: `url` (string/RegExp), `excludeInternal` (drops `pptr:` and `chrome-extension:`). Entries: `scriptId`, `url`, line/column range, `hash`, `sourceMapURL` |
| `getScriptSource(scriptIdOrUrl)` | `{ source, ... }` |
| `searchInSources(query, options)` | Chrome's own Ctrl+Shift+F index — fast across huge bundles. Options: `scriptId`, `caseSensitive`, `isRegex`, `excludeInternal`. Returns `{ scriptId, url, matches: [{ lineNumber, lineContent }] }[]`. Pass a RegExp directly and `isRegex` is inferred |
| `downloadBundle(scriptIdOrUrl, outputPath)` | `{ filePath, bytesWritten }` |
| `deobfuscateBundle(scriptIdOrUrl, options)` | webcrack: unminify, undo obfuscator.io string arrays, restore control flow. Returns `{ code }` |
| `unpackBundle(scriptIdOrUrl, outputDirectory, options)` | Splits webpack/browserify into one file per module. Returns `{ moduleCount, outputDirectory }` |
| `searchAst(scriptIdOrUrl, pattern, { deobfuscateFirst })` | ast-grep structural match. Returns `{ text, range, metaMatches }[]` where `metaMatches` maps each `$VAR` in the pattern to the matched source text. `deobfuscateFirst: true` runs webcrack before parsing — usually necessary on minified code, since the AST shape you are matching often only exists after unminification |

`scriptId` values are invalidated on navigation — the script table is cleared when the execution context resets. Re-run `searchInSources` after a `goto()` rather than reusing an old id.

---

## client.debug — DebugController

| Method | Notes |
| --- | --- |
| `enable({ pauseOnExceptions, asyncStackDepth })` | `pauseOnExceptions`: `true` (= `'all'`) or spec enum `'caught'` \| `'uncaught'` \| `'all'` — Debugger.setPauseOnExceptions state, validated. Armed state is re-sent on `Runtime.executionContextsCleared` because a reload wipes it on some stacks — arm *after* `goto()` when the pause must apply to the fresh load |
| `setBreakpoint(url, lineNumber, columnNumber = 0, condition)` | `condition` is a JS expression — the breakpoint only fires when it is truthy. Raw protocol semantics: `lineNumber` counts from the top of the *document*, so for an inline `<script>` starting at document line N add N (the script's `startLine` from `getScripts()`). The CLI `break` command does this offset for you — pass script-relative lines there |
| `setBreakpointAtLocation(scriptId, lineNumber, columnNumber = 0, condition)` | Breakpoint inside one script, addressed by scriptId. **The only way to break in a script with no URL** — the code a page builds with `eval` or `Function`, which `setBreakpointByUrl` can never name. Lines are 0-based within that script's own source. Resolves to an `actualLocation` that may differ from the requested column (V8 moves it to the next statement) |
| `setInstrumentationBreakpoint(instrumentation = 'beforeScriptExecution')` | Pauses before a script runs. V8 attaches it per script as the script is parsed (`V8DebuggerAgentImpl::setScriptInstrumentationBreakpointIfNeeded`), so it also covers code created later — arm it *before* that code exists. The pause has `reason: 'instrumentation'`, `data.scriptId` and `data.url` of the script about to run (both empty-URL payloads and `wasm://` scripts can appear), and a stack whose frame 0 is that script while frame 1 is the code that created it. **At this pause the renderer's JS thread does not answer** `evaluateOnCallFrame`, `Runtime.getProperties` or `Runtime.evaluate` (they time out), while `getScriptSource` and the frame list work. To read values, follow it with a breakpoint inside the script (see `catch-script`) |
| `getScopeValues(callFrame, { limit, includeGlobals })` | Named values of a paused frame's scopes as text: a string value reports its length (`chars`) instead of only its first characters, objects report their description. Reads `local`, `closure`, `block`, `catch`, `eval` scopes; skips `global` and `with` unless `includeGlobals`. Works at a breakpoint pause; times out at an instrumentation pause |
| `removeBreakpoint(breakpointId)` | Untracks the id on success (a throw keeps it tracked so `disable()` retries the removal) |
| `pause()` / `resume()` / `stepOver()` / `stepInto()` / `stepOut()` | Raw passthrough — `resume()` on a non-paused target is a protocol error, so guard it |
| `evaluateOnCallFrame(callFrameId, expression, options)` | Reads locals and closure variables at the paused frame — the way to capture a value that exists for one tick. Options (spec passthrough): `silent` (eval faults don't report / re-pause — overrides pause-on-exceptions), `includeCommandLineAPI` (`$0`, `$_` helpers), `objectGroup` |
| `disable()` | Detaches listeners, removes every tracked breakpoint, resets pause-on-exceptions to `none` — leaves the target as found |

Emits `paused` with `{ callFrames, reason }`, and `client.debug.paused` holds that same payload (or `null`) if you would rather poll than subscribe. The page is frozen until `resume()`, so always resume — including on the error path.

Protocol reference (installed with the `devtools-protocol` dependency by `npm install`): `node_modules/devtools-protocol/json/js_protocol.json`, domain `Debugger` — full parameter shapes for `setBreakpointByUrl`, `evaluateOnCallFrame`, `setPauseOnExceptions`, stepping, etc. Prefer the CLI `break` command over raw calls: one shot sets the breakpoint, waits for the hit, captures the stack, evaluates on the top frame (`--eval`), and resumes. Multi-step flows (stepOver/stepInto in a loop, conditional re-pausing) cannot span CLI invocations — pause state dies with the CDP session — so write a `.tmp/` script against `client.debug` for those.

---

## client.workers — WorkerController

| Method | Notes |
| --- | --- |
| `list()` | `{ id, type, url }[]` for dedicated, shared, and service workers |
| `info(item)` | |
| `evaluate(id, expression, options)` | Runs inside the worker's own scope, e.g. `'self.location.href'` |
| `close()` | Stops tracking |

Worth checking when a site's crypto or network code is not in the main bundle — service workers frequently hold the interesting request rewriting.

---

## client.performance — PerformanceController

| Method | Notes |
| --- | --- |
| `metrics()` | CDP `Performance.getMetrics` snapshot |
| `startTrace(options)` / `stopTrace()` | Returns Chrome trace JSON — load it in `chrome://tracing` or the DevTools Performance panel to find long tasks, layout thrash, and CPU-heavy frames |
| `measure(fn, ...args)` | Runs `fn` in the page and returns its result alongside timing |

---

## client.visual — VisualController

For canvas games and iframes. Games draw on `<canvas>` inside an iframe, so the DOM controller has no selectors to click. Use `snapshot` first: it lists each frame's URL, canvases (index, size) and interactive elements.

| Method | Notes |
| --- | --- |
| `frames()` | Child frames of the page (main frame excluded) |
| `frame(spec)` | First child frame. `spec` is an index into `frames()`, a URL substring (a Git Bash `C:/Program Files/Git/` prefix is stripped), or a RegExp. Throws with the first frame URLs when none match |
| `preserveWebGL()` | Installs a hook so WebGL canvases keep their drawing buffer. Applies to documents created after the call: reload the page. The CLI `canvas --preserve` does both |
| `click(x, y, { frame, button, clickCount, settle })` | Real mouse events via `Input.dispatchMouseEvent`. With `frame`, `x`/`y` are relative to the iframe's top-left. Network-idle settlement is off by default (it can add 3 s per click); `settle: true` opts in |
| `drag(from, to, { frame, button, steps, stepMs })` | `from`/`to` are `{x, y}`; press, `steps` moves, release. The intermediate moves matter: a single jump to the end is often ignored as a teleport. The 50–60 ms gaps exist because a game polls input once per animation frame |
| `wheel(dx, dy, { frame, x, y })` | Wheel at `x`/`y`, defaulting to the middle of the frame, which is where a game listens |
| `key(codes, { holdMs })` | `keyDown`, wait `holdMs`, `keyUp` for a KeyboardEvent `code` (`KeyW`, `Space`, `ArrowLeft`, `Digit1`, …). `codes` is one code or an array (a chord: all keys go down before any comes up, so `['KeyW', 'ShiftLeft']` is W+Shift). Goes to the focused element — click the game first |
| `canvas({ frame, index })` | `{ width, height, dataUrl }` of the nth canvas in the frame. Fails with the browser's error when tainted. WebGL canvases read blank unless the app sets `preserveDrawingBuffer`; use `canvasScreenshot` instead |
| `listCanvases({ frame })` | Every canvas with bitmap size, CSS size and visibility, for choosing between the game canvas and ad/UI canvases |
| `canvasScreenshot({ frame, index })` | Compositor capture (`Page.captureScreenshot` clipped to the canvas rectangle): correct WebGL pixels with no reload and no `preserveDrawingBuffer` |

**Limit:** text drawn on a canvas is invisible to `snapshot`. To learn what a game shows you need its app state (an `eval` into the frame) or the pixels (`canvas --out`).

## Shared conventions

- **String vs RegExp.** Anywhere a filter takes `query` or `url`, a string means substring match and a RegExp means `.test()`. There is no glob syntax.
- **Recording is cumulative.** `getTraffic()` and friends return everything since `connect()` or the last `clear()`, across navigations. Call `clear()` before the action you want to isolate.
- **Tab lifetime.** `disconnect()` detaches without closing the tab — deliberate, so the user keeps interacting with it. `closePage()` is the explicit close (falls back to `about:blank` on the last tab so Chrome stays up). Each process that connects owns fresh recorder memory; only what happens after its `connect()` is in it.
- **`getResponseBody` is the exception to the above** — bodies live in Chrome's storage, not in this library's memory. `configureDurableMessages` makes them survive navigations (bounded buffers, Chrome 154+); what arrived before `connect()` was never recorded at all.
- **Everything is read-only against the target.** The controllers observe and extract; they do not modify requests in flight.

---

## CLI commands

`node cli.js --help` prints the authoritative list. Each command attaches to the live tab and **leaves it open** — page state (logins, SPA routes, WebSocket sessions) survives between commands, and you or the user close tabs by hand (`close`, or the X button). A command navigates only when given a URL; omit it and the command reads the page as it currently is.

| Command | Notes |
| --- | --- |
| `start` | Launch Chrome with remote debugging |
| `close` | Close the current tab; falls back to `about:blank` when it is the last tab so Chrome stays up. Not possible on a tab whose renderer is blocked by a synchronous call (`status` reports it as not answering): close that tab in Chrome's UI or restart Chrome |
| `dump-forms [url]` | Forms + hidden inputs as JSON |
| `dump-storage [url]` | localStorage, sessionStorage, cookies |
| `listeners [url] [selector]` | Defaults to `window` |
| `search-sources [url] <query>` | Find the bundle before using the four commands below. Plain query = case-insensitive substring; `--re` switches to regex (a leading `/` is path-mangled by Git Bash, so regex is a flag, not a `/.../` literal) |
| `download-bundle [url] <queryOrId> <destFile>` | |
| `deobfuscate [url] <queryOrId> [destFile]` | Prints to stdout when `destFile` is omitted |
| `unpack [url] <queryOrId> <destDir>` | |
| `ast-search [url] <queryOrId> <pattern>` | Runs on the raw script text: deobfuscate first if the calls go through a string table. The pattern must be **statement-shaped**: a bare expression like `"ws_bin" + $A` is parsed as an expression statement and matches nothing, while `throw new $A($B)` matches. Webcrack's unminify folds and re-splits statements, so a pattern copied out of the beautified copy can miss the live text — check it against the raw script. Each hit carries `range.start.column` and `range.start.index`; **use the column** (0-based, same unit as `--col` and `break`), because for a Function-constructor script the index includes the wrapper offset |
| `catch-script [url] [--min-bytes N] [--max-bytes N] [--only-runtime] [--break-line N] [--break-col N] [--eval <expr>] [--frame N] [--timeout S]` | Catches a script **before it runs** (instrumentation breakpoint) and reports it with the stack, so a payload the page built at runtime is caught even though it has no URL: `script` = scriptId, url, character length, first 120 chars; `frames` = the stack, where frame 0 is the new script and frame 1 is the code that created it; `callerExcerpt` = the 200 chars before and 300 after the call site, which is where the decode call sits. Target it with `--min-bytes`/`--max-bytes` (character bounds, on the length Chrome reports at parse time) and `--only-runtime` (scripts whose url is empty, so an inline HTML block of the same size does not win). `--break-line N` must exist in the caught script, and is rejected with the script's own range otherwise (Chrome's reply is a bare `Could not resolve breakpoint`). **Size and position units:** `--min-bytes`/`--max-bytes` count UTF-16 code units — the same number `vm-scripts` prints and `getScriptSource().length` returns — not file bytes, so a script with non-ASCII identifiers is bigger on disk than the window that matched it (`download-bundle` writes UTF-8). Lines and columns are the script's own when it starts at line 0; for an inline `<script>` block (`startLine > 0`) they are the document's lines and that line's columns, so pass its start line and leave `--break-col` off to default to the script's start column. With `--break-line N` it then arms a breakpoint by scriptId inside that script, resumes, waits for its own hit, and reports `locals` (frame 0), `callerLocals` (frame 1 — the decoder's own variables) and `evaluated` (`--eval`, on `--frame N`, default 0). `callerExcerpt` marks the call column with `>>>` |
| `vm-scripts [url]` | Scripts with an empty URL (created by eval/Function). Inline HTML scripts carry the page URL and are not listed: scriptId, start line, line count, `length` (from `Debugger.scriptParsed`, so no transfer), and the first 100 characters. A row whose source cannot be read (WebAssembly, or a cleared context) carries `head: null` and an `error` instead of failing the listing |
| `layout [url] [--wait S]` | Records style, layout, pre-paint and paint for S seconds (default 5) and prints per stage: count, total ms, and the location that was on the stack (`script:line:col`, 1-based) or `(no script on stack)` with the node name. Interact during the window. Layout and style with a script on the stack were forced by that script (e.g. a read like `offsetWidth` after a write); paint and pre-paint never have one |
| `events [url]` | Every event listener on the window and in the document tree (`depth -1`, `pierce` for iframes), grouped by event type and handler location (`script:line:col`, 1-based). A snapshot: listeners added later are missing, so run it again after the interaction |
| `profile [url] [--wait S]` | CPU profile for S seconds (sampling every 1 ms). Per function: `selfMs` (estimate from samples, can be below wall time) and the two callers with the most time. Only the immediate caller is shown |
| `find-function [url] <queryOrId> <name>` | Lines defining `function NAME(` or `NAME = function`, with the column of the start of the declaration (`async function NAME` reports the `async`, so a hand measurement agrees). The column is derived from the line text, since `Debugger.searchInContent` reports none. Text match, not a parse; each line cut to 300 characters. A definition is not preceded by an identifier character, so `weird` does not match inside `$weird`; identifiers built from non-ASCII lookalikes can still match partly, so confirm the line |
| `snippet [url] <queryOrId> <line> [--col N] [--before N] [--after N]` | Prints the characters around a position, with `>>>` marking the column (defaults: 200 before, 300 after), plus `lineLength` and `totalLines`. A minified script is one line of a million characters, so a position can only be read as a window; use it with the line and column from `find-function`, or the `callerExcerpt` marker from `catch-script` |
| `snapshot [url] [selector]` | Compact interactive-element list of the live tab (`--out` for the full list) — read before and after every action |
| `click [url] <sel\|text=Text>` | Click + DOM delta (`urlChanged`, `added`, `removedCount`). `text=Label` matches by visible text |
| `type [url] <sel> <text>` | Keystrokes + `valueAfter` echo + `valueMismatch` flag (focus-steal guard) + delta |
| `fill [url] <sel> <value>` | Set value (fires input/change) + delta |
| `press <key>` | Key on focused element + delta |
| `wait [url] <selector> [--timeout S]` | Waits for a selector to appear (default 5s). On timeout, lists what IS interactive instead of failing blind |
| `traffic [url] [--bodies] [--wait S] [--headers] [--full] [--no-redact]` | With a URL: navigate, wait for network idle, then for the first WS frame; capture the load. Without: attach to the live tab and record `--wait S` (default 5) while the user interacts — no navigation, WebSocket state undisturbed. `--bodies` drains each response body into the result (redirect hops, 204/no-cors beacons and evicted bodies appear as a `(...)` note, never silently `null`). JSON is a projection by default (id, url, method, status, type, mime, protocol, timing, size, request headers, post data); `--full` keeps every raw field (3.3 MB vs 218 KB on deadshot.io). Secret headers are `[REDACTED]` unless `--no-redact` or `--out` |
| `console [url] [--level L] [--filter T] [--limit N] [--wait S]` | `Runtime.consoleAPICalled` entries and uncaught exceptions recorded since attach. Object arguments print as previews (`boom Object {a: 1}`), not `Object`. With a URL it navigates first; without, it listens to the live tab for `--wait S` (default 2 s) |
| `raw [url] <id\|url-part> [--response] [--wait S]` | The request with its original header order and casing (`:authority`, `sec-ch-ua`, HTTP/3 signature), for Burp Repeater. `--response` prints the response instead. Cookie/Authorization are redacted on stdout; `--out` writes the real bytes |
| `search-bodies [url] <text\|/regex/> [--wait S]` | Searches recorded response bodies (native search first, then a text fallback), returning `requestId`, `url` and `matchLineNumbers` — then read one with `raw` or `traffic --bodies` |
| `ws-frames [url] [--direction sent\|received] [--query T] [--hex] [--limit N] [--wait S]` | Frames from every recorded socket: direction, opcode, `binary`, byte length, payload (500 chars), parsed JSON when it parsed, socket URL, time. `--hex` renders a binary payload as hex |
| `globals [--frame U] [--filter T] [--limit N]` | Own property names of `window` with `type` and `ctor`, for finding an engine, state object or token without guessing. Skips `webkit*`/`moz*`/`on*` noise |
| `objects <Class.prototype> [--limit N]` | `Runtime.queryObjects`: live instances of a class, for reaching a game's engine from a prototype that is already on `window` |
| `doctor` | One JSON object: node version, Chrome on the port, page targets, page readability, console error count, debugger pause state, mirror, workspace. `ok: false` names the failing check and the command that fixes it |

**Late WebSocket attach.** A process that connects to a tab whose WebSocket was opened earlier misses the handshake — no socket URL is recoverable, so such sockets appear with `url: ''` (state corrected to `open`, since frames are flowing) and `traffic` adds a `note`. Frames on them still arrive and are searchable; to get the URL and handshake, load the page in the capturing process (`traffic <url>`).
| `click-at <x> <y> [--frame U] [--canvas] [--index N] [--button left\|right\|middle] [--settle]` | Mouse click. With `--frame`, coordinates are relative to that iframe's top-left. With `--canvas`, x/y are canvas bitmap pixels: the canvas offset is added and the bitmap->CSS scale (`rect.width / canvas.width`) is applied, and the reply carries `scale`. `--index` picks a canvas when the largest visible one is not the target |
| `key <code> [--hold MS] [--settle]` | Key on the focused element (`KeyW`, `Space`, `ArrowLeft`). A chord uses `+`: `KeyW+ShiftLeft`, `ControlLeft+KeyA` (modifiers pressed first, released last). Takes no `--frame` (refused) |
| `drag <x1> <y1> <x2> <y2> [--frame U] [--canvas] [--steps N]` | Press, move in steps, release — for aiming, dragging a slider or a map. `--canvas` applies the same bitmap->CSS conversion as `click-at` |
| `wheel <dx> <dy> [--frame U]` | `Input.dispatchMouseEvent` wheel at the last pointer position; negative `dy` scrolls up, `--frame` converts to page coordinates |
| `tabs` | Open tabs: `tab` index, `url`, `title`, and `active` = true for the tab the browser is showing (its document reports `visibilityState === 'visible'`; a minimized window shows none), `null` when the tab could not be read (blocked renderer). The `tab` index is the order `tabs` printed in that run — not the order the tabs were created — and it changes when a tab is opened or closed, so run `tabs` again before addressing a tab with `--tab` |
| `frames` | Child iframes: `frame` index, canvas count, element count, url |
| `canvas [--list] [--frame U] [--index N] [--out F.png] [--screen] [--preserve] [--record N --fps N --out DIR]` | `--list` reports each canvas (index, bitmap size, CSS size, visible) and picks nothing; otherwise the largest visible canvas is read, or `--index N`. `--screen` captures the composited pixels through `Page.captureScreenshot` clipped to the canvas: WebGL reads correctly without `preserveDrawingBuffer` and without a reload. `--preserve` reloads the tab first (the game restarts) so a plain readback works. `--record S --fps F` writes S*F frames (seconds, not a frame count) to `--out DIR` |
| `clean` | Deletes the scratch folder `.tmp/` inside the skill |
| `eval [url] <expression> [--frame U] [--file script.js]` | `--file` reads the expression from a file (use it instead of quoting in PowerShell). With `--frame`, waits up to the nav timeout for a frame whose URL contains `U`; a numeric index does not wait | With a URL: navigate, then evaluate — self-contained. Without: runs against the currently open tab and leaves it open, so follow-up `eval`s inherit page state (logins, SPA routes). Objects print as JSON, not `[object Object]` |

| `step [url] <query> <line> [--trigger "<js>"] [--into\|--out] [--times N] [--eval expr]` | Pause once (breakpoint, or `--pause` for the running page), then step N times, reporting every stop (function, url, 1-based line/col, frame count) plus the final stack and `--eval` result. Stepping cannot be split across CLI calls: each call is its own CDP session and Chrome resumes on detach, so the breakpoint and trigger run inside this command |
| `postmessage [url] [--wait S]` | Records `window.postMessage` traffic. The hook applies to documents created after it is installed, so pass a URL (no URL means it starts at the next navigation) |
| `replay [url] <id\|url-part> [--wait S]` | Re-sends a recorded XHR/fetch through `Network.replayXHR` (same URL, headers, body) and lists the requests that appeared afterwards. Chrome refuses documents and sockets: the error says so |
| `search-traffic [url] <text\|/re/> [--wait S]` | Finds a recorded request by url, post body, request headers, response headers or status line; returns `requestId`, `matchedFields` |
| `ws-search [url] <text\|/re/> [--direction sent\|received] [--wait S]` | Searches WebSocket frames, decoding binary (msgpack/protobuf) payloads before matching, so a game's `updatePlayerInfo` is findable; each hit carries `bytes` and a printable `text` |
| `inspect [url] <expression>` | Deep property dump through `Runtime.getProperties`: cycles, DOM nodes and functions are readable where `JSON.stringify` throws |
| `workers` | Dedicated, service and shared workers with id, type and url |
| `purge --cache --cookies` | `Network.clearBrowserCache` / `clearBrowserCookies` for the whole profile |
| `status [--json]` | Chrome, tab, frame count, pause state, mirror progress. `--json` returns the same facts as data |

Global flags: `--port <n>`, `--tab <n>` (attach to tab N instead of 0), `--json`, `--out <file>` (JSON-producing commands write to the file instead of stdout — parent dirs are created; stdout gets the path + size), `--version`, `--help`.

A reply larger than 60 KB is written to `.tmp/results/result-<time>.json` and replaced by `{savedTo, bytes, keys, note}`, so a capture cannot flood an agent's context. `--out` chooses the path. `--flag=value` and `--flag value` parse identically.
