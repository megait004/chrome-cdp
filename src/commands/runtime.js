'use strict';
// Commands that map what the page runs: every registered event listener with its handler location,
// and a CPU profile of a window showing which functions ran and who called them.
const { sleep } = require('../util');

/**
 * Groups listeners by event type and handler location. One row per (type, handler) with a count.
 * Line and column are 1-based.
 * @param {Array<{ type: string, scriptId: string, lineNumber: number, columnNumber: number, useCapture: boolean, passive: boolean, once: boolean }>} listeners
 * @param {(scriptId: string) => string} labelOf names a script (its URL, or a content hash for runtime code)
 */
function groupListeners(listeners, labelOf) {
  const rows = new Map();
  for (const l of listeners) {
    const where = `${labelOf(l.scriptId)}:${l.lineNumber + 1}:${l.columnNumber + 1}`;
    // The flags are part of the identity: one handler registered twice with different capture flags is two rows.
    const key = `${l.type} ${where} ${l.useCapture ? 'capture' : 'bubble'}`;
    const row = rows.get(key) ?? { type: l.type, where, count: 0, useCapture: l.useCapture, passive: l.passive, once: l.once };
    row.count += 1;
    rows.set(key, row);
  }
  const byType = new Map();
  for (const row of rows.values()) {
    const list = byType.get(row.type) ?? [];
    list.push(row);
    byType.set(row.type, list);
  }
  return [...byType].sort(([a], [b]) => a.localeCompare(b)).map(([type, handlers]) => ({ type, handlers }));
}

/**
 * Self time per function and the function that called it most. Positions are 1-based.
 * @param {{ nodes: Array<{ id: number, hitCount?: number, children?: number[], callFrame: { functionName: string, scriptId: string, url: string, lineNumber: number, columnNumber: number } }>, startTime: number, endTime: number }} profile
 * @param {(scriptId: string) => string} labelOf
 * @param {number} intervalUs sampling interval the profile was recorded with
 * @param {number} [top] how many functions to keep
 */
function summarizeProfile(profile, labelOf, intervalUs, top = 15) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of profile.nodes) for (const child of n.children ?? []) parentOf.set(child, n.id);

  /** @param {(typeof profile.nodes)[number]} n */
  const nameOf = (n) => {
    const f = n.callFrame;
    // V8 pseudo-frames such as (root), (idle) and (garbage collector) belong to no script.
    if (f.scriptId === '0') return f.functionName;
    return `${f.functionName || '(anonymous)'} ${labelOf(f.scriptId)}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
  };

  const functions = new Map();
  for (const n of profile.nodes) {
    const hits = n.hitCount ?? 0;
    if (hits === 0) continue;
    const name = nameOf(n);
    const entry = functions.get(name) ?? { name, hits: 0, callers: new Map() };
    entry.hits += hits;
    const parent = byId.get(parentOf.get(n.id));
    if (parent) {
      const caller = nameOf(parent);
      entry.callers.set(caller, (entry.callers.get(caller) ?? 0) + hits);
    }
    functions.set(name, entry);
  }

  const totalHits = [...functions.values()].reduce((sum, f) => sum + f.hits, 0);
  /** @param {number} hits */
  const ms = (hits) => Math.round((hits * intervalUs) / 100) / 10;
  return {
    durationMs: Math.round((profile.endTime - profile.startTime) / 100) / 10,
    samples: totalHits,
    functions: [...functions.values()]
      .sort((a, b) => b.hits - a.hits)
      .slice(0, top)
      .map((f) => ({
        function: f.name,
        selfMs: ms(f.hits),
        callers: [...f.callers].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, hits]) => ({ function: name, ms: ms(hits) })),
      })),
  };
}

/**
 * @typedef {InstanceType<typeof import('../chrome-client')>} Client
 * @typedef {{ args: string[], port: number, outFile: string | null }} Ctx
 * @typedef {{
 *   attach: (port: number) => Promise<Client>,
 *   emit: (result: object, outFile: string | null) => Promise<void>,
 *   release: (client: Client) => Promise<void>,
 *   isHttpUrl: (s: string | undefined) => boolean,
 *   T: { CLI_NAV_TIMEOUT_MS: number },
 * }} RuntimeDeps
 */

/** @param {RuntimeDeps} deps */
function createRuntimeCommands({ attach, emit, release, isHttpUrl, T }) {
  /** Script labels for this page: URL, or a content hash for code created at runtime. */
  /** @param {Client} client */
  function labelsOf(client) {
    const labels = new Map(client.sources.getScripts().map((/** @type {import('../source-controller').ScriptInfo} */ s) => [s.scriptId, s.url || (s.hash ? `runtime ${s.hash.slice(0, 12)}` : `runtime ${s.scriptId}`)]));
    return (/** @type {string} */ scriptId) => labels.get(scriptId) ?? `unknown ${scriptId}`;
  }

  /** @param {Ctx} ctx */
  async function cmdEvents({ args, port, outFile }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const client = await attach(port);
    if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    // Enabling the debugger first lets every script on the page be named in the output.
    await client.sources.enable();

    // The window's own listeners, plus every listener in the document tree and in iframes (pierce).
    const listeners = [
      ...(await client.dom.getEventListeners('window')),
      ...(await client.dom.getEventListeners('document', { pierce: true })),
    ];
    const types = groupListeners(listeners, labelsOf(client));
    await emit({ listeners: listeners.length, eventTypes: types.length, types }, outFile);

    await release(client);
  }

  /** @param {Ctx} ctx */
  async function cmdProfile({ args, port, outFile }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const waitArg = args.indexOf('--wait');
    const waitSec = waitArg > 0 ? Number(args[waitArg + 1]) : 5;
    if (!Number.isFinite(waitSec) || waitSec <= 0) throw new Error('Usage: node cli.js profile [url] [--wait S]');

    const client = await attach(port);
    if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    await client.sources.enable();
    const intervalUs = 1000;
    await client.performance.startProfile({ interval: intervalUs });
    console.error(`Profiling for ${waitSec}s; interact with the page now.`);
    await sleep(waitSec * 1000);
    const profile = await client.performance.stopProfile();

    await emit(summarizeProfile(profile, labelsOf(client), intervalUs), outFile);

    await release(client);
  }

  return { cmdEvents, cmdProfile };
}

module.exports = { createRuntimeCommands, groupListeners, summarizeProfile };
