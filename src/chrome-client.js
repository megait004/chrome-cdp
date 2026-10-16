'use strict';

// .default is the same object as the module (runtime-identical); the bare require loses its typings under NodeNext
const puppeteer = require('puppeteer-extra').default;
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { PROTOCOL_TIMEOUT_MS, GOTO_TIMEOUT_MS } = require('./timeouts');

const DOMController = require('./dom-controller');
const NetworkController = require('./network-controller');
const WebSocketController = require('./websocket-controller');
const ConsoleController = require('./console-controller');
const SourceController = require('./source-controller');
const WorkerController = require('./worker-controller');
const DebugController = require('./debug-controller');
const PerformanceController = require('./performance-controller');
const VisualController = require('./visual-controller');

// Register stealth plugin once globally on puppeteer-extra
puppeteer.use(StealthPlugin());

/**
 * Unified high-level Chrome CDP Client.
 * Orchestrates DOM manipulation, network inspection, console interaction, and source analysis.
 */
/**
 * Every controller a tab exposes, as ChromeClient wires them.
 * @typedef {{ dom: InstanceType<typeof DOMController>, network: InstanceType<typeof NetworkController>, websocket: InstanceType<typeof WebSocketController>, console: InstanceType<typeof ConsoleController>, sources: InstanceType<typeof SourceController>, debug: InstanceType<typeof DebugController>, performance: InstanceType<typeof PerformanceController>, visual: InstanceType<typeof VisualController> }} Controllers
 */

/**
 * Builds the per-tab controllers. Kept separate so tests can inject fakes.
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

    const pages = await browser.pages();
    const tab = options.tab ?? 0;
    if (tab >= pages.length) throw new Error(`Tab ${tab} does not exist: Chrome has ${pages.length} tab(s). List them with: node cli.js tabs`);
    let page = pages.length > 0 ? pages[tab] : await browser.newPage();
    if (page.url().startsWith('chrome://')) {
      await page.goto('about:blank');
    }
    const cdp = await page.createCDPSession();

    const workers = await WorkerController.create(browser);
    const client = new ChromeClient(browser, page, cdp, { workers, ownsWorkers: true });

    if (options.autoEnableAll !== false) {
      await Promise.all([
        client.network.startRecording(),
        client.websocket.startRecording(),
        client.console.startRecording(),
        client.sources.enable(),
      ]);
    }

    return client;
  }

  /**
   * Creates a new tab and attaches a new CDP session and controllers.
   * @param {{ autoEnableAll?: boolean }} [options]
   * @returns {Promise<ChromeClient>}
   */
  async newPage(options = {}) {
    const page = await this.browser.newPage();
    const cdp = await page.createCDPSession();
    const client = new ChromeClient(this.browser, page, cdp, { workers: this.workers });

    if (options.autoEnableAll !== false) {
      await Promise.all([
        client.network.startRecording(),
        client.websocket.startRecording(),
        client.console.startRecording(),
        client.sources.enable(),
      ]);
    }

    return client;
  }

  /**
   * Navigates to a URL with resilient handling for SPAs, games, and streaming sites.
   * Defaults to 'domcontentloaded' with fallback to prevent indefinite network spinning.
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
   * Gets current page title.
   * @returns {Promise<string>}
   */
  async title() {
    return this.page.title();
  }

  /**
   * Gets current page HTML.
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
   * Evaluates JavaScript in the page context.
   * Shortcut to console.evaluate.
   * @param {string | ((...args: any[]) => any)} expressionOrFn
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async evaluate(expressionOrFn, ...args) {
    return this.console.evaluate(expressionOrFn, ...args);
  }

  /**
   * Converts current page main article to Markdown.
   * Shortcut to dom.toMarkdown.
   * @param {object} [options]
   */
  async toMarkdown(options) {
    return this.dom.toMarkdown(options);
  }

  /**
   * Loads current page into Cheerio.
   * Shortcut to dom.toCheerio.
   */
  async toCheerio() {
    return this.dom.toCheerio();
  }

  /**
   * Closes active tab.
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
   * Disconnects CDP client from browser (keeps Chrome running).
   */
  async disconnect() {
    await this._release();
    await this.browser.disconnect();
  }

  /**
   * Stops every recording, detaches the debugger (its cleanup sends are awaited
   * by the caller), and closes the worker tracker if this tab owns it.
   * @returns {Promise<void>}
   */
  _release() {
    this.network.stopRecording();
    this.websocket.stopRecording();
    this.console.stopRecording();
    const debugOff = this.debug.disable();
    if (this._ownsWorkers && this.workers) this.workers.close();
    return debugOff;
  }

  /**
   * Closes browser completely.
   * @returns {Promise<void>}
   */
  async closeBrowser() {
    await this._release();
    await this.browser.close();
  }
}

module.exports = ChromeClient;
