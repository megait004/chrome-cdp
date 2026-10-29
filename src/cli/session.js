'use strict';
// The one place that knows how a command reaches Chrome: the lazy index require, the tab this process
// attaches to, the client that has to be released on exit, and the pause guard.
const T = require('../timeouts');

// Required on first use: --help, --version and clean must not pay ~340 ms for puppeteer.
/** @returns {typeof import('../../index')} */
function core() {
  return require('../../index');
}

// A page blocked by a synchronous call cannot answer CDP, and the default wait is 30 s.
// Evals slower than 10 s fail here even if they would finish.
const EVAL_PROTOCOL_TIMEOUT_MS = 10000;

/**
 * @typedef {{ command: string, args: string[], port: number, isJson: boolean, outFile: string | null, tab: number }} Ctx
 */

/** @typedef {InstanceType<typeof import('../chrome-client')>} Client */

let tabIndex = 0; // set from --tab; every command attaches to this tab

/** @type {Client | undefined} */
let activeClient;

const SLOW = Symbol('slow');

/** @param {number} index */
function setTabIndex(index) {
  tabIndex = index;
}

/**
 * Attaches to a Chrome that is already running on `port`. Never launches one:
 * a command must not open a browser on the user's profile unannounced. Use
 * `node cli.js start` for that.
 * The client is remembered, so the exit path can release it even when a command throws.
 * @param {number} port
 * @returns {Promise<Client>}
 */
async function attach(port, /** @type {{ protocolTimeout?: number }} */ options = {}) {
  if (!(await core().checkCdpReady(port))) {
    throw new Error(`Chrome is not running on port ${port}. Start it with: node cli.js start`);
  }
  const client = await core().connect({ port, autoLaunch: false, tab: tabIndex, ...options });
  activeClient = client;
  return client;
}

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
  const held = core().DebugController.readPauseMarker();
  if (held) throw new Error(`The page is paused in the debugger at ${held.url || held.scriptId}:${held.line} (${held.reason}), held by pid ${held.pid}. Resume it with: node cli.js resume`);
  return work;
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

/** Releases whatever this process still holds: the exit path calls this, so a throw cannot leave a socket open. */
async function releaseActive() {
  if (activeClient) await release(activeClient);
}

/** Waits until a child frame whose URL contains `frame` exists: iframes appear after goto, so a first call can miss them. */
/** @param {Client} client @param {string | null} frame */
async function waitForFrame(client, frame) {
  if (!frame || /^\d+$/.test(frame)) return; // an index is used as-is: it does not wait
  const found = await core().waitUntil(() => client.visual.frames().some((f) => f.url().includes(frame)), { timeout: T.CLI_NAV_TIMEOUT_MS });
  if (!found) {
    const seen = client.visual.frames().map((f) => f.url().slice(0, 100)).join('\n  ');
    throw new Error(`Waited ${T.CLI_NAV_TIMEOUT_MS / 1000}s for a frame whose URL contains "${frame}". Frames seen:\n  ${seen}`);
  }
}

module.exports = {
  attach,
  core,
  EVAL_PROTOCOL_TIMEOUT_MS,
  release,
  releaseActive,
  setTabIndex,
  untilNotPaused,
  waitForFrame,
};
