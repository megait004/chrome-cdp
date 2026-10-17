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

### Custom string table (Obfuscator.io-style)

When a bundle resolves its strings at runtime — `const t=[...]; function d(i){return t[i-0x10]}` or a packed blob decoded
by a slice — webcrack cannot help and every text search returns zero for real names, because the name is not text in the
file. The module can resolve itself: run its own body in an isolated VM and call its own decoder.

```javascript
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('.tmp/bundle.raw.js', 'utf8');

// The body is a Function body (that is how the page built it), so it may hold a top-level `return`: wrap it as one.
// Give the sandbox the globals the module reads. A missing one surfaces as a confusing
// "Cannot read properties of undefined", so add them until the body runs to its end.
const sandbox = { globalThis, Reflect, Object, Array, String, Number, JSON, Math, Date, TextDecoder, TextEncoder };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(`(${source})`, context);          // or: new Function(source).call(sandbox)

// Then call the module's own decoder on the table. Find the two names first: search the raw text for
// "+"-joined tables or the decode helper the table is passed to.
const strings = vm.runInContext('(() => { const out = {}; for (const [k, v] of table) out[k] = decode(v); return out; })()', context);
```

Write the result out (`strings.json`) together with a copy of the module where each lookup is replaced by its string
(`decoder.readable.js`). Then `rg`, ast-grep and srcwalk work again, and `snippet` can be pointed at a position.
Practical notes:

- Register the run's network and crypto as poisoned stubs, not real ones: the module must not fetch or decrypt anything.
- Guard against a body that throws at the end: run it, catch, and keep whatever it set up before throwing.
- Keep the decoder's own semantics: a string is usually `table[offset]` into one packed blob with a length, so the
  pairs are `(offset, length)`, and two different offsets can produce the same string.
- Verify the rebuild against the live page: pick a string you already saw in a pause and check the same pair maps to it.

Two things learned about `ast-search` on such a payload, both of which produced zero hits for a whole round:

- **The pattern must be statement-shaped.** A bare expression is parsed as an expression *statement*, so it does not
  match a sub-expression. `throw new $A($B)` finds a call inside a guard; `"ws_bin" + $A` finds nothing.
- **Do not copy a pattern out of the beautified copy without checking the raw text.** Webcrack's unminify folds and
  re-splits statements, so `"ws_bin"+"dgen_t"` in the minified file becomes one literal after beautifying, and a
  `var a=b.length, c;` line can become several declarations.

Take coordinates from the hit's `range.start.column`, not `start.index`: the column is what `--col` and `break` want,
while the index includes the Function wrapper's offset for a payload built by `new Function`.

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
- Static analysis does not resolve webpack numeric module ids: a module called by id looks unused. Confirm any dead-export claim with `rg` on the id.

### Pause and step

```javascript
await client.debug.enable({ pauseOnExceptions: true });
await client.debug.setBreakpoint('https://target.com/app.js', 120);
client.debug.on('paused', ({ callFrames, reason }) => console.log(reason, callFrames));
```

**Canvas state**: list the frame's own non-builtin keys, then compare with a clean iframe. Recipe in the command details below.
