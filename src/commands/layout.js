'use strict';
// The `layout` command: records what the render pipeline did and where JavaScript was when it did it.
// Style, layout, pre-paint and paint are reported with the script location that was on the stack.
const { sleep } = require('../util');

const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'];
// The stack is only written when this category is on; without it the report has totals but no locations.
const CATEGORIES = 'devtools.timeline,disabled-by-default-devtools.timeline.stack';

/**
 * Totals per render stage, and the top stack frame of each stage grouped by location.
 * Frame line and column are 1-based, as the trace records them.
 * @param {string} traceText text returned by performance.stopTrace()
 * @param {(scriptId: string) => string} labelOf names the script a frame is in; scripts with the same label group together
 */
function summarizeRender(traceText, labelOf) {
  const parsed = JSON.parse(traceText);
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const totals = new Map(STAGES.map((name) => [name, { count: 0, ms: 0 }]));
  const sites = new Map();

  for (const event of events) {
    const total = totals.get(event.name);
    if (!total || event.ph !== 'X') continue;
    const ms = event.dur / 1000;
    total.count += 1;
    total.ms += ms;

    // Layout and style keep their data under beginData; Paint under data. Only some events carry a stack.
    const data = event.args?.beginData ?? event.args?.data ?? {};
    const top = data.stackTrace?.[0];
    const where = top ? `${labelOf(top.scriptId)}:${top.lineNumber}:${top.columnNumber}` : '(no script on stack)';
    const node = data.nodeName ? `${data.nodeName}#${data.nodeId}` : '';
    const key = `${event.name} ${where} ${node}`;
    const site = sites.get(key) ?? { stage: event.name, where, node, count: 0, ms: 0, maxDirtyObjects: 0 };
    site.count += 1;
    site.ms += ms;
    site.maxDirtyObjects = Math.max(site.maxDirtyObjects, data.dirtyObjects ?? 0);
    sites.set(key, site);
  }

  /** @param {number} n */
  const round = (n) => Math.round(n * 10) / 10;
  return {
    stages: [...totals].map(([name, t]) => ({ name, count: t.count, ms: round(t.ms) })),
    sites: [...sites.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 20)
      .map((s) => ({ ...s, ms: round(s.ms) })),
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
 * }} LayoutDeps
 */

/** @param {LayoutDeps} deps */
function createLayoutCommands({ attach, emit, release, isHttpUrl, T }) {
  /** @param {Ctx} ctx */
  async function cmdLayout({ args, port, outFile }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const waitArg = args.indexOf('--wait');
    const waitSec = waitArg > 0 ? Number(args[waitArg + 1]) : 5;
    if (!Number.isFinite(waitSec) || waitSec <= 0) throw new Error('Usage: node cli.js layout [url] [--wait S]');

    const client = await attach(port);
    if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    // Scripts are listed after enabling the debugger, so locations can be named by URL.
    await client.sources.enable();
    await client.performance.startTrace({ categories: CATEGORIES });
    console.error(`Recording render stages for ${waitSec}s; interact with the page now.`);
    await sleep(waitSec * 1000);
    const traceText = await client.performance.stopTrace();

    // A script with no URL (created by eval or Function) is named by its content hash: the same code run twice is one site.
    const labels = new Map(client.sources.getScripts().map((s) => [s.scriptId, s.url || (s.hash ? `runtime ${s.hash.slice(0, 12)}` : `runtime ${s.scriptId}`)]));
    const report = summarizeRender(traceText, (scriptId) => labels.get(scriptId) ?? `unknown ${scriptId}`);
    await emit(report, outFile);

    await release(client);
  }

  return { cmdLayout, summarizeRender };
}

module.exports = { createLayoutCommands, summarizeRender };
