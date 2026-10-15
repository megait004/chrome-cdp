'use strict';

const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

/**
 * Controller for DOM queries, interactions, security inspections, and content extraction.
 */
class DOMController {
  /**
   * @param {import('puppeteer').Page} page
   * @param {import('puppeteer').CDPSession} [cdpSession]
   */
  constructor(page, cdpSession = null) {
    if (!page) throw new TypeError('Page instance is required for DOMController');
    this._page = page;
    this._cdp = cdpSession;
  }

  /**
   * Revives an occluded window before keyboard interaction. When the Chrome
   * window is covered or on an unshown virtual desktop (`visibilityState:
   * 'hidden'` even with `hasFocus()` true), Chromium silently drops
   * synthesized keyboard input — keyboard.type() produces no events at all.
   * A minimized→normal bounds dance forces real window activation (measured:
   * hidden→visible and keys flow; bringToFront and setWebLifecycleState do
   * not help).
   * @returns {Promise<void>}
   */
  async _ensureVisible() {
    let vis;
    try {
      vis = await this._page.evaluate(() => document.visibilityState);
    } catch { return; } // detached context — nothing to revive
    if (vis === 'visible' || !this._cdp) return;
    try {
      const { windowId } = await this._cdp.send('Browser.getWindowForTarget');
      await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await new Promise((r) => setTimeout(r, 300));
      await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await new Promise((r) => setTimeout(r, 500));
    } catch {} // best effort — the typed text may land in a visible case only
  }

  /**
   * Sets or updates active CDP session.
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  setCDPSession(cdpSession) {
    this._cdp = cdpSession;
  }

  /**
   * Finds a single element matching selector.
   * @param {string} selector
   * @returns {Promise<import('puppeteer').ElementHandle | null>}
   */
  async $(selector) {
    return this._page.$(selector);
  }

  /**
   * Compact list of interactive elements currently in the DOM — the agent's
   * eyes. Read this before acting and after every action, so selectors are
   * picked from what the page actually shows, not from memory.
   * @param {string} [selector] restrict the scan to a subtree
   * @returns {Promise<{ url: string, readyState: string, count: number, elements: Array<object> }>}
   */
  async interactiveSnapshot(selector) {
    return this._page.evaluate((scope) => {
      const SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [onclick], summary, label[for]';
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const seen = new Set();
      const elements = [];
      for (const el of root.querySelectorAll(SELECTOR)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.value || el.placeholder, 60);
        const key = el.tagName + '|' + el.id + '|' + text;
        if (seen.has(key)) continue;
        seen.add(key);
        elements.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          name: el.name || undefined,
          type: el.type && el.tagName !== 'BUTTON' ? el.type : undefined,
          text: text || undefined,
          href: el.tagName === 'A' ? clean(el.href, 80) : undefined,
          placeholder: clean(el.placeholder, 40) || undefined,
          value: clean(el.value, 40) || undefined,
          disabled: el.disabled || undefined,
          inViewport: (rect.top < innerHeight && rect.bottom > 0) || undefined,
        });
        if (elements.length >= 150) break;
      }
      return { url: location.href, readyState: document.readyState, count: elements.length, elements };
    }, selector || '');
  }

  /**
   * Human-style click: find the interactive element whose visible text matches
   * (exact match wins over substring, case-insensitive) and click it.
   * @param {string} text
   * @returns {Promise<{ tag: string, text: string } | null>} what was clicked, or null if nothing matched
   */
  async clickByText(text) {
    return this._page.evaluate((target) => {
      const SELECTOR = 'a, button, [role=button], [role=tab], [onclick], summary, input[type=submit], input[type=button]';
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(target);
      let exact = null, partial = null;
      for (const el of document.querySelectorAll(SELECTOR)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const t = norm(el.innerText || el.value);
        if (t === want) { exact = el; break; }
        if (!partial && t.includes(want)) partial = el;
      }
      const el = exact || partial;
      if (!el) return null;
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
    }, text);
  }

  /**
   * Presses a keyboard key on the focused element (Enter, Tab, Escape, ...).
   * @param {string} key
   * @returns {Promise<void>}
   */
  async press(key) {
    await this._ensureVisible(); // occluded windows swallow synthesized keys
    await this._page.keyboard.press(key);
  }

  /**
   * Finds all elements matching selector.
   * @param {string} selector
   * @returns {Promise<Array<import('puppeteer').ElementHandle>>}
   */
  async $$(selector) {
    return this._page.$$(selector);
  }

  /**
   * Clicks an element matching selector.
   * Uses direct DOM focus and click to prevent IntersectionObserver hang in background/minimized windows.
   * @param {string} selector
   * @param {import('puppeteer').ClickOptions} [options]
   */
  async click(selector, options) {
    await this._page.waitForSelector(selector);
    try {
      await this._page.$eval(selector, (el) => {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        if (typeof el.focus === 'function') {
          el.focus();
        }
        el.click();
      });
    } catch {
      await this._page.click(selector, options);
    }
  }

  /**
   * Types text into an element matching selector.
   * @param {string} selector
   * @param {string} text
   * @param {{ delay?: number }} [options]
   */
  async type(selector, text, options) {
    await this._page.waitForSelector(selector, { visible: true });
    await this._ensureVisible(); // occluded windows swallow synthesized keys
    await this._page.type(selector, text, options);
    // Verify the keys landed; if the revive failed they were dropped silently.
    const readBack = await this.getValue(selector).catch(() => null);
    if (readBack === null || !String(readBack).includes(text)) {
      // note: fallback is CDP Input.insertText — delivered even while occluded
      // (measured). Focus + select-all first, so it replaces the content
      // deterministically instead of appending at an unknown cursor. It fires
      // only an `input` event, no keydown/keyup — keystroke-dependent UIs
      // (autocomplete-on-keypress) may need a visible window; upgrade path:
      // per-key insertText loop.
      await this._page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.focus();
        // setSelectionRange throws InvalidStateError on email/number inputs —
        // focus alone is enough there: insertText lands at the caret.
        try { el.setSelectionRange(0, el.value.length); } catch {}
      }, selector);
      await this._cdp.send('Input.insertText', { text });
    }
  }

  /**
   * Clears existing value and sets new value for an input or textarea element.
   * Goes through the element prototype's native value setter: frameworks like
   * React track the last value on the element and ignore plain `.value =`
   * assignment, so the synthetic event would carry no change. The native
   * setter bypasses that tracker and `input`/`change` then carry the update.
   * If the app still ignores it, use `type()` — real per-key events are what
   * framework-controlled inputs can never dedupe away.
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    await this._page.waitForSelector(selector, { visible: true });
    await this._page.evaluate(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      selector,
      value
    );
  }

  /**
   * Gets current value of an input or textarea element.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getValue(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.value);
  }

  /**
   * Gets trimmed text content of an element.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getText(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.textContent.trim());
  }

  /**
   * Gets attribute value of an element.
   * @param {string} selector
   * @param {string} attribute
   * @returns {Promise<string | null>}
   */
  async getAttribute(selector, attribute) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
  }

  /**
   * Gets outer HTML of element matching selector.
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getOuterHtml(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.outerHTML);
  }

  /**
   * Gets full page HTML.
   * @returns {Promise<string>}
   */
  async getHtml() {
    return this._page.content();
  }

  /**
   * Inspects detailed properties of an element (attributes, computed styles, visibility, rect).
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async inspectElement(selector) {
    await this._page.waitForSelector(selector);
    const elementData = await this._page.$eval(selector, (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      const attributes = {};
      for (const attr of el.attributes) {
        attributes[attr.name] = attr.value;
      }

      const isVisible = !(
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0
      );

      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || '',
        className: el.className || '',
        attributes,
        value: el.value !== undefined ? el.value : null,
        text: el.textContent?.trim() || '',
        isVisible,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        computedStyle: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          zIndex: style.zIndex,
          position: style.position,
        },
        hasShadowRoot: Boolean(el.shadowRoot),
      };
    });

    if (this._cdp) {
      try {
        elementData.eventListeners = await this.getEventListeners(selector);
      } catch {
        elementData.eventListeners = [];
      }
    }

    return elementData;
  }

  /**
   * Audits registered DOM event listeners on an element, 'window', or 'document' via CDP DOMDebugger.
   * Crucial for finding DOM XSS sinks, PostMessage handlers, and hidden action handlers.
   * @param {string} [target='window'] - CSS selector or 'window' or 'document'
   * @returns {Promise<Array<object>>}
   */
  async getEventListeners(target = 'window') {
    if (!this._cdp) {
      throw new Error('CDPSession is required to audit event listeners via DOMDebugger');
    }

    let expression;
    if (target === 'window') {
      expression = 'window';
    } else if (target === 'document') {
      expression = 'document';
    } else {
      expression = `document.querySelector(${JSON.stringify(target)})`;
    }

    const { result } = await this._cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
    });

    if (!result || result.subtype === 'null' || !result.objectId) {
      throw new Error(`Target not found for event listeners: ${target}`);
    }

    const response = await this._cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
      depth: -1,
    });

    return (response.listeners || []).map((l) => ({
      type: l.type,
      useCapture: l.useCapture,
      passive: l.passive,
      once: l.once,
      scriptId: l.scriptId,
      lineNumber: l.lineNumber,
      columnNumber: l.columnNumber,
      handlerDescription: l.handler?.description || null,
    }));
  }

  /**
   * Dumps all HTML forms, methods, actions, and their input fields.
   * Essential for bug bounty parameter and endpoint discovery.
   * @returns {Promise<Array<object>>}
   */
  async dumpForms() {
    return this._page.evaluate(() => {
      return Array.from(document.forms).map((form, index) => {
        const inputs = Array.from(form.elements).map((el) => ({
          name: el.name || '',
          id: el.id || '',
          tagName: el.tagName.toLowerCase(),
          type: el.type || '',
          value: el.value || '',
          required: el.required || false,
          disabled: el.disabled || false,
        }));

        return {
          index,
          id: form.id || '',
          name: form.name || '',
          action: form.action || '',
          method: (form.method || 'GET').toUpperCase(),
          enctype: form.enctype || 'application/x-www-form-urlencoded',
          inputs,
        };
      });
    });
  }

  /**
   * Dumps hidden inputs and elements styled with display:none / visibility:hidden.
   * Frequently used to extract CSRF tokens, internal IDs, and hidden API flags.
   * @returns {Promise<Array<object>>}
   */
  async dumpHiddenInputs() {
    return this._page.evaluate(() => {
      const items = [];

      document.querySelectorAll('input[type="hidden"]').forEach((el) => {
        items.push({
          category: 'input[type="hidden"]',
          name: el.name || '',
          id: el.id || '',
          value: el.value || '',
          formAction: el.form?.action || null,
        });
      });

      document
        .querySelectorAll('[hidden], [style*="display: none"], [style*="display:none"]')
        .forEach((el) => {
          items.push({
            category: 'css_hidden',
            tagName: el.tagName.toLowerCase(),
            id: el.id || '',
            className: el.className || '',
            text: el.textContent?.trim().slice(0, 100) || '',
          });
        });

      return items;
    });
  }

  /**
   * Dumps localStorage and sessionStorage contents.
   * @returns {Promise<{ localStorage: object, sessionStorage: object }>}
   */
  async dumpStorage() {
    return this._page.evaluate(() => {
      const local = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          local[k] = window.localStorage.getItem(k);
        }
      } catch {}

      const session = {};
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          session[k] = window.sessionStorage.getItem(k);
        }
      } catch {}

      return {
        localStorage: local,
        sessionStorage: session,
      };
    });
  }

  /**
   * Installs an in-page monitor to audit window.postMessage calls and message event listeners.
   * @returns {Promise<void>}
   */
  async hookPostMessage() {
    await this._page.evaluateOnNewDocument(() => {
      if (window.__postMessageHookInstalled) return;
      window.__postMessageHookInstalled = true;
      window.__postMessageLogs = [];

      const originalAddEventListener = window.addEventListener;
      const originalRemoveEventListener = window.removeEventListener;
      // Keep the wrapper addressable, otherwise the page's own removeEventListener('message', fn)
      // silently does nothing and the handler stays attached for the rest of the session.
      const wrappers = new WeakMap();

      window.addEventListener = function (type, listener, options) {
        if (type === 'message' && listener) {
          let wrappedListener = wrappers.get(listener);
          if (!wrappedListener) {
            wrappedListener = function (event) {
              window.__postMessageLogs.push({
                direction: 'received',
                origin: event.origin,
                data: event.data,
                timestamp: Date.now(),
              });
              return typeof listener === 'function'
                ? listener.apply(this, arguments)
                : listener.handleEvent(event);
            };
            wrappers.set(listener, wrappedListener);
          }
          return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return originalAddEventListener.apply(this, arguments);
      };

      window.removeEventListener = function (type, listener, options) {
        const wrappedListener = type === 'message' && listener ? wrappers.get(listener) : null;
        if (wrappedListener) {
          return originalRemoveEventListener.call(this, type, wrappedListener, options);
        }
        return originalRemoveEventListener.apply(this, arguments);
      };

      const originalPostMessage = window.postMessage;
      window.postMessage = function (message, targetOrigin, transfer) {
        window.__postMessageLogs.push({
          direction: 'sent',
          targetOrigin,
          data: message,
          timestamp: Date.now(),
        });
        return originalPostMessage.apply(this, arguments);
      };
    });
  }

  /**
   * Retrieves recorded postMessage logs.
   * @returns {Promise<Array<object>>}
   */
  async getPostMessageLogs() {
    return this._page.evaluate(() => window.__postMessageLogs || []);
  }

  /**
   * Loads current page HTML into Cheerio for fast local DOM traversal.
   * @returns {Promise<import('cheerio').CheerioAPI>}
   */
  async toCheerio() {
    const html = await this.getHtml();
    return cheerio.load(html);
  }

  /**
   * Extracts primary article content and converts it to GitHub Flavored Markdown.
   * @param {{ headingStyle?: 'setext' | 'atx', codeBlockStyle?: 'indented' | 'fenced' }} [options]
   * @returns {Promise<{ title: string, byline?: string, excerpt?: string, markdown: string, textContent: string } | null>}
   */
  async toMarkdown(options = {}) {
    const html = await this.getHtml();
    const url = this._page.url();

    const dom = new JSDOM(html, { url });
    let article;
    try {
      article = new Readability(dom.window.document, { keepClasses: false }).parse();
    } finally {
      dom.window.close();
    }

    if (!article?.content) {
      return null;
    }

    const turndown = new TurndownService({
      headingStyle: options.headingStyle || 'atx',
      codeBlockStyle: options.codeBlockStyle || 'fenced',
      hr: '---',
      bulletListMarker: '-',
    });
    turndown.use(gfm);

    const markdownBody = turndown.turndown(article.content);
    const fullMarkdown = article.title
      ? `# ${article.title}\n\n${markdownBody}`
      : markdownBody;

    return {
      title: article.title || '',
      byline: article.byline || '',
      excerpt: article.excerpt || '',
      textContent: article.textContent || '',
      markdown: fullMarkdown,
    };
  }
}

module.exports = DOMController;
