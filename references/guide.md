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

## Command details

- **`mirror stop`** waits for 1.5 s of network quiet (max 10 s more). Do not sleep before it. It prints `Navigation failed:` when the page never loaded: read that line before trusting the output.
- **`mirror start`** clears a stale `ACTIVE` pointer. A live recording blocks a new one: `mirror stop` first.
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
