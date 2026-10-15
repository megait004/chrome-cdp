'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const DOMController = require('./dom-controller');
const NetworkController = require('./network-controller');
const WebSocketController = require('./websocket-controller');
const ConsoleController = require('./console-controller');
const SourceController = require('./source-controller');
const WorkerController = require('./worker-controller');
const DebugController = require('./debug-controller');
const PerformanceController = require('./performance-controller');

// Register stealth plugin once globally on puppeteer-extra
puppeteer.use(StealthPlugin());

/**
 * Unified high-level Chrome CDP Client.
 * Orchestrates DOM manipulation, network inspection, console interaction, and source analysis.
 */
class ChromeClient {
  /**
   * @param {import('puppeteer').Browser} browser
   * @param {import('puppeteer').Page} page
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  constructor(browser, page, cdpSession, workerController = null) {
    this.browser = browser;
    this.page = page;
    this.cdp = cdpSession;

    this.dom = new DOMController(page, cdpSession);
    this.network = new NetworkController(page, cdpSession);
    this.websocket = new WebSocketController(cdpSession);
    this.console = new ConsoleController(page, cdpSession);
    this.sources = new SourceController(cdpSession);
    this.debug = new DebugController(cdpSession);
    this.performance = new PerformanceController(page, cdpSession);
    this._ownsWorkers = !workerController;
    this.workers = workerController || new WorkerController(browser);
  }

  /**
   * Connects to a running Chrome instance via CDP port and initializes an active page session.
   * @param {{
   *   port?: number,
   *   browserURL?: string,
   *   browserWSEndpoint?: string,
   *   autoEnableAll?: boolean,
   *   protocolTimeout?: number
   * }} [options]
   * @returns {Promise<ChromeClient>}
   */
  static async connect(options = {}) {
    const browserURL =
      options.browserURL ||
      (options.browserWSEndpoint ? undefined : `http://127.0.0.1:${options.port || 9222}`);

    const connectOpts = {
      defaultViewport: null,
      protocolTimeout: options.protocolTimeout || 30000,
    };

    if (options.browserWSEndpoint) {
      connectOpts.browserWSEndpoint = options.browserWSEndpoint;
    } else {
      connectOpts.browserURL = browserURL;
    }

    const browser = await puppeteer.connect(connectOpts);

    const pages = await browser.pages();
    let page = pages.length > 0 ? pages[0] : await browser.newPage();
    if (page.url().startsWith('chrome://')) {
      await page.goto('about:blank');
    }
    const cdp = await page.createCDPSession();

    const client = new ChromeClient(browser, page, cdp);
    await client.workers.ready;

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
    const client = new ChromeClient(this.browser, page, cdp, this.workers);
    await client.workers.ready;

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
   * @param {import('puppeteer').WaitForOptions} [options]
   * @returns {Promise<import('puppeteer').HTTPResponse | null>}
   */
  async goto(url, options = {}) {
    const opts = {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout !== undefined ? options.timeout : 15000,
      ...options,
    };

    try {
      return await this.page.goto(url, opts);
    } catch (err) {
      if (err.message?.includes('timeout')) {
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
   * @param {string | Function} expressionOrFn
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
    this.network.stopRecording();
    this.websocket.stopRecording();
    this.console.stopRecording();
    this.debug.disable();
    if (this._ownsWorkers) this.workers.close();
    try {
      const pages = await this.browser.pages();
      if (pages.length > 1) {
        await this.page.close();
      } else {
        await this.page.goto('about:blank');
      }
    } catch (error) {
      if (!/Target closed|Session closed|Connection closed/i.test(error.message)) throw error;
    }
  }

  /**
   * Disconnects CDP client from browser (keeps Chrome running).
   */
  disconnect() {
    this.network.stopRecording();
    this.websocket.stopRecording();
    this.console.stopRecording();
    this.debug.disable();
    if (this._ownsWorkers) this.workers.close();
    this.browser.disconnect();
  }

  /**
   * Closes browser completely.
   * @returns {Promise<void>}
   */
  async closeBrowser() {
    this.network.stopRecording();
    this.websocket.stopRecording();
    this.console.stopRecording();
    this.debug.disable();
    if (this._ownsWorkers) this.workers.close();
    await this.browser.close();
  }
}

module.exports = ChromeClient;
