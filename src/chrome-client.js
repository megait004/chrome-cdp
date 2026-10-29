'use strict';

// .default is the same object as the module (runtime-identical); the bare require loses its typings under NodeNext
const puppeteer = require('puppeteer-extra').default;
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { PROTOCOL_TIMEOUT_MS, GOTO_TIMEOUT_MS, UNRESPONSIVE_WAIT_MS, CLEANUP_WAIT_MS } = require('./timeouts');
const { settleWithin, sleep } = require('./util');

const DOMController = require('./dom-controller');
const NetworkController = require('./network-controller');
const WebSocketController = require('./websocket-controller');
const ConsoleController = require('./console-controller');
const SourceController = require('./source-controller');
const WorkerController = require('./worker-controller');
const DebugController = require('./debug-controller');
const PerformanceController = require('./performance-controller');
const VisualController = require('./visual-controller');

puppeteer.use(StealthPlugin());

/**
 * @typedef {{ dom: InstanceType<typeof DOMController>, network: InstanceType<typeof NetworkController>, websocket: InstanceType<typeof WebSocketController>, console: InstanceType<typeof ConsoleController>, sources: InstanceType<typeof SourceController>, debug: InstanceType<typeof DebugController>, performance: InstanceType<typeof PerformanceController>, visual: InstanceType<typeof VisualController> }} Controllers
 */

/**
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').CDPSession} cdpSession
 * @returns {Controllers}
 */
function createControllers(page, cdpSession) {
  const dom = new DOMController(page, cdpSession);
  return {
    dom,
    network: new NetworkController(page, cdpSession),
    websocket: new WebSocketController(cdpSession),
    console: new ConsoleController(page, cdpSession),
    sources: new SourceController(cdpSession),
    debug: new DebugController(cdpSession),
    performance: new PerformanceController(page, cdpSession),
    visual: new VisualController(page, cdpSession, dom),
  };
}

class ChromeClient {
  /**
   * @param {import('puppeteer-core').Browser} browser
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession} cdpSession
   * @param {{ workers?: WorkerController | null, ownsWorkers?: boolean, controllers?: Controllers }} [deps]
   *   workers is an initialized WorkerController (see WorkerController.create); ownsWorkers
   *   says whether this tab closes it on release. controllers default to the real ones.
   */
  constructor(browser, page, cdpSession, { workers = null, ownsWorkers = false, controllers = createControllers(page, cdpSession) } = {}) {
    this.browser = browser;
    this.page = page;
    this.cdp = cdpSession;

    this.dom = controllers.dom;
    this.network = controllers.network;
    this.websocket = controllers.websocket;
    this.console = controllers.console;
    this.sources = controllers.sources;
    this.debug = controllers.debug;
    this.performance = controllers.performance;
    this.visual = controllers.visual;
    this._ownsWorkers = ownsWorkers;
    this.workers = workers;
  }

  /**
   * Connects to a running Chrome instance via CDP port and initializes an active page session.
   * @param {{
   *   port?: number,
   *   browserURL?: string,
   *   browserWSEndpoint?: string,
   *   autoEnableAll?: boolean,
   *   protocolTimeout?: number,
   *   tab?: number
   * }} [options] tab is the index into browser.pages() (default 0)
   * @returns {Promise<ChromeClient>}
   */
  static async connect(options = {}) {
    const browserURL =
      options.browserURL ||
      (options.browserWSEndpoint ? undefined : `http://127.0.0.1:${options.port || 9222}`);

    /** @type {import('puppeteer-core').ConnectOptions} */
    const connectOpts = {
      defaultViewport: null,
      protocolTimeout: options.protocolTimeout || PROTOCOL_TIMEOUT_MS,
    };

    if (options.browserWSEndpoint) {
      connectOpts.browserWSEndpoint = options.browserWSEndpoint;
    } else {
      connectOpts.browserURL = browserURL;
    }

    const browser = await puppeteer.connect(connectOpts);

    try {
      // browser.pages() initializes every page, and initializing a page sends Network.enable, which a
      // blocked renderer never answers: one wedged tab would make every command fail. Listing targets
      // only reads target info, so initialize the one tab that was asked for, and only for a budget.
      /** @type {import('puppeteer-core').Target[]} */
      const allTargets = await browser.targets();
      const targets = allTargets.filter((target) => target.type() === 'page');
      const tab = options.tab ?? 0;
      if (tab >= targets.length) throw new Error(`Tab ${tab} does not exist: Chrome has ${targets.length} tab(s). List them with: node cli.js tabs`);
      const page = await Promise.race([
        targets[tab].page().catch(() => null),
        sleep(UNRESPONSIVE_WAIT_MS).then(() => null),
      ]);
      if (!page) {
        // note: ceiling — close and goto cannot run on a busy-loop tab, because puppeteer needs a page
        // handle and page setup itself needs the renderer. Upgrade path if this bites again: close via
        // HTTP /json/close/<id> and goto via Page.navigate on the raw page session from /json/list, both
        // of which answer while the renderer is blocked (measured: 143 ms and 1.25 s).
        const error = new Error(`Tab ${tab} (${targets[tab].url()}) is not answering: its renderer is blocked by a synchronous call. Close that tab in Chrome or restart Chrome, then retry.`);
        error.name = 'UnresponsiveTabError';
        throw error;
      }
      if (page.url().startsWith('chrome://')) {
        await page.goto('about:blank');
      }
      const cdp = await page.createCDPSession();

      const workers = await WorkerController.create(browser);
      const client = new ChromeClient(browser, page, cdp, { workers, ownsWorkers: true });

      // A blocked renderer never answers these, so wait for them only up to a budget: the command
      // then runs with the recording it got, instead of failing before it starts (status, close, goto).
      if (options.autoEnableAll !== false) {
        await settleWithin(
          Promise.all([
            client.network.startRecording(),
            client.websocket.startRecording(),
            client.console.startRecording(),
            client.sources.enable(),
          ]),
          UNRESPONSIVE_WAIT_MS,
          'enabling the recording domains (traffic, events, console, script search will be empty)'
        );
      }

      return client;
    } catch (error) {
      // The connection is already open: without this, the socket keeps Node alive after the error.
      await browser.disconnect().catch(() => {});
      throw error;
    }
  }

  /**
   * @param {{ autoEnableAll?: boolean }} [options]
   * @returns {Promise<ChromeClient>}
   */
  async newPage(options = {}) {
    const page = await this.browser.newPage();
    const cdp = await page.createCDPSession();
    const client = new ChromeClient(this.browser, page, cdp, { workers: this.workers });

    if (options.autoEnableAll !== false) {
      await settleWithin(
        Promise.all([
          client.network.startRecording(),
          client.websocket.startRecording(),
          client.console.startRecording(),
          client.sources.enable(),
        ]),
        UNRESPONSIVE_WAIT_MS,
        'enabling the recording domains (traffic, events, console, script search will be empty)'
      );
    }

    return client;
  }

  /**
   * Navigates and waits for 'domcontentloaded' by default. Waiting for network idle can spin forever on streaming sites and games.
   * @param {string} url
   * @param {import('puppeteer-core').WaitForOptions} [options]
   * @returns {Promise<import('puppeteer-core').HTTPResponse | null>}
   */
  async goto(url, options = {}) {
    const opts = {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout !== undefined ? options.timeout : GOTO_TIMEOUT_MS,
      ...options,
    };

    try {
      return await this.page.goto(url, opts);
    } catch (err) {
      if (String(err instanceof Error ? err.message : err).includes('timeout')) {
        const readyState = await this.page
          .evaluate(() => document.readyState)
          .catch(() => null);
        if (readyState && readyState !== 'loading') {
          return null; // Page content already loaded into DOM
        }
      }
      throw err;
    }
  }

  /**
   * Sets page viewport size and device metrics (default: 1280x800 desktop).
   * @param {{ width?: number, height?: number, deviceScaleFactor?: number, isMobile?: boolean }} [viewport]
   * @returns {Promise<void>}
   */
  async setViewport(viewport = {}) {
    const defaultVp = {
      width: viewport.width || 1280,
      height: viewport.height || 800,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
      isMobile: viewport.isMobile || false,
    };
    await this.page.setViewport(defaultVp);
  }

  /**
   * Gets current page URL (post-redirect, sync). This is the source of truth
   * for where the tab actually is — not the URL passed to `goto()`.
   * @returns {string}
   */
  url() {
    return this.page.url();
  }

  /**
   * @returns {Promise<string>}
   */
  async title() {
    return this.page.title();
  }

  /**
   * @returns {Promise<string>}
   */
  async content() {
    return this.dom.getHtml();
  }

  // screenshot() was removed: an LLM agent reads DOM, not images. The raw
  // path stays reachable via client.page.screenshot() if ever needed — but
  // note a minimized Chrome window suspends compositing and hangs
  // captureScreenshot; only Browser.setWindowBounds('normal') revives it.

  /**
   * @template {unknown[]} P
   * @template R
   * @param {string | ((...args: import('puppeteer-core').InnerParams<P>) => R)} expressionOrFn
   * @param {P} args
   * @returns {Promise<Awaited<R>>}
   */
  async evaluate(expressionOrFn, ...args) {
    return this.console.evaluate(expressionOrFn, ...args);
  }

  /**
   * @returns {Promise<void>}
   */
  async closePage() {
    await this._release();
    try {
      const pages = await this.browser.pages();
      if (pages.length > 1) {
        await this.page.close();
      } else {
        await this.page.goto('about:blank');
      }
    } catch (error) {
      if (!/Target closed|Session closed|Connection closed/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  /**
   * Disconnects from the browser. Chrome keeps running.
   */
  async disconnect() {
    await this._release();
    await this.browser.disconnect();
  }

  /**
   * Stops every recording, detaches the debugger, and closes the worker tracker if this tab owns it.
   * The debugger cleanup is bounded: on a blocked renderer it never answers, and detaching the
   * session removes the pause-exception setting anyway.
   * @returns {Promise<void>}
   */
  _release() {
    this.network.stopRecording();
    this.websocket.stopRecording();
    this.console.stopRecording();
    const debugOff = this.debug.disable();
    if (this._ownsWorkers && this.workers) this.workers.close();
    return settleWithin(debugOff, CLEANUP_WAIT_MS, 'the debugger cleanup').then(() => {});
  }

  /**
   * @returns {Promise<void>}
   */
  async closeBrowser() {
    await this._release();
    await this.browser.close();
  }
}

module.exports = ChromeClient;
