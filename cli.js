#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect, startChrome, waitUntil, checkCdpReady } = require('./index');

/**
 * Attaches to a Chrome that is already running on `port`. Never launches one:
 * a command must not open a browser on the user's profile unannounced. Use
 * `node cli.js start` for that.
 */
let tabIndex = 0; // set from --tab; every command attaches to this tab

/** @param {number} port @returns {Promise<Client>} */
async function attach(port) {
  if (!(await checkCdpReady(port))) {
    throw new Error(`Chrome is not running on port ${port}. Start it with: node cli.js start`);
  }
  return connect({ port, autoLaunch: false, tab: tabIndex });
}
const T = require('./src/timeouts');

/**
 * What main() hands every command. Handlers take what they need from it.
 * @typedef {{ command: string, args: string[], port: number, isJson: boolean, outFile: string | null, tab: number }} Ctx
 */

/** @typedef {InstanceType<typeof import('./src/chrome-client')>} Client */

/** @type {Client | undefined} */
let activeClient;

/** Single predicate for the "optional leading URL" convention every command shares. */
/** @param {unknown} s */
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

const HELP_TEXT = `
Usage: node cli.js <command> [options] [arguments]

Commands:
  start                         Start Chrome with remote debugging on port 9222
  markdown [url] [destFile]     Extract article content as clean Markdown (GFM)
  dump-forms [url]              Audit all forms, methods, actions, and inputs (inc. hidden)
  dump-storage [url]            Dump localStorage, sessionStorage, and cookies
  listeners [url] [selector]    Audit event listeners on target selector or 'window'
  search-sources [url] <query>  Search across all loaded script bundles. Plain query =
                                case-insensitive substring; use --re for regex
  download-bundle [url] <queryOrId> <destFile>
                                Download matching script bundle to local file
  deobfuscate [url] <queryOrId> [destFile]
                                Deobfuscate & unminify script using webcrack
  unpack [url] <queryOrId> <destDir>
                                Unpack Webpack/Browserify modules into folder
  ast-search [url] <queryOrId> <pattern>
                                Structural AST search using ast-grep (e.g. 'fetch($U, $$$)')
  traffic [url] [--bodies] [--wait S]
                                Record network + WebSocket frames. With a URL: navigate,
                                wait for network idle, then for the first WS frame.
                                Without: attach to the live tab and record --wait S
                                (default 5) while the user interacts. --bodies drains
                                each response body into the result
  eval [url] <expression> [--frame U]
                                Evaluate JavaScript in the page. Passing a URL navigates
                                first; without one it evaluates on the current tab.
                                --frame U runs it inside the iframe whose URL contains U
  break [url] <scriptQuery> <line>
                                Set a Debugger breakpoint (URL substring match) and wait
                                for the hit. Line is SCRIPT-relative and 0-based: line N
                                of the source as shown by search-sources/getScriptSource
                                (inline <script> blocks are auto-offset). Flags:
                                --col N, --condition <expr>, --eval <expr> (runs on the
                                top call frame), --timeout S (default 15), --hold
                                (stay paused), --exceptions (also pause on exceptions)
  close                         Close the current tab (tabs are otherwise left open —
                                you close them by hand)

Interaction loop — operate the live tab one step at a time, like a person:
  snapshot [url] [selector]     List interactive elements currently visible (buttons,
                                links, inputs...). READ THIS before every action
  click [url] <sel|text=Text>   Click, then report what changed (url, added/removed
                                elements). selector looks like CSS; text=Click Me
                                matches by visible text instead
  type [url] <sel> <text>       Keystroke-by-keystroke into an input, reports the value
  fill [url] <sel> <value>      Set an input value directly (fires input/change)
  press [url] <key>             Press a key on the focused element (Enter, Tab, Escape)
  tabs                          List open tabs (index, url, title). Every command uses
                                tab 0 unless --tab N selects another one
  frames                        List child iframes: index, canvas count, element count, url.
                                --frame takes a substring of the url or this index
  clean                         Delete the scratch folder .tmp/ inside the skill
  click-at <x> <y> [--frame U]  Mouse click at coordinates. With --frame, coordinates are
                                relative to that iframe; U is a substring of its URL
                                (see snapshot). For canvas games that have no selectors
  key <code> [--hold MS]        Hold a key (KeyW, Space, ArrowLeft) on the focused element.
                                Click the game first so its frame has focus
  canvas [--frame U] [--index N] [--out F.png] [--preserve]
                                Canvas size, or with --out the pixels as PNG. Pixels only
                                when needed: snapshot already lists every canvas.
                                --preserve reloads the tab first (game restarts) so WebGL
                                canvases keep their pixels; without it WebGL reads blank
  wait [url] <selector> [--timeout S]
                                Wait for a selector to appear (default 5s)

Tabs are never closed automatically: every command attaches to the live tab (re-
navigating only when you pass a URL) and leaves it open on exit, so page state —
logins, SPA routes, WebSocket sessions — survives between commands.

Options:
  --port <number>               CDP port (default: 9222)
  --json                        Format output as structured JSON (traffic default: table)
  --out <file>                  Write the JSON result to a file instead of stdout;
                                prints the path plus a short summary (every command
                                that produces structured output)
  --help                        Display this help message
`;

/**
 * Splits global options out of argv so they never land in a positional slot --
 * `eval <expr> --port 9333` used to evaluate the flags as part of the expression.
 * @param {string[]} argv
 * @returns {{ positional: string[], port: number, isJson: boolean, out: string|null, tab: number }}
 */
function parseGlobalOptions(argv) {
  const positional = [];
  let port = 9222;
  let isJson = false;
  let out = null;
  let tab = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
      }
    } else if (argv[i] === '--json') {
      isJson = true;
    } else if (argv[i] === '--tab') {
      tab = Number(argv[++i]);
      if (!Number.isInteger(tab) || tab < 0) throw new Error('--tab expects a tab index from 0, e.g. --tab 1 (see: node cli.js tabs)');
    } else if (argv[i] === '--out') {
      out = argv[++i] || null;
      if (!out) throw new Error('--out requires a file path: --out result.json');
    } else {
      positional.push(argv[i]);
    }
  }

  return { positional, port, isJson, out, tab };
}

/**
 * Emits a JSON result: to stdout by default, or with `--out <file>` to a file
 * so the agent never has to parse a wall of stdout. The file is the artifact;
 * stdout only carries the path and a short summary.
 * @param {object} result JSON-serializable command result
 * @param {string|null} outFile `--out` value
 */
async function emit(result, outFile) {
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true }); // agents forget to mkdir
    await fs.promises.writeFile(abs, json, 'utf8');
    console.log(`Saved ${Buffer.byteLength(json)} bytes of JSON to: ${abs}`);
  } else {
    console.log(json);
  }
}

/**
 * Formats the first few interactive elements as terse `tag#id "text"` lines for
 * error hints — shared by the click/action failure path and the wait timeout.
 * @param {import('./src/types/snapshot').SnapshotElement[]} elements result of interactiveSnapshot()
 * @param {{ limit?: number, skipDisabled?: boolean }} [options]
 * @returns {string[]}
 */
function interactiveHints(elements, { limit = 8, skipDisabled = false } = {}) {
  return elements
    .filter((e) => !skipDisabled || !e.disabled)
    .slice(0, limit)
    .map((e) => `${e.tag}${e.id ? '#' + e.id : ''}${e.text ? ' "' + e.text.slice(0, 30) + '"' : ''}`);
}

/**
 * Detaches from the browser. The tab is deliberately left open — the user
 * closes tabs by hand, and page state (logins, SPA routes, WebSocket
 * sessions) survives between commands. `close` is the explicit cleanup path.
 * @param {import('./src/chrome-client.js')} client
 * @param {Client} client
 */
async function release(client) {
  if (activeClient === client) activeClient = undefined;
  try {
    await client.disconnect();
  } catch {}
}

/** @param {Ctx} ctx */
async function cmdStart({ port }) {
  await startChrome({ port });
}

/** @param {Ctx} ctx */
async function cmdMarkdown({ args, port }) {
  // `markdown <url> [destFile]` or, for the live tab, `markdown [destFile]`
  const first = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const url = first && isHttpUrl(first) ? first : null;
  const destFile = url ? (args[2] && !args[2].startsWith('--') ? args[2] : null) : first;

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);
  const article = await client.toMarkdown();

  if (!article) {
    throw new Error('No readable article content found.');
  }

  if (destFile) {
    await fs.promises.writeFile(path.resolve(destFile), article.markdown, 'utf8');
    console.log(`Saved Markdown to: ${path.resolve(destFile)}`);
  } else {
    console.log(article.markdown);
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDumpForms({ args, port, outFile }) {
  const url = args[1] && !args[1].startsWith('--') ? args[1] : null;

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const forms = await client.dom.dumpForms();
  const hidden = await client.dom.dumpHiddenInputs();

  const result = { url: url || client.url(), forms, hiddenInputs: hidden };
  await emit(result, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDumpStorage({ args, port, outFile }) {
  const url = args[1] && !args[1].startsWith('--') ? args[1] : null;

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const storage = await client.dom.dumpStorage();
  const cookies = await client.network.getCookies();

  const result = { url: url || client.url(), ...storage, cookies };
  await emit(result, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdListeners({ args, port, outFile }) {
  const url = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const selArg = url ? args[2] : args[1];
  const selector = selArg && !selArg.startsWith('--') ? selArg : 'window';

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const listeners = await client.dom.getEventListeners(selector);
  await emit({ url: url || client.url(), target: selector, listeners }, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdSearchSources({ args, port, outFile }) {
  // Strip --re first so it can sit on either side of the query.
  const useRegex = args.includes('--re');
  const rest = args.filter((a) => a !== '--re');
  const url = rest[1] && isHttpUrl(rest[1]) ? rest[1] : null;
  const query = url ? rest[2] : rest[1];
  if (!query) {
    throw new Error('Search query required: node cli.js search-sources [url] <query>');
  }

  const client = (activeClient = await attach(port));
  // networkidle2: scripts register with the debugger asynchronously, so searching right after
  // domcontentloaded can miss inline scripts (same reason traffic waits for network idle)
  if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });

  // CLI args are plain strings; the API needs a RegExp instance for regex
  // search. Note: a leading '/' gets path-mangled by Git Bash (MSYS), so
  // regex is opt-in via --re instead of a /.../ literal convention.
  const searchQuery = useRegex ? new RegExp(query) : query;

  const results = await client.sources.searchInSources(searchQuery);
  await emit({ query, count: results.length, matches: results }, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDownloadBundle({ args, port }) {
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const queryOrId = url ? args[2] : args[1];
  const destFile = url ? args[3] : args[2];
  if (!queryOrId || !destFile) {
    throw new Error('Usage: node cli.js download-bundle [url] <queryOrId> <destFile>');
  }

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const downloadRes = await client.sources.downloadBundle(queryOrId, destFile);
  console.log(`Successfully downloaded bundle: ${downloadRes.filePath} (${downloadRes.bytesWritten} bytes)`);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDeobfuscate({ args, port }) {
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const queryOrId = url ? args[2] : args[1];
  const destArg = url ? args[3] : args[2];
  const destFile = destArg && !destArg.startsWith('--') ? destArg : null;
  if (!queryOrId) {
    throw new Error('Usage: node cli.js deobfuscate [url] <queryOrId> [destFile]');
  }

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const deobf = await client.sources.deobfuscateBundle(queryOrId);
  if (destFile) {
    await fs.promises.writeFile(path.resolve(destFile), deobf.code, 'utf8');
    console.log(`Saved deobfuscated code to: ${path.resolve(destFile)}`);
  } else {
    console.log(deobf.code);
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdUnpack({ args, port }) {
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const queryOrId = url ? args[2] : args[1];
  const destDir = url ? args[3] : args[2];
  if (!queryOrId || !destDir) {
    throw new Error('Usage: node cli.js unpack [url] <queryOrId> <destDir>');
  }

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const unpackRes = await client.sources.unpackBundle(queryOrId, destDir);
  console.log(`Successfully unpacked ${unpackRes.moduleCount} modules to: ${unpackRes.outputDirectory}`);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdAstSearch({ args, port, outFile }) {
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const queryOrId = url ? args[2] : args[1];
  const pattern = url ? args[3] : args[2];
  if (!queryOrId || !pattern) {
    throw new Error('Usage: node cli.js ast-search [url] <queryOrId> <pattern>');
  }

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const astMatches = await client.sources.searchAst(queryOrId, pattern);
  await emit({ pattern, count: astMatches.length, matches: astMatches }, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdTraffic({ args, port, isJson, outFile }) {
  // With a URL: navigate there and capture the load. Without: attach to
  // the live tab (the one the user is interacting with) and record a
  // time window — no navigation, so WebSocket state is never disturbed.
  const url = args[1] && !args[1].startsWith('--') && isHttpUrl(args[1]) ? args[1] : null;
  if (args[1] && !args[1].startsWith('--') && !url) {
    throw new Error(`Invalid URL: ${args[1]} — must start with http:// or https:// (omit it to capture the live tab)`);
  }
  const drainBodies = args.includes('--bodies');

  const waitIdx = args.indexOf('--wait');
  let waitSecs = null;
  if (waitIdx !== -1) {
    waitSecs = Number(args[waitIdx + 1]);
    if (!Number.isFinite(waitSecs) || waitSecs < 0) throw new Error('--wait expects seconds, e.g. --wait 5');
  }

  const client = (activeClient = await attach(port));
  client.network.clear();
  client.websocket.clear();

  if (url) {
    // Wait for network idle instead of reading immediately after goto() —
    // domcontentloaded resolves while the page is still fetching, and a
    // half-empty capture reads as 'nothing there' (see SKILL.md, timing).
    await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });

    // networkidle2 does not count WebSocket handshakes. If the page opened
    // a WS, wait for its first frame (marker-based, no guessed sleep) —
    // capped at 8s. --wait adds a plain dwell on top for late frames.
    await waitUntil(() => {
      const socks = client.websocket.getSockets();
      return socks.length === 0 || socks.some((s) => s.frames.length > 0);
    }, { timeout: T.CLI_WS_WAIT_MS });
    if (waitSecs !== null && waitSecs > 0) await new Promise((r) => setTimeout(r, waitSecs * 1000));
  } else {
    // Live-tab capture: recording started at connect(); give the user
    // --wait seconds (default 5) to click around while we listen.
    await new Promise((r) => setTimeout(r, (waitSecs ?? T.CLI_DEFAULT_WAIT_S) * 1000));
  }

  const httpTraffic = client.network.getTraffic();
  const wsSockets = client.websocket.getSockets();
  /** @type {{ finalUrl: string, mode: string, httpTraffic: unknown, wsSockets: unknown, note?: string }} */
  const result = { finalUrl: client.url(), mode: url ? 'load' : 'live', httpTraffic, wsSockets };
  if (!url && wsSockets.some((s) => !s.url)) {
    result.note = 'socket(s) with no URL were opened before this attach — the handshake was missed, but their frames still flow';
  } else if (!url && wsSockets.length === 0) {
    result.note = 'no frames arrived in this window; a WebSocket opened before attach becomes visible only once it sends a frame — rerun with a longer --wait';
  }

  if (drainBodies) {
    // Drain bodies now, while the network buffer still holds them.
    // XHR/Fetch/Document first — they are what an agent reads and the ones
    // Chrome evicts soonest. Store the unwrapped body string, plus parsed
    // JSON when the payload was one. Chrome keeps no body for redirect
    // hops, 204/no-cors beacons, and some binaries: those get a `(...)`
    // note as the body instead of a silent null.
    /** @type {(res: unknown) => { body: unknown, parsedJson?: unknown }} */
    const extract = (res) => (res && typeof res === 'object' && 'body' in res
      ? { body: res.body, parsedJson: 'parsedJson' in res ? res.parsedJson : undefined }
      : { body: res });
    const prioritized = [...httpTraffic].sort((a, b) =>
      Number(/^(XHR|Fetch|Document)$/.test(b.resourceType)) - Number(/^(XHR|Fetch|Document)$/.test(a.resourceType)));
    result.httpTraffic = await Promise.all(prioritized.map(async (t) => {
      const { body, parsedJson } = extract(
        await client.network.getResponseBody(t.id).catch((/** @type {unknown} */ e) => `(${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`));
      return { ...t, body, ...(parsedJson ? { parsedJson } : {}) };
    }));
  }

  if (isJson || outFile) {
    await emit(result, outFile);
  } else {
    console.log(`\n=== HTTP Requests (${httpTraffic.length}) === (final URL: ${result.finalUrl})`);
    httpTraffic.forEach((t) => {
      console.log(`[${t.method || 'GET'}] ${t.status || '...'} ${t.url} (${t.resourceType})`);
    });

    console.log(`\n=== WebSocket Connections (${wsSockets.length}) ===`);
    wsSockets.forEach((s) => {
      console.log(`[WS] ${s.url} - State: ${s.state}, Frames: ${s.frames.length}`);
    });
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdEval({ args, port }) {
  const frame = takeFlag(args, '--frame');
  const first = args[1];
  const navigates = first && isHttpUrl(first);
  const expression = (navigates ? args.slice(2) : args.slice(1)).join(' ');
  if (!expression) {
    throw new Error('Usage: node cli.js eval [url] <expression> [--frame <url part>] — pass a URL to navigate first, or omit it to evaluate on the current tab');
  }

  const client = (activeClient = await attach(port));
  if (navigates) await client.goto(first);
  // --frame runs the expression inside an iframe (games live there), same as evaluate elsewhere
  const result = frame ? await client.visual.frame(frame).evaluate(expression) : await client.evaluate(expression);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));

  // Tab stays open — follow-up commands and evals inherit the page state.
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdBreak({ args, port, outFile }) {
  // One-shot breakpoint: set it, wait for the hit, capture the stack,
  // optionally evaluate on the top frame, then resume (the page is frozen
  // while paused, so always resume — including on the error path — unless
  // --hold is passed). Multi-step sessions (stepOver/stepInto/loops) do NOT
  // survive across CLI invocations: each command opens a fresh CDP session
  // and pause state dies with it. For those, write a .tmp/ script against
  // client.debug directly (see references/api.md, client.debug).
  // NOTE: the CLI speaks SCRIPT-relative lines (as shown by search-sources /
  // getScriptSource, 0-based); the startLine offset below translates them to
  // the document-relative lines the protocol wants.
  const raw = args.slice(1);
  let url = null;
  if (raw[0] && isHttpUrl(raw[0])) url = raw.shift();
  let col = 0, condition = null, evalExpr = null, timeoutS = 15, hold = false, pauseExc = false;
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--col') col = Number(raw[++i]);
    else if (a === '--condition') condition = raw[++i];
    else if (a === '--eval') evalExpr = raw[++i];
    else if (a === '--timeout') timeoutS = Number(raw[++i]);
    else if (a === '--hold') hold = true;
    else if (a === '--exceptions') pauseExc = true;
    else pos.push(a);
  }
  const [scriptQuery, lineStr] = pos;
  if (!scriptQuery || lineStr === undefined) {
    throw new Error('Usage: node cli.js break [url] <scriptQuery> <line> [--col N] [--condition expr] [--eval expr] [--timeout S] [--hold] [--exceptions]');
  }
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 0) throw new Error(`Invalid line: ${lineStr} (0-based, so UI line minus 1)`);
  if (!Number.isFinite(col) || col < 0) throw new Error(`Invalid --col: ${raw[raw.indexOf('--col') + 1]}`);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error('--timeout expects seconds, e.g. --timeout 20');

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);
  await client.debug.enable({ pauseOnExceptions: pauseExc });

  // Resolve the query to a concrete script URL when possible — exact URLs
  // resolve breakpoints immediately (locations[] non-empty); an unmatched
  // pattern still registers a logical breakpoint that fires on future loads.
  const known = client.sources.getScripts({ url: scriptQuery });
  const targetUrl = known.length ? known[0].url : scriptQuery;
  // setBreakpointByUrl counts lines from the top of the *document*, but an
  // agent reads script-relative lines (getScriptSource / search-sources
  // output start at the <script> block). For inline scripts startLine > 0,
  // so offset: the CLI speaks script-relative, the protocol document-relative.
  // External .js files have startLine 0 — no change there.
  const startLine = known.length ? (known[0].startLine || 0) : 0;
  const bp = await client.debug.setBreakpoint(targetUrl, line + startLine, col, condition || undefined);

  const hit = await new Promise((resolve) => {
    if (client.debug.paused) return resolve(client.debug.paused);
    const onP = (/** @type {unknown} */ ev) => { clearTimeout(to); resolve(ev); };
    const to = setTimeout(() => { client.debug.off('paused', onP); resolve(null); }, timeoutS * 1000);
    client.debug.once('paused', onP);
  });

  let evalResult = null;
  try {
    if (!hit) {
      await emit({
        breakpointId: bp.breakpointId, targetUrl, line, column: col,
        locations: bp.locations, matchedScripts: known.length,
        hit: false,
        note: `no pause within ${timeoutS}s — breakpoint is armed (fires on future loads too). Trigger the action (click/type/wait) while this runs with a longer --timeout, or narrow scriptQuery via search-sources`,
      }, outFile);
    } else {
      // Spec note: CallFrame.url is deprecated — resolve via location.scriptId
      // against the scriptParsed table instead of trusting the field.
      const urlByScriptId = new Map(client.sources.getScripts().map((s) => [s.scriptId, s.url]));
      const frames = (hit.callFrames || []).map((/** @type {import('devtools-protocol').Protocol.Debugger.CallFrame} */ f) => ({
        callFrameId: f.callFrameId,
        functionName: f.functionName || '(anonymous)',
        scriptId: f.location?.scriptId,
        url: (f.location?.scriptId && urlByScriptId.get(f.location.scriptId)) || f.url || '',
        lineNumber: f.location?.lineNumber,
        columnNumber: f.location?.columnNumber,
        scopeTypes: (f.scopeChain || []).map((/** @type {{ type: string }} */ s) => s.type),
      }));
      if (evalExpr && frames.length) {
        try {
          evalResult = await client.debug.evaluateOnCallFrame(frames[0].callFrameId, evalExpr);
        } catch (err) {
          evalResult = { error: (err instanceof Error ? err.message : String(err)).split('\n')[0] };
        }
      }
      await emit({
        breakpointId: bp.breakpointId, targetUrl, line, column: col,
        locations: bp.locations, matchedScripts: known.length,
        hit: true, reason: hit.reason,
        hitBreakpoints: hit.hitBreakpoints || [],
        callFrames: frames,
        ...(evalResult !== null ? { eval: evalResult } : {}),
        resumed: !hold,
      }, outFile);
    }
  } finally {
    // The page is frozen while paused — never leave it that way by accident.
    if (!hold || !hit) { try { await client.debug.resume(); } catch {} }
    else console.error('[warn] --hold: tab left PAUSED. Resume from a script (client.debug.resume()) before interacting.');
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdClose({ port }) {
  const client = (activeClient = await attach(port));
  const closing = client.page.url();
  await client.closePage(); // falls back to about:blank when it is the last tab, so Chrome stays up
  console.log(`Closed tab: ${closing}`);
  await release(client);
}

/** Canvases and interactive elements inside each child frame: the only view of a game.
 * Frames with neither (ad iframes) are dropped. */
/**
 * Canvases and interactive elements of one frame. A frame removed mid-scan yields nothing.
 * @param {Client} client
 * @param {import('puppeteer-core').Frame} frame
 */
async function scanFrame(client, frame) {
  if (frame.isDetached()) return { canvases: [], elements: [] };
  const canvases = await frame.evaluate(() => [...document.querySelectorAll('canvas')]
    .map((c, i) => ({ index: i, width: c.width, height: c.height, id: c.id || undefined }))).catch(() => []);
  const elements = await client.dom.interactiveSnapshot(undefined, frame).then((s) => s?.elements ?? []).catch(() => []);
  return { canvases, elements };
}

/** @param {Client} client */
async function frameSnapshots(client) {
  const out = [];
  for (const [index, frame] of client.visual.frames().entries()) {
    const { canvases, elements } = await scanFrame(client, frame);
    if (canvases.length || elements.length) out.push({ frame: index, url: frame.url(), canvases, elements });
  }
  return out;
}

/** @param {Ctx} ctx */
async function cmdSnapshot({ args, port, outFile }) {
  const client = (activeClient = await attach(port));
  let selector = args[1] && !args[1].startsWith('--') ? args[1] : null;
  if (selector && isHttpUrl(selector)) {
    await client.goto(selector, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    selector = args[2] && !args[2].startsWith('--') ? args[2] : null;
  }
  if (client.url() === 'about:blank') {
    throw new Error('The tab is blank — open a page first: pass a URL, node cli.js click <url> <sel>, or open the page yourself');
  }
  const snap = await client.dom.interactiveSnapshot(selector ?? undefined);
  if (!snap) throw new Error(`No element matches scope selector: ${selector}`);
  await emit({ url: snap.url, readyState: snap.readyState, count: snap.count, elements: snap.elements, frames: await frameSnapshots(client) }, outFile);
  await release(client);
}

// ---- canvas and raw input: games draw on <canvas> inside iframes, so there are no
// selectors. Use `snapshot` for each frame's URL and canvas index, then act by coordinates.
// Flags are taken from args in place, so the positional arguments stay simple.
/** @param {string[]} args @param {string} name @returns {string | null} */
function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, value] = args.splice(i, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

/** @param {Ctx} ctx */
async function cmdTabs({ port }) {
  const client = (activeClient = await attach(port));
  const pages = await client.browser.pages();
  const rows = [];
  for (const [index, page] of pages.entries()) {
    rows.push({ tab: index, url: page.url(), title: await page.title().catch(() => ''), active: index === tabIndex });
  }
  await emit(rows, null);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdFrames({ port }) {
  const client = (activeClient = await attach(port));
  const rows = [];
  for (const [index, frame] of client.visual.frames().entries()) {
    const scan = await scanFrame(client, frame);
    rows.push({ frame: index, canvases: scan.canvases.length, elements: scan.elements.length, url: frame.url().slice(0, 120) });
  }
  await emit(rows, null);
  await release(client);
}

/** Deletes the scratch directory (.tmp) inside the skill. Nothing else. */
async function cmdClean() {
  const dir = path.join(__dirname, '.tmp');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}

/** @param {Ctx} ctx */
async function cmdClickAt({ args, port }) {
  const frame = takeFlag(args, '--frame');
  const [x, y] = args.slice(1).map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click-at expects two numbers: click-at <x> <y> [--frame <url part>]');
  const client = (activeClient = await attach(port));
  await client.visual.click(x, y, { frame: frame ?? undefined });
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdKey({ args, port }) {
  const hold = takeFlag(args, '--hold');
  const code = args[1];
  if (!code) throw new Error('key expects a KeyboardEvent.code: key <KeyW|Space|ArrowLeft> [--hold MS]');
  const holdMs = hold === null ? 0 : Number(hold);
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error('--hold expects milliseconds, e.g. --hold 300');
  const client = (activeClient = await attach(port));
  await client.visual.key(code, { holdMs });
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdCanvas({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  const index = takeFlag(args, '--index');
  const preserveAt = args.indexOf('--preserve');
  const preserve = preserveAt !== -1;
  if (preserve) args.splice(preserveAt, 1);
  const client = (activeClient = await attach(port));
  if (preserve) {
    // Canvases built before this call have no preserved buffer, so the page must be
    // reloaded for the hook to take effect. This resets the game: it is explicit on purpose.
    console.log('Reloading the tab so WebGL canvases keep their drawing buffer (the game restarts)...');
    await client.visual.preserveWebGL();
    await client.page.reload({ waitUntil: 'domcontentloaded' });
    await waitUntil(() => client.visual.frames().some((f) => f.url().includes(frame ?? '')), { timeout: T.CLI_NAV_TIMEOUT_MS });
  }
  const { width, height, dataUrl } = await client.visual.canvas({ frame: frame ?? undefined, index: index === null ? 0 : Number(index) });
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`Saved ${width}x${height} PNG to: ${abs}`);
  } else {
    console.log(`canvas ${width}x${height} (pass --out file.png to save the pixels)`);
  }
  await release(client);
}

// ---- interaction loop: see, act, see again. Every action below works on
// the live tab (never navigates, except for the optional leading URL), and
// every action returns the DOM delta so the next decision is made against
// what the page shows NOW.
/** @param {Ctx} ctx */
async function cmdInteract(ctx) {
  const { args, port, outFile, command: action } = ctx;
  const client = (activeClient = await attach(port));
  const targets = args.slice(1).filter((a) => !a.startsWith('--'));

  // Any of these may take an optional leading URL to navigate first —
  // same convention as every other command, so a fresh agent needs no
  // separate navigation step before acting.
  if (targets[0] && isHttpUrl(targets[0])) {
    await client.goto(targets.shift() ?? '', { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  }

  if (client.url() === 'about:blank') {
    throw new Error('The tab is blank — nothing to interact with. Pass a URL, or open the page yourself first');
  }

  const before = await client.dom.interactiveSnapshot();

  if (!before) throw new Error('The page has no document to snapshot');
  const beforeKeys = new Set((before?.elements ?? []).map((e) => `${e.tag}|${e.id || ''}|${e.text || ''}`));
  const beforeUrl = before.url;
  let did = null;
  // Catch a full navigation started by the action (must be armed first);
  // SPAs change the DOM without one, which the post-action diff covers.
  const navPromise = client.page.waitForNavigation({ timeout: T.CLI_ACTION_TIMEOUT_MS }).catch(() => null);

  try {
    if (action === 'click') {
      const target = targets[0];
      if (!target) throw new Error('Usage: node cli.js click <selector|text=Text>');
      if (target.startsWith('text=')) {
        did = await client.dom.clickByText(target.slice(5));
        if (!did) throw new Error(`No visible element with text "${target.slice(5)}"`);
      } else {
        await client.dom.click(target, { timeout: T.CLI_ACTION_TIMEOUT_MS });
        did = { selector: target };
      }
    } else if (action === 'type' || action === 'fill') {
      let [sel, ...rest] = targets;
      // Forgive a single quoted "<selector> <text>" argument — agents type it.
      if (sel && rest.length === 0 && sel.includes(' ')) {
        const i = sel.indexOf(' ');
        rest = [sel.slice(i + 1)];
        sel = sel.slice(0, i);
      }
      if (!sel || rest.length === 0) throw new Error(`Usage: node cli.js ${action} [url] <selector> <${action === 'fill' ? 'value' : 'text'}>`);
      if (action === 'type') {
        // type appends to what is already in the field, so the expected value is before + typed
        const before = (await client.dom.getValue(sel).catch(() => '')) ?? '';
        await client.dom.type(sel, rest.join(' '), { timeout: T.CLI_ACTION_TIMEOUT_MS, delay: 30 });
        // Read back the actual value — the revive dance (occluded window)
        // steals focus, and stray human keystrokes can land beside ours.
        const actual = await client.dom.getValue(sel).catch(() => null);
        did = { selector: sel, typed: rest.join(' '), valueAfter: actual, valueMismatch: actual !== before + rest.join(' ') || undefined };
      } else {
        await client.dom.fill(sel, rest.join(' '));
        const actual = await client.dom.getValue(sel).catch(() => null);
        did = { selector: sel, value: rest.join(' '), valueAfter: actual, valueMismatch: actual !== rest.join(' ') || undefined };
      }
    } else if (action === 'press') {
      const key = targets[0];
      if (!key) throw new Error('Usage: node cli.js press <key> (Enter, Tab, Escape, ArrowDown, ...)');
      await client.dom.press(/** @type {import('puppeteer-core').KeyInput} */ (key));
      did = { key };
    }
  } catch (err) {
    // The action failed — do NOT debug the command; look at the DOM.
    // Surface the closest interactive elements so the next attempt uses
    // a selector that exists on the page as it is right now.
    const snap = await client.dom.interactiveSnapshot().catch(() => null);
    const suggestions = snap ? interactiveHints(snap.elements, { skipDisabled: true }) : [];
    const hint = suggestions.length ? `\nInteractive elements on the current page:\n  ${suggestions.join('\n  ')}` : '\n(no interactive elements found)';
    throw new Error(`${action} failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}${hint}`);
  }

  // Let the page react: a full navigation resolves navPromise; an SPA
  // mutation needs the dwell. Then a short settle before reading the DOM.
  const nav = await Promise.race([navPromise, new Promise((r) => setTimeout(() => r(null), 800))]);
  await new Promise((r) => setTimeout(r, nav ? 500 : 300));
  const after = await client.dom.interactiveSnapshot();
  if (!after) throw new Error('The page has no document to snapshot');
  const urlChanged = beforeUrl !== after.url ? { from: beforeUrl, to: after.url } : undefined;
  const afterKeys = after.elements.map((e) => `${e.tag}|${e.id || ''}|${e.text || ''}`);
  const added = afterKeys.filter((k) => !beforeKeys.has(k)).slice(0, 10);
  const removedCount = [...beforeKeys].filter((k) => !afterKeys.includes(k)).length;

  await emit({
    action,
    ...did,
    ok: true,
    urlChanged,
    readyState: after.readyState,
    // After a full navigation the element diff is meaningless (whole new
    // page) — the URL change is the signal; the diff only matters for SPAs.
    added: urlChanged ? undefined : added.map((k) => k.split('|').filter(Boolean).slice(0, 3).join(' ')),
    addedCount: urlChanged ? undefined : afterKeys.filter((k) => !beforeKeys.has(k)).length,
    removedCount: urlChanged ? undefined : removedCount,
    interactiveCount: after.count,
  }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdWait({ args, port, outFile }) {
  const client = (activeClient = await attach(port));
  let selector = args[1];
  if (!selector) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S]');
  if (isHttpUrl(selector)) {
    await client.goto(selector, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    selector = args[2];
    if (!selector) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S]');
  }
  const tIdx = args.indexOf('--timeout');
  const timeout = tIdx !== -1 ? Number(args[tIdx + 1]) * 1000 : T.CLI_ACTION_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S] — S must be seconds, e.g. --timeout 10');
  try {
    await client.page.waitForSelector(selector, { timeout, visible: true });
    const text = await client.dom.getText(selector).catch(() => null);
    await emit({ ok: true, selector, text: text ? String(text).slice(0, 80) : undefined }, outFile);
  } catch {
    // Timeout is a page-state answer, not a bug: say what IS there.
    const snap = await client.dom.interactiveSnapshot().catch(() => null);
    const lines = snap ? interactiveHints(snap.elements) : [];
    throw new Error(`"${selector}" did not appear within ${timeout / 1000}s. Interactive elements now:\n  ${lines.join('\n  ') || '(none)'}`);
  }
  await release(client);
}

async function main() {
  const argv = process.argv.slice(2);

  if (!argv[0] || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { positional: args, port, isJson, out: outFile, tab } = parseGlobalOptions(argv);
  tabIndex = tab;
  const command = args[0];
  const ctx = { command, args, port, isJson, outFile, tab };

  switch (command) {
    case 'start': await cmdStart(ctx); break;

    case 'markdown': await cmdMarkdown(ctx); break;

    case 'dump-forms': await cmdDumpForms(ctx); break;

    case 'dump-storage': await cmdDumpStorage(ctx); break;

    case 'listeners': await cmdListeners(ctx); break;

    case 'search-sources': await cmdSearchSources(ctx); break;

    case 'download-bundle': await cmdDownloadBundle(ctx); break;

    case 'deobfuscate': await cmdDeobfuscate(ctx); break;

    case 'unpack': await cmdUnpack(ctx); break;

    case 'ast-search': await cmdAstSearch(ctx); break;

    case 'traffic': await cmdTraffic(ctx); break;

    case 'eval': await cmdEval(ctx); break;

    case 'break': await cmdBreak(ctx); break;

    case 'close': await cmdClose(ctx); break;

    // ---- interaction loop: see, act, see again. Handlers live above (cmdSnapshot,
    // cmdInteract); every command below works on the live tab and leaves it open.

    case 'snapshot': await cmdSnapshot(ctx); break;

    case 'click':
    case 'type':
    case 'fill':
    case 'press': await cmdInteract(ctx); break;

    case 'tabs': await cmdTabs(ctx); break;
    case 'frames': await cmdFrames(ctx); break;
    case 'clean': await cmdClean(); break;
    case 'click-at': await cmdClickAt(ctx); break;
    case 'key': await cmdKey(ctx); break;
    case 'canvas': await cmdCanvas(ctx); break;
    case 'wait': await cmdWait(ctx); break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      throw new Error(`Unknown command: ${command}`);
  }
}

main()
  .catch((err) => {
    console.error(`[Error] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeClient) await release(activeClient);
  });
