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
const [hit] = await client.sources.searchInSources(/jwt_secret|X-Signature/i);
await client.sources.deobfuscateBundle(hit.scriptId);     // webcrack; search the clean code
await client.sources.unpackBundle(hit.scriptId, './.tmp/modules/');
await client.sources.searchAst(hit.scriptId, 'fetch($URL, { $$$OPTS })');
```

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
