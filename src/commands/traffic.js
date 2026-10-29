'use strict';
const fs = require('node:fs');
const path = require('node:path');
const T = require('../timeouts');
const { attach, core, release } = require('../cli/session');
const { emit, printTraffic, redactEntry, redactRawText, slimEntry, slimSocket } = require('../cli/output');
const { isHttpUrl, takeFlag } = require('../cli/args');
const { messageOf } = require('../util');
const { activeRun } = require('../site-mirror');
const ROOT = path.join(__dirname, '..', '..');

/** @typedef {import('../cli/session').Ctx} Ctx */
/** @typedef {import('../cli/session').Client} Client */

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
  await core().waitUntil(() => {
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
 * @param {Array<import('../network-controller').TrafficEntry>} httpTraffic
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
 * Captures this invocation's recording: navigate when a URL is given, otherwise listen to the live tab.
 * The network, console and WebSocket recorders live in this process, so a read must happen in the same call.
 * @param {Client} client @param {string | null} url @param {number} seconds
 */
async function settleCapture(client, url, seconds) {
  if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  const ms = Math.max(0, seconds) * 1000;
  if (ms) await new Promise((r) => setTimeout(r, ms));
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

  const client = (await attach(port));
  client.network.clear();
  client.websocket.clear();
  await captureTraffic(client, url, waitSecs);

  const httpTraffic = client.network.getTraffic();
  const wsSockets = client.websocket.getSockets();
  /** @type {{ finalUrl: string, mode: string, httpTraffic: Array<import('../network-controller').TrafficEntry & { body?: unknown, parsedJson?: unknown }>, wsSockets: import('../types/websocket').WsSocket[], note?: string }} */
  const result = { finalUrl: client.url(), mode: url ? 'load' : 'live', httpTraffic, wsSockets };
  if (!url && wsSockets.some((s) => !s.url)) {
    result.note = 'socket(s) with no URL were opened before this attach — the handshake was missed, but their frames still flow';
  } else if (!url && wsSockets.length === 0) {
    result.note = 'no frames arrived in this window; a WebSocket opened before attach becomes visible only once it sends a frame — rerun with a longer --wait';
  }
  // Read bodies now, while Chrome still holds them.
  if (args.includes('--bodies')) result.httpTraffic = await withBodies(client, httpTraffic);

  // Agents read this reply in their context: keep it small, and keep session cookies out of it.
  // --full restores every field; --no-redact keeps credentials; --out writes the file unredacted.
  const full = args.includes('--full');
  const redact = !args.includes('--no-redact') && !outFile;
  if (isJson || outFile) {
    const records = full ? result.httpTraffic.map((entry) => (redact ? redactEntry(entry) : entry)) : result.httpTraffic.map((entry) => slimEntry(entry, redact));
    result.httpTraffic = /** @type {any} */ (records);
    result.wsSockets = /** @type {any} */ (result.wsSockets.map((socket) => slimSocket(socket, redact)));
    await emit(result, outFile);
  } else {
    const rows = redact ? httpTraffic.map(redactEntry) : httpTraffic;
    printTraffic(rows, wsSockets, result.finalUrl, args.includes('--headers'));
  }

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdConsole({ args, port, outFile }) {
  const level = takeFlag(args, '--level');
  const filter = takeFlag(args, '--filter');
  const limit = Number(takeFlag(args, '--limit') ?? 50);
  const live = !(args[1] && isHttpUrl(args[1]));
  const wait = Number(takeFlag(args, '--wait') ?? (live ? 2 : 0.3));
  const client = (await attach(port));
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  await settleCapture(client, url, wait);
  const logs = client.console.getLogs({ type: level ?? undefined, query: filter ?? undefined });
  const rows = logs.slice(-limit).map((entry) => ({
    type: entry.type,
    text: String(entry.text ?? '').slice(0, 400),
    url: entry.url,
    line: entry.lineNumber,
    at: entry.timestamp,
  }));
  await emit({ count: logs.length, level: level ?? 'all', filter: filter ?? null, messages: rows }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdRaw({ args, port, outFile }) {
  const response = args.includes('--response');
  if (response) args.splice(0, args.length, ...args.filter((a) => a !== '--response'));
  const wait = Number(takeFlag(args, '--wait') ?? 1.5);
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const query = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) throw new Error('raw needs a request: raw [url] <requestId|url-substring> [--response] [--wait S]');
  const client = (await attach(port));
  await settleCapture(client, url, wait);
  /** @type {string} */
  let text;
  try {
    text = response ? await client.network.toRawResponse(query) : await client.network.toRawRequest(query);
  } catch (error) {
    throw new Error(`${messageOf(error).split('\n')[0]}. Nothing was recorded in this process: pass a URL and --wait, e.g. node cli.js raw https://target/ "<url-part>" --wait 2`);
  }
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, text, 'utf8');
    console.log(`Saved ${Buffer.byteLength(text)} bytes of raw HTTP to: ${abs}`);
  } else {
    // Session cookies are credentials; a reply goes into an agent's context. Keep them for --out only.
    console.log(args.includes('--no-redact') ? text : redactRawText(text));
  }
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdSearchBodies({ args, port, outFile }) {
  const wait = Number(takeFlag(args, '--wait') ?? 1.5);
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const query = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) throw new Error('search-bodies needs a query: search-bodies [url] <text|/regex/> [--wait S]');
  const client = (await attach(port));
  await settleCapture(client, url, wait);
  const matches = await client.network.searchBodies(query);
  await emit({ query, count: matches.length, matches }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdWsFrames({ args, port, outFile }) {
  const direction = takeFlag(args, '--direction');
  if (direction && direction !== 'sent' && direction !== 'received') throw new Error('--direction must be sent or received');
  const query = takeFlag(args, '--query');
  const hex = args.includes('--hex');
  const limit = Number(takeFlag(args, '--limit') ?? 50);
  const wait = Number(takeFlag(args, '--wait') ?? 3);
  const client = (await attach(port));
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  await settleCapture(client, url, wait);
  const frames = client.websocket.getFrames(undefined, {
    direction: /** @type {'sent' | 'received' | undefined} */ (direction ?? undefined),
    query: query ?? undefined,
  });
  const rows = frames.slice(-limit).map((frame) => ({
    direction: frame.direction,
    opcode: frame.opcode,
    binary: frame.isBinary || undefined,
    bytes: frame.isBinary ? Buffer.from(frame.payloadData, 'base64').length : Buffer.byteLength(frame.payloadData),
    payload: hex && frame.isBinary ? Buffer.from(frame.payloadData, 'base64').toString('hex').slice(0, 512) : frame.payloadData.slice(0, 500),
    json: frame.parsedJson,
    socket: frame.url,
    at: frame.wallTime,
  }));
  await emit({ count: frames.length, direction: direction ?? 'both', query: query ?? null, frames: rows }, outFile);
  await release(client);
}

/** Search WebSocket frames by payload text or JSON value. */
/** @param {Ctx} ctx */
async function cmdWsSearch({ args, port, outFile }) {
  const direction = takeFlag(args, '--direction');
  if (direction && direction !== 'sent' && direction !== 'received') throw new Error('--direction must be sent or received');
  const wait = Number(takeFlag(args, '--wait') ?? 3);
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const query = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) throw new Error('ws-search needs a query: ws-search [url] <text|/regex/> [--direction sent|received] [--wait S]');
  const client = (await attach(port));
  await settleCapture(client, url, wait);
  // A game speaks msgpack/protobuf: the payload is base64, so a text query has to look at the decoded
  // bytes, otherwise "updatePlayerInfo" never matches however many frames arrive.
  const re = typeof query === 'string' && /^\/(.+)\/([gimsuy]*)$/s.exec(query);
  const needle = re ? new RegExp(re[1], re[2]) : null;
  const matchesQueryLocal = (/** @type {string} */ text) => (needle ? needle.test(text) : text.toLowerCase().includes(String(query).toLowerCase()));
  const matches = client.websocket
    .getFrames(undefined, { direction: /** @type {'sent' | 'received' | undefined} */ (direction ?? undefined) })
    .filter((frame) => {
      const text = frame.isBinary ? Buffer.from(frame.payloadData, 'base64').toString('utf8') : frame.payloadData;
      return matchesQueryLocal(text) || (frame.parsedJson ? matchesQueryLocal(JSON.stringify(frame.parsedJson)) : false);
    });
  await emit({
    query,
    count: matches.length,
    frames: matches.slice(0, 50).map((frame) => ({
      socket: frame.url,
      direction: frame.direction,
      opcode: frame.opcode,
      binary: frame.isBinary || undefined,
      bytes: frame.isBinary ? Buffer.from(frame.payloadData, 'base64').length : Buffer.byteLength(frame.payloadData),
      payload: frame.payloadData.slice(0, 500),
      text: frame.isBinary ? Buffer.from(frame.payloadData, 'base64').toString('utf8').replace(/[^ -~]/g, '.') : undefined,
      at: frame.wallTime,
    })),
  }, outFile);
  await release(client);
}

/** Finds a recorded request by URL, body, request headers, response headers or status line. */
/** @param {Ctx} ctx */
async function cmdSearchTraffic({ args, port, outFile }) {
  const wait = Number(takeFlag(args, '--wait') ?? 1.5);
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const query = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) throw new Error('search-traffic needs a query: search-traffic [url] <text|/regex/> [--wait S]');
  const client = (await attach(port));
  await settleCapture(client, url, wait);
  const matches = client.network.searchTraffic(query);
  await emit({
    query,
    count: matches.length,
    matches: matches.map((m) => ({ requestId: m.requestId, url: m.url, method: m.method, status: m.status, matchedFields: m.matchedFields })),
  }, outFile);
  await release(client);
}

/** Re-sends a recorded XHR/fetch with Chrome's own Network.replayXHR: same URL, headers and body. */
/** @param {Ctx} ctx */
async function cmdReplay({ args, port, outFile }) {
  const wait = Number(takeFlag(args, '--wait') ?? 2);
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const query = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) throw new Error('replay needs a request: replay [url] <requestId|url-substring> [--wait S]');
  const client = (await attach(port));
  await settleCapture(client, url, url ? wait : 0.5);
  const before = client.network.getTraffic().length;
  /** @type {string} */
  let errorText = '';
  try {
    await client.network.replayXHR(query);
  } catch (error) {
    errorText = messageOf(error);
    // Chrome only replays XHR and fetch; a document or a socket cannot be re-sent this way.
    if (/correspond to XHR/i.test(errorText)) errorText += ' (Network.replayXHR only accepts XHR/Fetch requests: pick one from `traffic --json`, which lists resourceType)';
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  const fresh = client.network.getTraffic().slice(before);
  await emit({
    replayed: query,
    ok: !errorText,
    ...(errorText ? { error: errorText.split('\n')[0] } : {}),
    newRequests: fresh.map((entry) => slimEntry(entry, true)),
  }, outFile);
  await release(client);
}

/**
 * Records window.postMessage traffic. The hook is installed for documents created after this call, so a URL
 * is what makes it catch anything; without one it applies from the next navigation.
 * @param {Ctx} ctx
 */
async function cmdPostMessage({ args, port, outFile }) {
  const wait = Number(takeFlag(args, '--wait') ?? 3);
  const limit = Number(takeFlag(args, '--limit') ?? 50);
  const client = (await attach(port));
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  await client.dom.hookPostMessage();
  if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  const logs = await client.dom.getPostMessageLogs();
  await emit({
    url: client.url(),
    count: logs.length,
    ...(url ? {} : { note: 'no URL given: the hook only sees documents created after it was installed, so navigate in the same command (postmessage <url>)' }),
    messages: logs.slice(-limit),
  }, outFile);
  await release(client);
}

/** Deep property dump of an object id or expression; survives cycles, DOM nodes and functions. */
/** @param {Ctx} ctx */
async function cmdInspect({ args, port, outFile }) {
  const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
  const expression = args.slice(url ? 2 : 1).filter((a) => !a.startsWith('--')).join(' ');
  if (!expression) throw new Error('inspect needs an expression: inspect [url] <expression|objectId>');
  const client = (await attach(port));
  if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  const result = await client.console.inspectObject(expression);
  await emit({ expression, result }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdGlobals({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  const filter = takeFlag(args, '--filter');
  const limit = Number(takeFlag(args, '--limit') ?? 200);
  const client = (await attach(port));
  const owner = frame ? client.visual.frame(frame) : client.page.mainFrame();
  const list = await owner.evaluate(() => {
    const rows = [];
    for (const key of Object.getOwnPropertyNames(window)) {
      if (/^(webkit|moz|on)/.test(key)) continue;
      try {
        const value = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window))[key];
        rows.push({ key, type: typeof value, ctor: value && typeof value === 'object' && value.constructor ? value.constructor.name : undefined });
      } catch {
        rows.push({ key, type: 'unreadable' });
      }
    }
    return rows;
  });
  const rows = list.filter((r) => !filter || r.key.toLowerCase().includes(filter.toLowerCase())).slice(0, limit);
  await emit({ url: client.url(), count: list.length, filter: filter ?? null, globals: rows }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdObjects({ args, port, outFile }) {
  const limit = Number(takeFlag(args, '--limit') ?? 20);
  const expression = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
  if (!expression) throw new Error('objects needs a prototype expression: objects <SomeClass.prototype> [--limit N]');
  const client = (await attach(port));
  const objects = await client.console.queryObjects(expression, { limit });
  await emit({ expression, count: objects.length, objects }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDoctor({ port }) {
  const pkg = require('../../package.json');
  /** @type {Array<{ check: string, ok: boolean, detail?: string }>} */
  const checks = [];
  const add = (/** @type {string} */ check, /** @type {boolean} */ ok, /** @type {string} */ detail = '') => checks.push({ check, ok, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  const version = await core().checkCdpReady(port);
  add('chrome', Boolean(version), version ? `${version.Browser} on port ${port}` : `not reachable on port ${port} (run: node cli.js start)`);
  if (version) {
    try {
      const client = await attach(port);
      // browserContexts() is synchronous: the targets are already an array (javascript:S4123).
      const tabs = client.browser.browserContexts().flatMap((c) => c.targets()).filter((t) => t.type() === 'page');
      add('tabs', tabs.length > 0, `${tabs.length} page target(s), attached to tab 0`);
      const page = await client.page.evaluate(() => ({ url: location.href, title: document.title, readyState: document.readyState, focused: document.hasFocus(), visible: document.visibilityState === 'visible' })).catch(() => null);
      add('page', Boolean(page), page ? `${page.url} - ${page.title} (${page.readyState}, focused=${page.focused}, visible=${page.visible})` : 'not readable (a busy renderer?)');
      const errors = client.console.getLogs({ type: 'error' }).length;
      add('console', true, `${errors} recorded error(s) in this session`);
      const paused = core().DebugController.readPauseMarker();
      add('debugger', !paused, paused ? `paused at ${paused.url || paused.scriptId}:${paused.line} (pid ${paused.pid}) - run: node cli.js resume` : 'no pause held');
      await release(client);
    } catch (error) {
      add('attach', false, messageOf(error));
    }
  } else {
    add('attach', false, 'skipped: no Chrome');
  }
  const mirrorDir = activeRun(path.join(ROOT, '.tmp/mirror'));
  add('mirror', true, mirrorDir ? `recording into ${mirrorDir}` : 'none');
  const tmpDir = path.join(ROOT, '.tmp');
  add('workspace', true, fs.existsSync(tmpDir) ? `.tmp present (${fs.readdirSync(tmpDir).length} entries)` : '.tmp missing (created on demand)');
  console.log(JSON.stringify({ ok: checks.every((c) => c.ok), version: pkg.version, port, checks }, null, 2));
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

module.exports = {
  cmdTraffic,
  cmdConsole,
  cmdRaw,
  cmdSearchBodies,
  cmdWsFrames,
  cmdWsSearch,
  cmdSearchTraffic,
  cmdReplay,
  cmdPostMessage,
  cmdInspect,
  cmdGlobals,
  cmdObjects,
  cmdDoctor,
};
