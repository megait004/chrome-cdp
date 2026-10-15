'use strict';

const ChromeClient = require('./src/chrome-client');
const DOMController = require('./src/dom-controller');
const NetworkController = require('./src/network-controller');
const WebSocketController = require('./src/websocket-controller');
const ConsoleController = require('./src/console-controller');
const SourceController = require('./src/source-controller');
const WorkerController = require('./src/worker-controller');
const DebugController = require('./src/debug-controller');
const PerformanceController = require('./src/performance-controller');
const { startChrome, findChromePath, checkCdpReady } = require('./cdp');
const { waitUntil, assertEventually, waitForEvent } = require('./src/waiting');

const { webcrack } = require('webcrack');
const astGrep = require('@ast-grep/napi');

/**
 * Connects to an existing Chrome instance or launches one if not running.
 * @param {{
 *   port?: number,
 *   autoLaunch?: boolean,
 *   browserURL?: string,
 *   browserWSEndpoint?: string,
 *   autoEnableAll?: boolean,
 *   protocolTimeout?: number
 * }} [options]
 * @returns {Promise<ChromeClient>}
 */
async function connect(options = {}) {
  const port = options.port || 9222;

  if (options.autoLaunch !== false) {
    const isReady = await checkCdpReady(port);
    if (!isReady) {
      await startChrome({ port });
    }
  }

  return ChromeClient.connect(options);
}

module.exports = {
  ChromeClient,
  DOMController,
  NetworkController,
  WebSocketController,
  ConsoleController,
  SourceController,
  WorkerController,
  DebugController,
  PerformanceController,
  connect,
  waitUntil,
  assertEventually,
  waitForEvent,
  startChrome,
  findChromePath,
  checkCdpReady,
  webcrack,
  astGrep,
};
