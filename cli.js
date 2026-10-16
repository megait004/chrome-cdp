#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect, startChrome, waitUntil, checkCdpReady, DebugController } = require('./index');
const T = require('./src/timeouts');
const { spawn } = require('node:child_process');
const { recordSite, createRun, activeRun, indexSite } = require('./src/site-mirror');
const { messageOf } = require('./src/util');

let tabIndex = 0; // set from --tab; every command attaches to this tab

/**
 * Attaches to a Chrome that is already running on `port`. Never launches one:
 * a command must not open a browser on the user's profile unannounced. Use
 * `node cli.js start` for that.
 * @param {number} port
 * @returns {Promise<Client>}
 */
async function attach(port, /** @type {{ protocolTimeout?: number }} */ options = {}) {
  if (!(await checkCdpReady(port))) {
    throw new Error(`Chrome is not running on port ${port}. Start it with: node cli.js start`);
  }
  return connect({ port, autoLaunch: false, tab: tabIndex, ...options });
}

// A page blocked by a synchronous call cannot answer CDP, and the default wait is 30 s.
// Evals slower than 10 s fail here even if they would finish.
const EVAL_PROTOCOL_TIMEOUT_MS = 10000;


/**
 * @typedef {{ command: string, args: string[], port: number, isJson: boolean, outFile: string | null, tab: number }} Ctx
 */

/** @typedef {InstanceType<typeof import('./src/chrome-client')>} Client */

/** @type {Client | undefined} */
let activeClient;

/** @param {unknown} s */
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

const SLOW = Symbol('slow');

/**
 * A paused page never answers Runtime.evaluate, so a call still pending after 3 s is checked for a pause.
 * The caller then gets the stop point instead of a 30 s timeout.
 * @template T
 * @param {Promise<T>} work
 * @returns {Promise<T>}
 */
async function untilNotPaused(work) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SLOW), 3000);
  });
  const first = await Promise.race([work, slow]);
  clearTimeout(timer);
  if (first !== SLOW) return /** @type {T} */ (first);
  // A pause held by another live CLI command (its breakpoint is still waiting): name the stop point.
  const held = DebugController.readPauseMarker();
  if (held) throw new Error(`The page is paused in the debugger at ${held.url || held.scriptId}:${held.line} (${held.reason}), held by pid ${held.pid}. Resume it with: node cli.js resume`);
  return work;
}

const HELP_TEXT = `
Usage: node cli.js <command> [options] [arguments]

Commands:
  start                         Start Chrome with remote debugging on port 9222
  markdown [url] [destFile]     Extract article content as clean Markdown (GFM)
  dump-forms [url]              Audit all forms, methods, actions, and inputs (inc. hidden)
  dump-storage [url]            Dump localStorage, sessionStorage, and cookies (a URL navigates
                                there first; omit it to read the tab as it is)
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
  vm-scripts [url]              List scripts with no URL (created by eval/Function):
                                scriptId, start line, line count, and the first 100 characters
  find-function [url] <queryOrId> <name>
                                Lines where a function is defined ("function NAME(" or "NAME = function"),
                                each cut to 300 characters
  layout [url] [--wait S]       Record style, layout, pre-paint and paint for S seconds (default 5; interact
                                meanwhile) and report totals and the script location that caused each stage
  events [url]                  Every event listener registered on the window and the document tree
                                (and iframes), grouped by event type and handler location
  catch-script [url] [--min-bytes N] [--break-line N] [--break-col N] [--eval <expr>] [--frame N] [--timeout S]
                                Pause before a script runs, report the script and the stack, then (with
                                --break-line) stop inside that script, list the variables of the frame and of
                                its caller, and run --eval (--frame picks the frame, default 0). Reaches code
                                with no URL that the break command cannot name. --min-bytes skips small scripts
  profile [url] [--wait S]      CPU profile for S seconds (default 5; interact meanwhile): functions by
                                self time, with the two callers that called them most
  mirror start <url> [outDir]   Load the URL with the cache off and start recording in the
                                background: every request and response (raw headers, cookies
                                included), WebSocket frames, and bodies, until you stop it.
                                Lazy loads and API calls after your interaction are kept.
                                Writes outDir/<host>/<timestamp>/ (default .tmp/mirror)
  mirror stop [outDir]          Stop the active recording; writes cookies.json, storage.json,
                                rendered.html and manifest.json. LATEST names the newest run
  index-site <stampDir>         Unpack every JS file of a mirror run with webcrack, then run
                                scout's precise.mjs on the result (symbols, dead code, refs)
  traffic [url] [--bodies] [--wait S] [--headers]
                                Record network + WebSocket frames. With a URL: navigate,
                                wait for network idle, then for the first WS frame.
                                Without: attach to the live tab and record --wait S
                                (default 5) while the user interacts. --bodies drains
                                each response body into the result
  eval [url] <expression> [--frame U] [--file script.js]   (--file: read the expression from a file)
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
                                (ignored: Chrome resumes when the command exits),
                                --exceptions (also pause on exceptions),
                                --trigger <js> (run this JavaScript after arming, in the same
                                session: the action that loads the script goes here)
  goto <url>                    Navigate the tab to a URL and report the final url and title
  resume                        Resume the page if it is paused in the debugger (for example
                                after a breakpoint was left armed by another command)
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
  status                        Is Chrome reachable on --port, and is a mirror recording running?
  clean                         Delete the scratch folder .tmp/ inside the skill (this also deletes
                                mirror runs and anything else under .tmp/; copy what you need first)
  click-at <x> <y> [--frame U] [--canvas] [--button left|right|middle]  Mouse click. --canvas: x/y are canvas-relative (offset added). With --frame, coordinates are
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
 * Writes the JSON result to stdout, or to `--out <file>`. A file keeps large output out of the agent's context.
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
 * Short `tag#id "text"` lines for error hints, shared by the click and wait failure paths.
 * @param {import('./src/types/snapshot').SnapshotElement[]} elements result of interactiveSnapshot()
 * @param {{ limit?: number, skipDisabled?: boolean }} [options]
 * @returns {string[]}
 */
function interactiveHints(elements, { limit = 8, skipDisabled = false } = {}) {
  return elements
    .filter((e) => !skipDisabled || !e.disabled)
    .slice(0, limit)
    // name is shown as an attribute selector when there is no id, so the hint can be used as a selector.
    .map((e) => `${e.tag}${e.id ? '#' + e.id : e.name ? '[name="' + e.name + '"]' : ''}${e.text ? ' "' + e.text.slice(0, 30) + '"' : ''}`);
}

/**
 * Detaches without closing the tab: logins, SPA routes and WebSocket sessions must survive between commands.
 * Use `close` for cleanup.
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
  const url = isHttpUrl(args[1]) ? args[1] : null;
  const selArg = url ? args[2] : args[1];
  const selector = selArg && !selArg.startsWith('--') ? selArg : 'window';

  const client = (activeClient = await attach(port));
  if (url) await client.goto(url);

  const listeners = await client.dom.getEventListeners(selector);
  await emit({ url: url || client.url(), target: selector, listeners }, outFile);

  await release(client);
}

const { createBundleCommands } = require('./src/commands/bundles');

// Commands over loaded scripts live in src/commands/bundles.js; they share this file's attach and output helpers.
const bundles = createBundleCommands({
  attach: async (port) => {
    const client = await attach(port);
    activeClient = client;
    return client;
  },
  emit,
  release,
  isHttpUrl,
  T,
});
const { cmdSearchSources, cmdDownloadBundle, cmdDeobfuscate, cmdUnpack, cmdAstSearch, cmdVmScripts, cmdFindFunction } = bundles;

const { createLayoutCommands } = require('./src/commands/layout');
const { cmdLayout } = createLayoutCommands({
  attach: async (port) => {
    const client = await attach(port);
    activeClient = client;
    return client;
  },
  emit,
  release,
  isHttpUrl,
  T,
});

const { createRuntimeCommands } = require('./src/commands/runtime');
const { createRevealCommands } = require('./src/commands/reveal');
const { cmdCatchScript } = createRevealCommands({
  attach: async (port) => {
    const client = await attach(port);
    activeClient = client;
    return client;
  },
  emit,
  release,
  isHttpUrl,
  T,
});
const { cmdEvents, cmdProfile } = createRuntimeCommands({
  attach: async (port) => {
    const client = await attach(port);
    activeClient = client;
    return client;
  },
  emit,
  release,
  isHttpUrl,
  T,
});

/**
 * `mirror start <url>` starts a detached recorder that keeps running while you interact with the tab;
 * `mirror stop` ends it. Everything loaded in between is kept, including lazy loads.
 * @param {Ctx} ctx
 */
async function cmdMirror({ args, port, tab }) {
  const sub = args[1];
  const outRoot = (/** @type {string | undefined} */ dir) => path.resolve(dir || path.join(__dirname, '.tmp', 'mirror'));

  if (sub === 'stop') {
    const dir = activeRun(outRoot(args[2]));
    if (!dir) throw new Error('No active recording. Start one with: node cli.js mirror start <url>');
    fs.writeFileSync(path.join(dir, 'STOP'), '');
    await waitUntil(() => fs.existsSync(path.join(dir, 'manifest.json')), { timeout: 120000, every: 500 });
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error(`Recorder did not finish. See ${dir}/recorder.log`);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    console.log(`Stopped. ${m.files.length} resources saved, ${m.failed.length} failed, ${m.redirects} redirects -> ${dir}`);
    if (m.navigationError) console.log(`Navigation failed: ${m.navigationError}. The recording holds only what the tab loaded after that.`);
    return;
  }

  if (sub !== 'start' || !isHttpUrl(args[2])) {
    throw new Error('Usage: node cli.js mirror start <url> [outDir]  |  node cli.js mirror stop [outDir]');
  }
  const url = args[2];
  const root = outRoot(args[3]);
  const busy = activeRun(root);
  if (busy) throw new Error(`Already recording into ${busy}. Stop it first: node cli.js mirror stop`);
  if (!(await checkCdpReady(port))) throw new Error(`Chrome is not running on port ${port}. Start it with: node cli.js start`);

  const runDir = createRun(root, url);
  const logFd = fs.openSync(path.join(runDir, 'recorder.log'), 'a');
  const child = spawn(process.execPath, [__filename, 'mirror-run', url, runDir, '--port', String(port), '--tab', String(tab)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(runDir, 'recorder.pid'), String(child.pid));

  await waitUntil(() => fs.existsSync(path.join(runDir, 'READY')), { timeout: 30000, every: 200 });
  if (!fs.existsSync(path.join(runDir, 'READY'))) throw new Error(`Recorder did not start. See ${runDir}/recorder.log`);
  console.log(`Recording ${url} -> ${runDir}\nInteract with the tab now. Stop with: node cli.js mirror stop`);
}

/** Hidden: the detached recorder that `mirror start` spawns. */
/** @param {Ctx} ctx */
async function cmdMirrorRun({ args, port }) {
  const [, url, runDir] = args;
  try {
    const client = (activeClient = await attach(port));
    await recordSite(client, url, runDir);
  } catch (err) {
    fs.appendFileSync(path.join(runDir, 'recorder.log'), `fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  }
  process.exit(0);
}

/** @param {Ctx} ctx */
async function cmdIndexSite({ args }) {
  if (!args[1]) throw new Error('Usage: node cli.js index-site <stampDir>  (a run folder written by mirror)');
  const r = await indexSite(path.resolve(args[1]));
  console.log(`Unpacked ${r.jsFiles - r.errors.length}/${r.jsFiles} JS files -> ${r.unpacked}`);
  console.log(`Scout index -> ${r.scoutOut}`);
  for (const e of r.errors) console.log(`  unpack failed: ${e.file}: ${e.error}`);
}

/**
 * Records the traffic: a load of `url` (waits for network idle), or the live tab for a time window.
 * @param {Client} client
 * @param {string | null} url
 * @param {number | null} waitSecs
 */
async function captureTraffic(client, url, waitSecs) {
  if (!url) {
    // Live-tab capture: recording started at connect(); give the user
    // --wait seconds (default 5) to click around while we listen.
    await new Promise((r) => setTimeout(r, (waitSecs ?? T.CLI_DEFAULT_WAIT_S) * 1000));
    return;
  }
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
}

/**
 * Adds each entry's body (and parsed JSON when the payload is one). XHR, Fetch and Document go first,
 * since Chrome evicts those soonest. Hops, 204 beacons and some binaries have no body: they get a
 * `(...)` note instead of a silent null.
 * @param {Client} client
 * @param {Array<import('./src/network-controller').TrafficEntry>} httpTraffic
 */
async function withBodies(client, httpTraffic) {
  /** @type {(res: unknown) => { body: unknown, parsedJson?: unknown }} */
  const extract = (res) => (res && typeof res === 'object' && 'body' in res
    ? { body: res.body, parsedJson: 'parsedJson' in res ? res.parsedJson : undefined }
    : { body: res });
  const prioritized = [...httpTraffic].sort((a, b) =>
    Number(/^(XHR|Fetch|Document)$/.test(b.resourceType)) - Number(/^(XHR|Fetch|Document)$/.test(a.resourceType)));
  return Promise.all(prioritized.map(async (t) => {
    const { body, parsedJson } = extract(
      await client.network.getResponseBody(t.id).catch((/** @type {unknown} */ err) => `(${messageOf(err).slice(0, 80)})`));
    return { ...t, body, ...(parsedJson ? { parsedJson } : {}) };
  }));
}

/**
 * @param {Array<import('./src/network-controller').TrafficEntry>} httpTraffic
 * @param {import('./src/types/websocket').WsSocket[]} wsSockets
 * @param {string} finalUrl
 * @param {boolean} showHeaders
 */
function printTraffic(httpTraffic, wsSockets, finalUrl, showHeaders) {
  console.log(`\n=== HTTP Requests (${httpTraffic.length}) === (final URL: ${finalUrl})`);
  httpTraffic.forEach((t) => {
    console.log(`[${t.method || 'GET'}] ${t.status || '...'} ${t.url} (${t.resourceType})`);
    if (showHeaders) {
      for (const [name, value] of Object.entries(t.headers || {})) console.log(`    > ${name}: ${value}`);
      // A header sent twice (Set-Cookie) is joined with newlines by CDP: print each value on its own line, with the name.
      for (const [name, value] of Object.entries(t.rawResponseHeaders || t.responseHeaders || {})) {
        for (const line of String(value).split('\n')) console.log(`    < ${name}: ${line}`);
      }
    }
  });

  console.log(`\n=== WebSocket Connections (${wsSockets.length}) ===`);
  wsSockets.forEach((s) => {
    console.log(`[WS] ${s.url} - State: ${s.state}, Frames: ${s.frames.length}`);
  });
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
  const waitIdx = args.indexOf('--wait');
  let waitSecs = null;
  if (waitIdx !== -1) {
    waitSecs = Number(args[waitIdx + 1]);
    if (!Number.isFinite(waitSecs) || waitSecs < 0) throw new Error('--wait expects seconds, e.g. --wait 5');
  }

  const client = (activeClient = await attach(port));
  client.network.clear();
  client.websocket.clear();
  await captureTraffic(client, url, waitSecs);

  const httpTraffic = client.network.getTraffic();
  const wsSockets = client.websocket.getSockets();
  /** @type {{ finalUrl: string, mode: string, httpTraffic: Array<import('./src/network-controller').TrafficEntry & { body?: unknown, parsedJson?: unknown }>, wsSockets: import('./src/types/websocket').WsSocket[], note?: string }} */
  const result = { finalUrl: client.url(), mode: url ? 'load' : 'live', httpTraffic, wsSockets };
  if (!url && wsSockets.some((s) => !s.url)) {
    result.note = 'socket(s) with no URL were opened before this attach — the handshake was missed, but their frames still flow';
  } else if (!url && wsSockets.length === 0) {
    result.note = 'no frames arrived in this window; a WebSocket opened before attach becomes visible only once it sends a frame — rerun with a longer --wait';
  }
  // Read bodies now, while Chrome still holds them.
  if (args.includes('--bodies')) result.httpTraffic = await withBodies(client, httpTraffic);

  if (isJson || outFile) {
    await emit(result, outFile);
  } else {
    printTraffic(httpTraffic, wsSockets, result.finalUrl, args.includes('--headers'));
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdEval({ args, port }) {
  const frame = takeFlag(args, '--frame');
  // --file reads the expression from a file: no shell quoting of regexes, quotes or newlines.
  const file = takeFlag(args, '--file');
  const first = args[1];
  const navigates = first && isHttpUrl(first);
  const expression = file ? fs.readFileSync(file, 'utf8') : (navigates ? args.slice(2) : args.slice(1)).join(' ');
  if (!expression.trim()) {
    throw new Error('Usage: node cli.js eval [url] <expression> [--frame <url part>] [--file <script.js>] — pass a URL to navigate first, or omit it to evaluate on the current tab');
  }

  const client = (activeClient = await attach(port, { protocolTimeout: EVAL_PROTOCOL_TIMEOUT_MS }));
  if (navigates) await client.goto(first);
  if (frame) await waitForFrame(client, frame);
  const result = await untilNotPaused(frame ? client.visual.frame(frame).evaluate(expression) : client.evaluate(expression));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));

  // Tab stays open — follow-up commands and evals inherit the page state.
  await release(client);
}

/**
 * Reads `break [url] <scriptQuery> <line> [flags]`. The leading URL is optional: it navigates first.
 * @param {string[]} args
 */
function parseBreakArgs(args) {
  const raw = args.slice(1);
  const url = raw[0] && isHttpUrl(raw[0]) ? raw.shift() : null;
  /** @type {{ col: number, condition: string | null, evalExpr: string | null, timeoutS: number, hold: boolean, pauseExc: boolean, trigger: string | null }} */
  const opts = { col: 0, condition: null, evalExpr: null, timeoutS: 15, hold: false, pauseExc: false, trigger: null };
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--col') opts.col = Number(raw[++i]);
    else if (a === '--condition') opts.condition = raw[++i];
    else if (a === '--eval') opts.evalExpr = raw[++i];
    else if (a === '--timeout') opts.timeoutS = Number(raw[++i]);
    else if (a === '--hold') opts.hold = true;
    else if (a === '--exceptions') opts.pauseExc = true;
    else if (a === '--trigger') opts.trigger = raw[++i];
    else pos.push(a);
  }
  const [scriptQuery, lineStr] = pos;
  if (!scriptQuery || lineStr === undefined) {
    throw new Error('Usage: node cli.js break [url] <scriptQuery> <line> [--col N] [--condition expr] [--eval expr] [--trigger js] [--timeout S] [--hold] [--exceptions]');
  }
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 0) throw new Error(`Invalid line: ${lineStr} (0-based, so UI line minus 1)`);
  if (!Number.isFinite(opts.col) || opts.col < 0) throw new Error(`Invalid --col: ${raw[raw.indexOf('--col') + 1]}`);
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) throw new Error('--timeout expects seconds, e.g. --timeout 20');
  return { url, scriptQuery, line, ...opts };
}

/**
 * Sets the breakpoint on the script the query names. The line is given script-relative, as the agent reads it.
 * @param {Client} client
 * @param {string} scriptQuery a scriptId (all digits), or a URL or URL substring
 * @param {number} line
 * @param {number} col
 * @param {string | null} condition
 */
async function setScriptBreakpoint(client, scriptQuery, line, col, condition) {
  // A bare number is a scriptId: the only way to break inside a script with no URL (eval, Function, a
  // decoded payload). URL matching cannot name such a script.
  if (/^\d+$/.test(scriptQuery)) {
    const result = await client.debug.setBreakpointAtLocation(scriptQuery, line, col, condition || undefined);
    return { bp: { breakpointId: result.breakpointId, locations: [result.actualLocation] }, targetUrl: `scriptId ${scriptQuery}`, matchedScripts: 1 };
  }
  // Resolve the query to a concrete script URL when possible: exact URLs resolve breakpoints immediately
  // (locations[] non-empty); an unmatched pattern still registers a logical breakpoint that fires on future loads.
  const known = client.sources.getScripts({ url: scriptQuery });
  const targetUrl = known.length ? known[0].url : scriptQuery;
  // setBreakpointByUrl counts lines from the top of the document, but the agent reads script-relative lines.
  // Inline scripts have startLine > 0, so the offset is added; external .js files have startLine 0.
  const startLine = known.length ? (known[0].startLine || 0) : 0;
  // An exact URL is the only form setBreakpointByUrl matches on, so an unresolved query becomes a substring regex.
  const bp = known.length
    ? await client.debug.setBreakpoint(targetUrl, line + startLine, col, condition || undefined)
    : await client.debug.setBreakpointForUrlContaining(scriptQuery, line, condition || undefined, col);
  return { bp, targetUrl, matchedScripts: known.length };
}

/**
 * Resolves with the next pause, or null after `timeoutS` seconds.
 * @param {Client} client
 * @param {number} timeoutS
 */
function waitForPause(client, timeoutS) {
  return new Promise((resolve) => {
    if (client.debug.paused) return resolve(client.debug.paused);
    const onP = (/** @type {unknown} */ ev) => { clearTimeout(to); resolve(ev); };
    const to = setTimeout(() => { client.debug.off('paused', onP); resolve(null); }, timeoutS * 1000);
    client.debug.once('paused', onP);
  });
}

/**
 * The call stack of a pause, with each frame's URL resolved through its scriptId.
 * @param {Client} client
 * @param {{ callFrames?: Array<import('devtools-protocol').Protocol.Debugger.CallFrame> }} hit
 */
function describeFrames(client, hit) {
  // CallFrame.url is deprecated: resolve the script through location.scriptId instead.
  const urlByScriptId = new Map(client.sources.getScripts().map((s) => [s.scriptId, s.url]));
  return (hit.callFrames || []).map((f) => ({
    callFrameId: f.callFrameId,
    functionName: f.functionName || '(anonymous)',
    scriptId: f.location?.scriptId,
    url: (f.location?.scriptId && urlByScriptId.get(f.location.scriptId)) || '',
    lineNumber: f.location?.lineNumber,
    columnNumber: f.location?.columnNumber,
    scopeTypes: (f.scopeChain || []).map((s) => s.type),
  }));
}

/**
 * Evaluates `expr` in the paused top frame. A failure is returned as `{ error }`, not thrown.
 * @param {Client} client
 * @param {string} callFrameId
 * @param {string} expr
 */
async function evaluateOnTop(client, callFrameId, expr) {
  try {
    return await client.debug.evaluateOnCallFrame(callFrameId, expr);
  } catch (err) {
    return { error: messageOf(err).split('\n')[0] };
  }
}

/**
 * One-shot breakpoint: set it, wait for the hit, capture the stack, optionally evaluate on the top frame, then resume.
 * The page is frozen while paused, so resume runs even on error. The CDP session ends with this command, and
 * Chrome resumes any page still paused when it detaches; --hold cannot keep a pause past the command.
 * Multi-step debugging does not survive across CLI calls (each call opens a new CDP session); write a .tmp/ script
 * against client.debug for that (references/api.md).
 * @param {Ctx} ctx
 */
async function cmdBreak({ args, port, outFile }) {
  const o = parseBreakArgs(args);
  const client = (activeClient = await attach(port));
  if (o.url) await client.goto(o.url);
  await client.debug.enable({ pauseOnExceptions: o.pauseExc });
  const { bp, targetUrl, matchedScripts } = await setScriptBreakpoint(client, o.scriptQuery, o.line, o.col, o.condition);

  // Runs the action in this same session, so the pause lands on this breakpoint. Not awaited: the page
  // may pause inside the action's own script, and this call would then never return.
  if (o.trigger) client.evaluate(o.trigger).catch((/** @type {unknown} */ err) => console.error(`trigger failed: ${messageOf(err)}`));

  const hit = await waitForPause(client, o.timeoutS);
  const base = { breakpointId: bp.breakpointId, targetUrl, line: o.line, column: o.col, locations: bp.locations, matchedScripts };
  let evalResult = null;
  try {
    if (!hit) {
      const why = bp.locations?.length
        ? `The line resolved to ${bp.locations.length} location(s) but did not run in that window.`
        : matchedScripts
          ? `Line ${o.line} has no code to pause on in the matched script (a blank or comment line, or a line the page never reaches).`
          : `No loaded script matched "${o.scriptQuery}", so nothing could pause.`;
      await emit({
        ...base,
        hit: false,
        note: `no pause within ${o.timeoutS}s. ${why} The breakpoint lives only inside this command and is removed when it exits. Run the action in the same command with --trigger "<js>", e.g. --trigger "document.getElementById('lazy').click()".`,
      }, outFile);
    } else {
      const frames = describeFrames(client, hit);
      if (o.evalExpr && frames.length) evalResult = await evaluateOnTop(client, frames[0].callFrameId, o.evalExpr);
      await emit({
        ...base,
        hit: true,
        reason: hit.reason,
        hitBreakpoints: hit.hitBreakpoints || [],
        callFrames: frames,
        ...(evalResult !== null ? { eval: evalResult } : {}),
        resumed: true,
      }, outFile);
    }
  } finally {
    try { await client.debug.resume(); } catch {}
    if (o.hold) console.error('[warn] --hold does not keep the page paused after this command exits: the page was resumed. Put the action in the same command with --trigger.');
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

/**
 * Canvases and interactive elements of one frame. A frame removed mid-scan yields nothing.
 * @param {Client} client
 * @param {import('puppeteer-core').Frame} frame
 */
async function scanFrame(client, frame) {
  if (frame.detached) return { canvases: [], elements: [] };
  /** @type {string[]} */
  const errors = [];
  const canvases = await frame.evaluate(() => [...document.querySelectorAll('canvas')]
    .map((c, i) => ({ index: i, width: c.width, height: c.height, id: c.id || undefined }))).catch((err) => { errors.push(`canvases: ${messageOf(err)}`); return []; });
  const elements = await client.dom.interactiveSnapshot(undefined, frame).then((s) => s?.elements ?? []).catch((err) => { errors.push(`elements: ${messageOf(err)}`); return []; });
  return { canvases, elements, error: errors.join("; ") || undefined };
}

/** @param {Client} client */
async function frameSnapshots(client) {
  const scans = await Promise.all(client.visual.frames().map(async (frame, index) => ({ index, frame, ...(await scanFrame(client, frame)) })));
  return scans
    .filter(({ canvases, elements }) => canvases.length || elements.length)
    .map(({ index, frame, canvases, elements }) => ({ frame: index, url: frame.url(), canvases, elements }));
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

// Canvas and raw input: games draw on <canvas> inside iframes, so there are no selectors.
// Use `snapshot` for each frame's URL and canvas index, then act by coordinates.
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
  const rows = await Promise.all(pages.map(async (page, index) => ({ tab: index, url: page.url(), title: await page.title().catch(() => ''), active: index === tabIndex })));
  await emit(rows, null);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdFrames({ port }) {
  const client = (activeClient = await attach(port));
  const rows = await Promise.all(client.visual.frames().map(async (frame, index) => {
    const scan = await scanFrame(client, frame);
    // canvasSizes is the canvas's own pixel size (width x height attributes), not its CSS size; game code
    // that sizes its view from these numbers reads the same values.
    return { frame: index, canvases: scan.canvases.length, canvasSizes: scan.canvases.map((c) => `${c.width}x${c.height}`), elements: scan.elements.length, url: frame.url().slice(0, 120), error: scan.error };
  }));
  await emit(rows, null);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdStatus({ port }) {
  if (await checkCdpReady(port)) {
    console.log(`Chrome: running on port ${port}`);
    // Where the tab is and whether a command holds a pause, so a stalled run can be checked without a new action.
    const client = (activeClient = await attach(port));
    console.log(`Tab: ${client.url()} | ${await client.title()}`);
    console.log(`Frames: ${client.visual.frames().length} | Paused: ${DebugController.readPauseMarker() ? 'yes (node cli.js resume)' : 'no'}`);
    await release(client);
  } else {
    console.log(`Chrome: not running on port ${port} (start it with: node cli.js start)`);
  }
  const recording = activeRun(path.join(__dirname, '.tmp', 'mirror'));
  if (!recording) {
    console.log('Mirror recording: none');
    return;
  }
  // Progress without touching the recorder: responses saved so far, and how long since the last write.
  const log = path.join(recording, 'requests.jsonl');
  const saved = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"kind":"response"')).length : 0;
  const idle = fs.existsSync(log) ? ((Date.now() - fs.statSync(log).mtimeMs) / 1000).toFixed(1) : '?';
  console.log(`Mirror recording: ${recording} (${saved} responses saved, last write ${idle}s ago)`);
}

async function cmdClean() {
  const dir = path.join(__dirname, '.tmp');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}

/** @param {Ctx} ctx */
async function cmdClickAt({ args, port }) {
  const frame = takeFlag(args, '--frame');
  // --button right is needed for games that move the player with the right mouse button.
  const button = takeFlag(args, '--button') ?? 'left';
  if (!['left', 'middle', 'right'].includes(button)) throw new Error(`--button must be left, middle or right (got "${button}")`);
  // --canvas: x/y are canvas-relative; the tool adds the canvas's offset inside its iframe (often nonzero).
  const canvasRelative = args.includes('--canvas');
  args.splice(0, args.length, ...args.filter((a) => a !== '--canvas'));
  const [x0, y0] = args.slice(1).map(Number);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) throw new Error('click-at expects two numbers: click-at <x> <y> [--frame <url part>] [--canvas]');
  if (canvasRelative && !frame) throw new Error('--canvas needs --frame <url part> (the canvas lives in that iframe)');
  const client = (activeClient = await attach(port));
  let x = x0, y = y0;
  if (canvasRelative && frame) {
    await waitForFrame(client, frame);
    const off = await client.visual.frame(frame).evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    if (!off) throw new Error(`No <canvas> in frame "${frame}"`);
    x += off.x;
    y += off.y;
  }
  await client.visual.click(x, y, { frame: frame ?? undefined, button: /** @type {'left' | 'middle' | 'right'} */ (button) });
  await emit({ ok: true, action: 'click-at', x: x0, y: y0, button, frame: frame ?? null, canvas: canvasRelative }, null);
  await release(client);
}

/** Waits until a child frame whose URL contains `frame` exists: iframes appear after goto, so a first call can miss them. */
/** @param {Client} client @param {string | null} frame */
async function waitForFrame(client, frame) {
  if (!frame || /^\d+$/.test(frame)) return; // an index is used as-is: it does not wait
  const found = await waitUntil(() => client.visual.frames().some((f) => f.url().includes(frame)), { timeout: T.CLI_NAV_TIMEOUT_MS });
  if (!found) {
    const seen = client.visual.frames().map((f) => f.url().slice(0, 100)).join('\n  ');
    throw new Error(`Waited ${T.CLI_NAV_TIMEOUT_MS / 1000}s for a frame whose URL contains "${frame}". Frames seen:\n  ${seen}`);
  }
}

/** @param {Ctx} ctx */
async function cmdKey({ args, port }) {
  const hold = takeFlag(args, '--hold');
  const code = args[1];
  if (!code) throw new Error('key expects a KeyboardEvent.code: key <KeyW|Space|ArrowLeft> [--hold MS]');
  // Keys go to the focused element, not to a frame: a leftover flag would be silently ignored, so refuse it.
  const stray = args.slice(2).find((a) => a.startsWith('--'));
  if (stray) throw new Error(`key takes no ${stray}. Keys go to the focused element: click the game first, then key <code> [--hold MS]`);
  const holdMs = hold === null ? 0 : Number(hold);
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error('--hold expects milliseconds, e.g. --hold 300');
  const client = (activeClient = await attach(port));
  await client.visual.key(code, { holdMs });
  await emit({ ok: true, action: 'key', code, holdMs }, null);
  await release(client);
}

/**
 * Reads a frame's canvas size until two samples one second apart agree. A game sets its canvas size
 * after load (and after a preserve reload), so one early sample can report the wrong size.
 * @param {Client} client @param {string} frame @param {number} index
 */
async function waitForStableCanvas(client, frame, index) {
  const sample = () => client.visual.frame(frame).evaluate((i) => {
    const c = document.querySelectorAll('canvas')[i];
    return c ? `${c.width}x${c.height}` : '';
  }, index);
  let previous = await sample();
  return waitUntil(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await sample();
    const stable = Boolean(current) && current === previous;
    previous = current;
    return stable;
  }, { timeout: T.CLI_NAV_TIMEOUT_MS, every: 0 }); // false on timeout: no canvas, or a size that never held
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
  }
  const canvasIndex = index === null ? 0 : Number(index);
  if (frame) {
    await waitForFrame(client, frame);
    if (!(await waitForStableCanvas(client, frame, canvasIndex))) {
      throw new Error(`frame "${frame}" has no settled canvas ${canvasIndex} after ${T.CLI_NAV_TIMEOUT_MS / 1000}s. It may still be loading or not have a canvas: run frames and check the canvases count.`);
    }
  }
  const { width, height, dataUrl } = await client.visual.canvas({ frame: frame ?? undefined, index: canvasIndex });
  // Say which document was read: a canvas in the main page and one in the game iframe are different things.
  const owner = frame ? client.visual.frame(frame).url() : 'main page';
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`Saved ${width}x${height} PNG to: ${abs} (from ${owner})`);
  } else {
    console.log(`canvas ${width}x${height} from ${owner} (pass --out file.png to save the pixels)`);
  }
  await release(client);
}

/** @typedef {NonNullable<Awaited<ReturnType<Client['dom']['interactiveSnapshot']>>>} Snapshot */

/** @param {Snapshot} snap */
function elementKeys(snap) {
  return snap.elements.map((e) => `${e.tag}|${e.id || ''}|${e.text || ''}`);
}

/**
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function diffSnapshots(before, after) {
  const beforeKeys = new Set(elementKeys(before));
  const afterKeys = elementKeys(after);
  const urlChanged = before.url !== after.url ? { from: before.url, to: after.url } : undefined;
  const addedAll = afterKeys.filter((k) => !beforeKeys.has(k));
  const removedCount = [...beforeKeys].filter((k) => !afterKeys.includes(k)).length;
  // changed: the element list or URL moved. False does not prove nothing changed: canvas drawing and
  // text-only updates are invisible to this diff. valueMismatch is a failure signal, not a change, so it is excluded.
  const changed = Boolean(urlChanged) || addedAll.length > 0 || removedCount > 0;
  return { urlChanged, changed, added: addedAll.slice(0, 10), addedCount: addedAll.length, removedCount };
}

/**
 * `click <selector>` or `click text=<Text>`. A checkbox or radio reports the state it ended in.
 * @param {Client} client
 * @param {string | undefined} target
 */
async function clickTarget(client, target) {
  if (!target) throw new Error('Usage: node cli.js click <selector|text=Text>');
  if (target.startsWith('text=')) {
    const text = target.slice(5);
    const did = await client.dom.clickByText(text);
    if (!did) throw new Error(`No visible element with text "${text}"`);
    return did;
  }
  await client.dom.click(target, { timeout: T.CLI_ACTION_TIMEOUT_MS });
  // A checkbox or radio click reports nothing else, so say what state it ended in (undefined for other elements).
  const checked = await client.page.$eval(target, (el) => (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined)).catch(() => undefined);
  return { selector: target, checked };
}

/**
 * `type` appends to the field, `fill` replaces it. Either way the value is read back, because the
 * occluded-window revive steals focus and stray human keystrokes can land beside ours.
 * @param {Client} client
 * @param {'type' | 'fill'} action
 * @param {string[]} targets
 */
async function typeOrFill(client, action, targets) {
  let [sel, ...rest] = targets;
  // Forgive a single quoted "<selector> <text>" argument — agents type it.
  if (sel && rest.length === 0 && sel.includes(' ')) {
    const i = sel.indexOf(' ');
    rest = [sel.slice(i + 1)];
    sel = sel.slice(0, i);
  }
  if (!sel || rest.length === 0) throw new Error(`Usage: node cli.js ${action} [url] <selector> <${action === 'fill' ? 'value' : 'text'}>`);
  const text = rest.join(' ');
  if (action === 'type') {
    const before = (await client.dom.getValue(sel).catch(() => '')) ?? '';
    await client.dom.type(sel, text, { timeout: T.CLI_ACTION_TIMEOUT_MS, delay: 30 });
    const actual = await client.dom.getValue(sel).catch(() => null);
    return { selector: sel, typed: text, valueAfter: actual, valueMismatch: actual !== before + text || undefined };
  }
  await client.dom.fill(sel, text);
  const actual = await client.dom.getValue(sel).catch(() => null);
  return { selector: sel, value: text, valueAfter: actual, valueMismatch: actual !== text || undefined };
}

/**
 * Runs one action on the live tab and returns its result fields. Unknown actions do nothing.
 * @param {Client} client
 * @param {string} action
 * @param {string[]} targets
 */
async function performAction(client, action, targets) {
  if (action === 'click') return clickTarget(client, targets[0]);
  if (action === 'type' || action === 'fill') return typeOrFill(client, action, targets);
  if (action === 'press') {
    const key = targets[0];
    if (!key) throw new Error('Usage: node cli.js press <key> (Enter, Tab, Escape, ArrowDown, ...)');
    await client.dom.press(/** @type {import('puppeteer-core').KeyInput} */ (key));
    return { key };
  }
  return null;
}

/**
 * Interaction loop. Each action works on the live tab, returns the DOM change, and never navigates unless
 * a leading URL is given.
 * @param {Ctx} ctx
 */
async function cmdInteract(ctx) {
  const { args, port, outFile, command: action } = ctx;
  const client = (activeClient = await attach(port));
  const targets = args.slice(1).filter((a) => !a.startsWith('--'));

  // An optional leading URL navigates first, as in every other command.
  if (targets[0] && isHttpUrl(targets[0])) {
    await client.goto(targets.shift() ?? '', { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  }

  if (client.url() === 'about:blank') {
    throw new Error('The tab is blank — nothing to interact with. Pass a URL, or open the page yourself first');
  }

  const before = await client.dom.interactiveSnapshot();
  if (!before) throw new Error('The page has no document to snapshot');
  // Catch a full navigation started by the action (must be armed first);
  // SPAs change the DOM without one, which the post-action diff covers.
  const navPromise = client.page.waitForNavigation({ timeout: T.CLI_ACTION_TIMEOUT_MS }).catch(() => null);

  let did = null;
  try {
    did = await performAction(client, action, targets);
  } catch (err) {
    // The action failed. Show the closest interactive elements, so the next try uses a selector that exists now.
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
  const d = diffSnapshots(before, after);

  await emit({
    action,
    ...did,
    ok: true,
    changed: d.changed,
    urlChanged: d.urlChanged,
    readyState: after.readyState,
    // After a full navigation the element diff is meaningless (whole new
    // page) — the URL change is the signal; the diff only matters for SPAs.
    added: d.urlChanged ? undefined : d.added.map((k) => k.split('|').filter(Boolean).slice(0, 3).join(' ')),
    addedCount: d.urlChanged ? undefined : d.addedCount,
    removedCount: d.urlChanged ? undefined : d.removedCount,
    interactiveCount: after.count,
  }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdWait({ args, port, outFile, isJson }) {
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
    await emit({ ok: true, selector, waitedSeconds: timeout / 1000, text: text ? String(text).slice(0, 80) : undefined }, outFile);
  } catch {
    // Timeout is a page-state answer, not a bug: say what IS there.
    const snap = await client.dom.interactiveSnapshot().catch(() => null);
    const lines = snap ? interactiveHints(snap.elements) : [];
    // Say why it failed: a missing element and an element that exists but has no size are different fixes.
    const state = await client.page.evaluate((/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { exists: true, width: Math.round(r.width), height: Math.round(r.height), display: cs.display, visibility: cs.visibility };
    }, selector).catch(() => null);
    let reason = 'not-visible-in-time';
    let why = `"${selector}" did not become visible.`;
    if (state && !state.exists) {
      reason = 'missing';
      why = `No element matches "${selector}".`;
    } else if (state?.exists) {
      reason = 'exists-not-visible';
      why = `"${selector}" exists but is not visible (${state.width}x${state.height}px, display: ${state.display}, visibility: ${state.visibility}). wait needs a visible element.`;
    }
    const waited = timeout / 1000;
    if (isJson) {
      // Machine-readable failure: the same facts as the message, in fields an agent can branch on.
      await emit({ ok: false, selector, reason, waitedSeconds: waited, state, interactive: lines }, outFile);
      process.exitCode = 1;
      await release(client);
      return;
    }
    throw new Error(`${why} Waited ${waited}s. Interactive elements now:\n  ${lines.join('\n  ') || '(none)'}`);
  }
  await release(client);
}

/** `goto <url>`: navigate the tab and report where it landed. Same as `eval <url> <expr>`, named for what agents look for. @param {Ctx} ctx */
async function cmdGoto({ args, port }) {
  const url = args[1];
  if (!isHttpUrl(url)) throw new Error('Usage: node cli.js goto <http(s) url>');
  const client = (activeClient = await attach(port));
  await client.goto(url, { waitUntil: 'load', timeout: T.CLI_NAV_TIMEOUT_MS });
  console.log(JSON.stringify({ url: client.url(), title: await client.title() }, null, 2));
  await release(client);
}

/** Resumes the page if a live CLI command holds a pause on it. @param {Ctx} ctx */
async function cmdResume({ port }) {
  const held = DebugController.readPauseMarker();
  if (!held) {
    console.log('The page is not paused.');
    return;
  }
  const client = (activeClient = await attach(port));
  await client.cdp.send('Debugger.enable').catch(() => {});
  await client.cdp.send('Debugger.resume');
  DebugController.clearPauseMarker({ force: true });
  console.log(`Resumed. It was paused at ${held.url || held.scriptId}:${held.line} (${held.reason}), held by pid ${held.pid}.`);
  await release(client);
}

const ACTION_COMMANDS = new Set(['click', 'type', 'fill', 'press', 'click-at', 'key', 'goto', 'resume']);

/** @param {Record<string, unknown>} step */
function recordStep(step) {
  const file = path.join(__dirname, '.tmp', 'steps.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(step)}\n`);
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
  // Every action leaves one line in .tmp/steps.jsonl, so a later reader can see which step changed what.
  if (ACTION_COMMANDS.has(command)) {
    const started = Date.now();
    // record the raw argv, so flags like --frame and --canvas are kept
    const raw = process.argv.slice(2);
    process.once('exit', (exitCode) => recordStep({
      ts: new Date(started).toISOString(),
      command,
      // typed text can be a password: keep only the selector for type and fill
      args: command === 'type' || command === 'fill' ? raw.slice(0, 2) : raw,
      exitCode,
      ms: Date.now() - started,
    }));
  }

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
    case 'vm-scripts': await cmdVmScripts(ctx); break;
    case 'find-function': await cmdFindFunction(ctx); break;
    case 'layout': await cmdLayout(ctx); break;
    case 'catch-script': await cmdCatchScript(ctx); break;
    case 'events': await cmdEvents(ctx); break;
    case 'profile': await cmdProfile(ctx); break;

    case 'mirror': await cmdMirror(ctx); break;
    case 'mirror-run': await cmdMirrorRun(ctx); break;
    case 'index-site': await cmdIndexSite(ctx); break;
    case 'traffic': await cmdTraffic(ctx); break;

    case 'eval': await cmdEval(ctx); break;

    case 'break': await cmdBreak(ctx); break;

    case 'close': await cmdClose(ctx); break;

    // Commands below work on the live tab and leave it open.

    case 'snapshot': await cmdSnapshot(ctx); break;

    case 'click':
    case 'type':
    case 'fill':
    case 'press': await cmdInteract(ctx); break;

    case 'tabs': await cmdTabs(ctx); break;
    case 'frames': await cmdFrames(ctx); break;
    case 'status': await cmdStatus(ctx); break;
    case 'resume': await cmdResume(ctx); break;
    case 'goto': await cmdGoto(ctx); break;
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
    // A blocked renderer (for example a synchronous XMLHttpRequest) never answers CDP, so the call times out.
    if (/timed out/i.test(err.message) && /Runtime\.|protocol/i.test(err.message)) {
      console.error('[hint] The page did not answer within the protocol timeout. A synchronous call (sync XMLHttpRequest, a busy loop) blocks the page. Use `await fetch(...)` in an async expression, and do not raise the timeout to hide it. See SKILL.md "When it does not work".');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (activeClient) await release(activeClient);
  });
