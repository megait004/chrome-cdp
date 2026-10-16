# Workflows

Scripts for multi-step tasks that one CLI command cannot express. Each block is a library script (`require('../index')`) unless it is a bash line.
Prefer single CLI commands first (SKILL.md, "How to work"). Use these only when that is not enough.

## Replay or inspect a request

```javascript
const [post] = client.network.getTraffic({ method: 'POST' });
console.log(await client.network.toRawRequest(post.id));
await client.network.replayXHR(post.id);                 // in-page replay, recorded like any request
client.network.searchTraffic(/bearer|auth_token|signature/i);
```

### WebSocket protocol

```javascript
const [socket] = await assertEventually(() => client.websocket.getSockets({ state: 'open' }), { describe: 'a socket' });
await waitUntil(() => client.websocket.getFrames(socket.requestId), { min: 10, timeout: 30000 });
client.websocket.getFrames(socket.requestId, { direction: 'sent', jsonOnly: true });
client.websocket.searchFrames('challenge_token');
```

Frames often arrive only after a user action. Connect, interact, then wait, then read. A socket opened before the attach shows `url: ''`; run `traffic <url>` when the handshake matters.

### Bundle

```javascript
const fs = require('fs');
const { parse, Lang } = require('@ast-grep/napi');
const [hit] = await client.sources.searchInSources(/jwt_secret|X-Signature/i);
const { code } = await client.sources.deobfuscateBundle(hit.scriptId);   // webcrack output
fs.writeFileSync('.tmp/bundle.clean.js', code);
// Structural search on the clean text. On the raw bundle a call behind a string table matches nothing.
parse(Lang.JavaScript, fs.readFileSync('.tmp/bundle.clean.js', 'utf8')).root().findAll('fetch($URL, { $$$OPTS })').map((h) => h.text());
```

For webpack or browserify bundles, `client.sources.unpackBundle(hit.scriptId, './.tmp/modules/')` splits them into modules first.

### Script with no URL

A script the page creates at runtime (`eval`, `Function`, a decoded payload) has `url: ''`. CDP still lists it with a scriptId; DevTools names it `VM<id>`.

- URL substring searches never match it. Content search does: `search-sources` covers every loaded script, including empty-URL ones.
- To list them: `node cli.js vm-scripts`. To find a function in one of them: `node cli.js find-function <scriptId> <name>`. The API equivalents are `client.sources.listDynamicScripts()` and `findFunction()`. If you write your own script, call `disconnect()` in a `finally`; an error thrown before it leaves the process waiting until the timeout.
- The scriptId changes after navigation. List again before you use an id.
- A zero result means "not in this copy", not "not there". Search the other form of the text: the raw source keeps `(!1)` where the cleaned copy has `false`.
- Decoded is not readable. Before you describe the code, count a few common markers in the file (calls, property names, event listeners). If they are absent, the text is still a string table.

### Mirror a site and index its code

```bash
node cli.js mirror start https://example.com   # records in the background
# ...interact: click, scroll, log in...
node cli.js mirror stop                        # writes .tmp/mirror/example.com/<stamp>/
node cli.js index-site .tmp/mirror/example.com/<stamp>
```

Then navigate the unpacked code with `srcwalk discover <symbol>` and `srcwalk trace callers <fn>` (scope it to the `unpacked` folder).

**Article text:** `node cli.js markdown <url> out.md`. The DOM-level version is `client.toMarkdown()`.

- `LATEST` names the newest run. `manifest.json` lists every file with its sha256.
- The recorder keeps running until `mirror stop`. It does not crawl; you drive the interaction.
- `cookies.json` and `storage.json` hold live session tokens. Do not share or commit them.
- Known gaps: a shared or service worker is attached after creation, so its first milliseconds can be missed. The Fetch path covers Document responses only. Requests pending at stop are written as `unfinished`.
- Scout does not resolve webpack numeric module ids. Modules called by id look unused. Confirm any dead-export claim with `rg` on the id.

### Pause and step

```javascript
await client.debug.enable({ pauseOnExceptions: true });
await client.debug.setBreakpoint('https://target.com/app.js', 120);
client.debug.on('paused', ({ callFrames, reason }) => console.log(reason, callFrames));
```

**Canvas state**: list the frame's own non-builtin keys, then compare with a clean iframe. Recipe in the command details below.
