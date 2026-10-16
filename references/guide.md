# Chrome CDP guide

Short how-to for `SKILL.md`. Every command and method is in `api.md`.

## Contents

- [Order of events](#order-of-events)
- [CLI or script](#cli-or-script)
- [Interaction loop](#interaction-loop)
- [Timing](#timing)
- [Response bodies](#response-bodies)
- [Workflows](#workflows)
- [Reporting](#reporting)
- [Command details](#command-details)

## Order of events

One Chrome listens on port 9222. `connect()` attaches and **starts recording** immediately. Anything before the attach is invisible, so do not navigate first and connect second.

## CLI or script

Use the CLI for reads and bounded captures. Every command attaches to the live tab, does one thing, and leaves the tab open. A command navigates only when you pass a URL.

```bash
node cli.js traffic https://target.com --bodies --out .tmp/traffic.json   # load + capture HTTP and WebSocket
node cli.js traffic --wait 10 --bodies --out .tmp/live.json               # live tab, 10 s while you interact
node cli.js search-sources "api_key"                                      # substring; add --re for regex
node cli.js eval "({href: location.href, links: document.links.length})"
```

Write a script only for control flow the CLI cannot express: waits on a WebSocket frame while sending, breakpoints with `evaluateOnCallFrame`, or bulk processing of a large capture. Then `require('../index')` from a file in `.tmp/`, and `disconnect()` in a `finally`.

Before you open the page, list every question you want answered. One session answers them all. Each extra navigation re-records traffic and invalidates the `scriptId`s you hold.

## Interaction loop

Look, act, look. Each step is one command, and its output says what changed:

```bash
node cli.js snapshot https://target.com/login     # LOOK: visible interactive elements
node cli.js type "#login_field" "user@example.com" # ACT: real per-key events
node cli.js fill "#password" "hunter2"            # ACT: native setter, fires input and change
node cli.js click "text=Sign in"                  # ACT: match by visible text
node cli.js wait "#dashboard" --timeout 10        # LOOK: did the expected thing appear?
```

- **Snapshot before every action.** Pick selectors from the current page, never from memory or an older snapshot.
- **A failed click lists the elements that exist now.** Pick a real selector from that list.
- **Ambiguous text hits the first match.** Scope the click to the panel that owns the input, or verify with an `eval` that reads the app's own state.
- **Focus can be stolen.** When the window is hidden, `type` and `press` revive it and take foreground focus. `type` and `fill` report `valueMismatch` when the field does not hold what you typed. Then clear the field (`fill <sel> ""`) and retype, and tell the user you took their focus.

## Timing

`goto()` resolves at `domcontentloaded`, so right after it you have only the first requests. Empty `getFrames()` or a short `getTraffic()` usually means you read too early.

Wait for the signal you care about:

```javascript
const { waitForEvent, waitUntil, assertEventually } = require('../index');

// Listen when the controller emits the event: returns on the event itself
const frames = await waitForEvent(client.websocket, 'frame', {
  count: 10, timeout: 30000, where: (f) => f.direction === 'received',
});

// Poll when there is no event
const bundle = await waitUntil(() => client.sources.getScripts({ url: /app\./ }));

// Claim that something happens: throws on timeout
await assertEventually(() => client.websocket.getSockets({ state: 'open' }), {
  describe: 'the socket to open',
});
```

- `waitUntil` **synchronizes**: on timeout it returns what it saw. Use it when a partial result is still useful.
- `assertEventually` **claims**: on timeout it throws. Use it when the next line is only valid if the condition held.
- Options: `{ timeout = 20000, every = 300, min = 1 }`.

**Proving a negative** ("the server never sends X") needs a window, not a sleep. Wait for a marker you know the page produces after the event would have happened, then report the window: "no PING in 76 s across 630 frames", not "the server sends no PING". A fixed sleep dressed as a condition is still a sleep.

`hookPostMessage()` only affects loads that happen after it. Call it before `goto()`.

## Response bodies

Request metadata lives in the library's memory and survives the session. Response bodies live in Chrome's buffer. Chrome evicts them under pressure and clears them on navigation. `startRecording()` configures durable storage (100 MB total, 5 MB per resource), so bodies normally survive navigation. This was checked against the Chromium source, not by a live test.

- Durable storage is bounded: the oldest bodies go first in a long session.
- On an older Chrome build the call is ignored. An empty body there means "not stored", not "empty response". Say so in the report.
- Pull each body while its request is fresh:

```javascript
const captured = [];
for (const request of await waitUntil(() => client.network.getTraffic({ resourceType: 'XHR' }), { min: 5 })) {
  captured.push({ url: request.url, status: request.status,
    body: await client.network.getResponseBody(request.id).catch(() => null) });
}
```

- Stop driving the page when it reports it is done (`has_next: false`, an empty result). More events after that create requests you then have to explain.

## Workflows

The workflow scripts (replay a request, WebSocket protocol, bundles, mirror a site, pause and step) are in [workflows.md](workflows.md).

## Reporting

Structure the answer so a reader can verify it without rerunning anything:

```text
## Target        url, and the state the page was in (logged in? which route?)
## Findings      each claim, with where it lives and the raw evidence (header, frame, source line)
## Reproduce     the exact commands or script
## Not covered   what you did not look at
```

- Quote real bytes. Say "not observed", not "not present": a live page shows only what it did while you watched.
- **Re-derive every number from the artifact as you write.** Counts drift in your head. Read them back from the saved file. If you did not save an artifact, say what you observed instead.

## Render pipeline

Checked against Chromium's source (`references/chromium`, Blink `core/`). Paths are relative to `third_party/blink/renderer/core/`.

- **Order per frame:** style, layout, compositing inputs, pre-paint, paint (`dom/document_lifecycle.h`, `frame/local_frame_view.cc` `UpdateLifecyclePhasesInternal`). Layout can run again inside the same frame when a step after layout dirties it again (the loop in that function).
- **Reading layout forces it.** `offsetWidth` and the other geometry getters call `UpdateStyleAndLayoutForNode` synchronously (`dom/element.cc`, `OffsetWidth`). A write followed by a read in one task costs a full style and layout each time.
- **`display: none` has no layout object**; `visibility: hidden` and `opacity: 0` do (`dom/element.cc`, `LayoutObjectIsNeeded`).
- **A plain `transform` or `opacity` change does not get a compositor layer.** Only an active animation or `will-change` does (`paint/compositing/compositing_reason_finder.cc`). Without one, the change repaints.
- **Parser waits for stylesheets.** A stylesheet in the body does not block paint, but the parser pauses while a parser-blocking stylesheet is pending (`html/parser/html_document_parser.cc`, `WaitingForStylesheets`).
- **`async` is immediate by default.** Blink has an intervention, `DelayAsyncScriptExecution`, which is `FEATURE_DISABLED_BY_DEFAULT` (`blink/common/features.cc`). Only an enabled feature or field trial can delay an `async` script (`script/script_loader.cc`).
- **Paint is not caused by script.** A paint after a `requestAnimationFrame` callback runs in the frame, after the script returned. `layout` reports it as `(no script on stack)`: match it to the script by time, not by stack.

## Mapping what runs

A way to get from a user event to the code that runs, without reading the whole bundle. Each step names the next one.

1. `node cli.js events` lists the handlers: event type, and the `script:line:col` that registered it. Handlers registered by code that is only in the minified bundle show up here too, by their obfuscated event name.
2. Start the interaction that matters, then `node cli.js profile --wait S` while you do it. The profile lists the functions that ran in that window, with self time and callers.
3. Find the handler's code: `node cli.js vm-scripts` to name the script, `node cli.js find-function <scriptId> <name>` for a named function, `node cli.js deobfuscate <scriptId> <file>` for readable text.

What this can and cannot show:

- `events` is a snapshot at the moment it runs. A listener added after it is missing. Run it again after the page changes.
- `events` cannot list events the page never registers, and it cannot trigger them. Testing an event means performing the action yourself.
- `profile` is sampled every 1 ms. Totals are estimates: on a test loop of 1500 ms it reported 902 ms of self time. Treat the numbers as a ranking, not an exact time.
- Callers are the immediate caller only. A deeper chain needs the trace stack (`layout` records one for style and layout).

## Reverse-engineering a runtime payload

The hard case: a production bundle that arrives as one file, gets decoded, and is then executed as a script the
page created at runtime. The executed script has **no URL**, so searching by URL finds nothing, and its code is
built from a string table, so reading it statically tells you the shape but not the run.

Index through the artifacts: you know the input (the downloaded file) and the output (the decoded script), and the
live work is the middle.

1. `node cli.js vm-scripts` names every script with no URL: scriptId, line count, first 100 characters. The decoded
   payload is normally the largest by far.
2. `node cli.js catch-script <url> --min-bytes 2000000` pauses **before** that payload runs and prints the stack.
   Frame 0 is the payload; frame 1 is the function that built it; `callerExcerpt` is the code at the call site —
   the `new Function(...)` (or equivalent) call with its arguments. That is the decode entry, live.
3. Same call with `--break-line 0`: the command then breaks inside the payload and prints `locals` (the payload's own
   frame), `callerLocals` (the decoder's variables — the tables and native constructors it was handed) and
   `evaluated` for `--eval <expr>`. Add `--frame 1` to evaluate in the decoder's frame instead of the payload's.
4. For a later hang or branch, `node cli.js break <scriptId> <line> --col N --trigger "<js>" --eval <expr>` breaks
   inside the same payload again, at a line you chose.

Two traps, both hit on a real payload:

- **The pause before a script runs cannot read values.** At an instrumentation pause, `evaluateOnCallFrame`,
  `Runtime.getProperties` and `Runtime.evaluate` time out — the renderer's JS thread does not answer them — while
  `Debugger.getScriptSource` answers in tens of milliseconds. Script sources and frame positions come back; variables
  do not. `catch-script` prints that as a `note` when `--break-line` is missing. Read values at a breakpoint pause.
- **A breakpoint is per position.** At a breakpoint pause the JS thread answers normally: `--eval` and scopes work.
  But a line whose statement already ran will not hit again, so pick a line that runs later (or re-trigger it in the
  same command with `--trigger`). A URL breakpoint cannot name a script with no URL: pass the scriptId.

Primitives behind it, for scripts of your own: `client.debug.setInstrumentationBreakpoint('beforeScriptExecution')`,
`setBreakpointAtLocation(scriptId, line, column, condition)`, `getScopeValues(callFrame, { limit })`,
`evaluateOnCallFrame(callFrameId, expression)`. The pause state lives and dies with one CDP session, so a multi-step
walk has to run inside a single script under `.tmp/`.

## Command details

- **`mirror stop`** waits for 1.5 s of network quiet (max 10 s more). Do not sleep before it. It prints `Navigation failed:` when the page never loaded: read that line before trusting the output.
- **`mirror start`** clears a stale `ACTIVE` pointer. A live recording blocks a new one: `mirror stop` first.
- **`frames`** lists child iframes only. Canvases in the top document are not in its output: count them with `eval "document.querySelectorAll('canvas').length"`.
- **`traffic`** without `--bodies` stores no response bodies. A missing body field means "not captured", not "empty". Add `--bodies`, or use `mirror start`, when you need the bytes.
- **A search with zero hits is not proof of absence.** Try the other spelling of the text and the cleaned copy before you report it missing (see [workflows.md](workflows.md#script-with-no-url)).
- **`wait <sel>`** needs a visible element. The error says `No element matches` or `exists but is not visible`. `--json` prints `{ok, reason, waitedSeconds, state, interactive}`.
- **`break <query>`** lives only inside its command. Arm and trigger in one call: `break lazy.js 0 --trigger "<js>"`. A query matching no loaded script gives `hit: false`.
- **`listeners` and `eval`** take a URL only when the first argument starts with `http(s)://`.
- **`waitUntil`** does not throw on timeout. Use `assertEventually` when a timeout must fail.
- **`dump-storage <url>`** navigates first, which also re-sets cookies that URL sets. Omit the URL to read the tab as it is.
- **`traffic --json`** top-level keys: `finalUrl`, `mode`, `httpTraffic`, `wsSockets`. `traffic --headers` prints each repeated `Set-Cookie` on its own line.
- **`--out`** prints a `Saved ... bytes` line. That is not an error.
- **`clean`** deletes all of `.tmp/`. Copy what you need first.
- **Checks:** `npm run typecheck` and `npm run typecheck:strict`. The skill has no test suite.

**Canvas state recipe.** Write `.tmp/keys.js` with `(() => Object.keys(window).filter(k => !/^(on|webkit)/.test(k) && !(k in Object.getPrototypeOf(window))).slice(0, 300).join(' '))()`, run `node cli.js eval --frame <part> --file .tmp/keys.js`, then check suspicious names with `typeof`.
