'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const T = require('../timeouts');
const { attach, core, release } = require('../cli/session');
const { emit } = require('../cli/output');
const { isHttpUrl } = require('../cli/args');
const { settleWithin } = require('../util');
const { recordSite, createRun, activeRun, indexSite } = require('../site-mirror');
const { scanFrame } = require('./dom');
const ROOT = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(ROOT, 'cli.js');

/** @typedef {import('../cli/session').Ctx} Ctx */
/** @typedef {import('../cli/session').Client} Client */


/** @param {Ctx} ctx */
async function cmdStart({ port }) {
  await core().startChrome({ port });
}

/** @param {Ctx} ctx */
async function cmdClose({ port }) {
  const client = (await attach(port));
  const closing = client.page.url();
  await client.closePage(); // falls back to about:blank when it is the last tab, so Chrome stays up
  console.log(`Closed tab: ${closing}`);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdTabs({ port, outFile }) {
  const client = (await attach(port));
  // Target info comes without touching a renderer; only the title and the visibility need the page, and
  // that is bounded so one blocked tab cannot hang the listing.
  const targets = client.browser.browserContexts().flatMap((context) => context.targets()).filter((target) => target.type() === 'page');
  const rows = await Promise.all(targets.map(async (target, index) => {
    const info = await settleWithin(describeTab(target), T.UNRESPONSIVE_WAIT_MS, `reading tab ${index}`);
    return { tab: index, url: target.url(), title: info?.title ?? '', active: info?.visible ?? null };
  }));
  await emit(rows, outFile);
  await release(client);
}

/**
 * Title and foreground state of one tab. Only the tab the browser is showing reports
 * `visibilityState === 'visible'`, which is the only accurate read CDP offers (there is no
 * "selected tab" command; a minimized window reports none as visible).
 * @param {import('puppeteer-core').Target} target
 * @returns {Promise<{ title: string, visible: boolean } | null>}
 */
async function describeTab(target) {
  const page = await target.page();
  if (!page) return null;
  const [title, visible] = await Promise.all([page.title(), page.evaluate(() => document.visibilityState === 'visible')]);
  return { title, visible };
}

/** @param {Ctx} ctx */
async function cmdFrames({ port, outFile }) {
  const client = (await attach(port));
  const rows = await Promise.all(client.visual.frames().map(async (frame, index) => {
    const scan = await scanFrame(client, frame);
    // canvasSizes is the canvas's own pixel size (width x height attributes), not its CSS size; game code
    // that sizes its view from these numbers reads the same values.
    return { frame: index, canvases: scan.canvases.length, canvasSizes: scan.canvases.map((c) => `${c.width}x${c.height}`), elements: scan.elements.length, url: frame.url().slice(0, 120), error: scan.error };
  }));
  await emit(rows, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdStatus({ port, isJson, outFile }) {
  /** @type {{ chrome: boolean, port: number, url?: string, title?: string | null, frames?: number, paused: string | null, mirror: string | null, responses?: number, idleSeconds?: string }} */
  const info = { chrome: Boolean(await core().checkCdpReady(port)), port, paused: core().DebugController.readPauseMarker() ? 'yes (node cli.js resume)' : null, mirror: null };
  if (info.chrome) {
    const client = await attach(port).catch((error) => {
      // A blocked renderer answers no page commands at all, so report that instead of failing the health check.
      if (!(error instanceof Error && error.name === 'UnresponsiveTabError')) throw error;
      info.url = '(not answering: the renderer is blocked)';
      console.error(error.message);
      return null;
    });
    if (client) {
      info.url = client.url();
      // Bounded: on a blocked renderer the title never arrives, and status must still report the tab.
      info.title = (await settleWithin(client.title(), T.UNRESPONSIVE_WAIT_MS, 'reading the tab title')) ?? null;
      info.frames = client.visual.frames().length;
      await release(client);
    }
  }
  const recording = activeRun(path.join(ROOT, '.tmp', 'mirror'));
  if (recording) {
    const log = path.join(recording, 'requests.jsonl');
    info.mirror = recording;
    info.responses = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"kind":"response"')).length : 0;
    info.idleSeconds = fs.existsSync(log) ? ((Date.now() - fs.statSync(log).mtimeMs) / 1000).toFixed(1) : '?';
  }
  if (isJson || outFile) {
    await emit(info, outFile);
    return;
  }
  if (!info.chrome) console.log(`Chrome: not running on port ${port} (start it with: node cli.js start)`);
  else {
    console.log(`Chrome: running on port ${port}`);
    if (info.url) console.log(`Tab: ${info.url} | ${info.title ?? '(no answer: the renderer is blocked)'}`);
    console.log(`Frames: ${info.frames ?? 0} | Paused: ${info.paused ? 'yes (node cli.js resume)' : 'no'}`);
  }
  console.log(info.mirror ? `Mirror recording: ${info.mirror} (${info.responses} responses saved, last write ${info.idleSeconds}s ago)` : 'Mirror recording: none');
}

/** Lists dedicated workers, service workers and shared workers with their URLs. @param {Ctx} ctx */
async function cmdWorkers({ port, outFile }) {
  const client = (await attach(port));
  const list = client.workers ? client.workers.list() : [];
  await emit({ count: list.length, workers: list }, outFile);
  await release(client);
}

/** Deletes the browser cache and/or cookies for the whole profile. @param {Ctx} ctx */
async function cmdPurge({ args, port, outFile }) {
  const cache = args.includes('--cache');
  const cookies = args.includes('--cookies');
  if (!cache && !cookies) throw new Error('purge needs --cache and/or --cookies: purge --cache --cookies');
  const client = (await attach(port));
  if (cache) await client.network.clearCache();
  if (cookies) await client.network.clearCookies();
  await emit({ ok: true, cleared: { cache, cookies } }, outFile);
  await release(client);
}

async function cmdClean() {
  const dir = path.join(ROOT, '.tmp');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Removed ${dir}`);
}

/** `goto <url>`: navigate the tab and report where it landed. Same as `eval <url> <expr>`, named for what agents look for. @param {Ctx} ctx */
async function cmdGoto({ args, port }) {
  const url = args[1];
  if (!isHttpUrl(url)) throw new Error('Usage: node cli.js goto <http(s) url>');
  const client = (await attach(port));
  await client.goto(url, { waitUntil: 'load', timeout: T.CLI_NAV_TIMEOUT_MS });
  console.log(JSON.stringify({ url: client.url(), title: await client.title() }, null, 2));
  await release(client);
}

/**
 * `mirror start <url>` starts a detached recorder that keeps running while you interact with the tab;
 * `mirror stop` ends it. Everything loaded in between is kept, including lazy loads.
 * @param {Ctx} ctx
 */
async function cmdMirror({ args, port, tab }) {
  const sub = args[1];
  const outRoot = (/** @type {string | undefined} */ dir) => path.resolve(dir || path.join(ROOT, '.tmp', 'mirror'));

  if (sub === 'stop') {
    const dir = activeRun(outRoot(args[2]));
    if (!dir) throw new Error('No active recording. Start one with: node cli.js mirror start <url>');
    fs.writeFileSync(path.join(dir, 'STOP'), '');
    await core().waitUntil(() => fs.existsSync(path.join(dir, 'manifest.json')), { timeout: 120000, every: 500 });
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
  if (!(await core().checkCdpReady(port))) throw new Error(`Chrome is not running on port ${port}. Start it with: node cli.js start`);

  const runDir = createRun(root, url);
  const logFd = fs.openSync(path.join(runDir, 'recorder.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, 'mirror-run', url, runDir, '--port', String(port), '--tab', String(tab)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(runDir, 'recorder.pid'), String(child.pid));

  await core().waitUntil(() => fs.existsSync(path.join(runDir, 'READY')), { timeout: 30000, every: 200 });
  if (!fs.existsSync(path.join(runDir, 'READY'))) throw new Error(`Recorder did not start. See ${runDir}/recorder.log`);
  console.log(`Recording ${url} -> ${runDir}\nInteract with the tab now. Stop with: node cli.js mirror stop`);
}

/** Hidden: the detached recorder that `mirror start` spawns. */
/** @param {Ctx} ctx */
async function cmdMirrorRun({ args, port }) {
  const [, url, runDir] = args;
  try {
    const client = (await attach(port));
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
  for (const e of r.errors) console.log(`  unpack failed: ${e.file}: ${e.error}`);
}

module.exports = {
  cmdStart,
  cmdClose,
  cmdTabs,
  describeTab,
  cmdFrames,
  cmdStatus,
  cmdWorkers,
  cmdPurge,
  cmdClean,
  cmdGoto,
  cmdMirror,
  cmdMirrorRun,
  cmdIndexSite,
};
