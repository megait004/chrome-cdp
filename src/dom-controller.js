'use strict';

const cheerio = require('cheerio');
const { WINDOW_HIDE_WAIT_MS, WINDOW_SHOW_WAIT_MS } = require('./timeouts');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

/** @typedef {import('./types/snapshot').SnapshotElement} SnapshotElement */
/** @typedef {import('./types/snapshot').InteractiveSnapshot} InteractiveSnapshot */
/** An element that may carry a form value, placeholder, name, type, href, or disabled flag. Each is optional: not every element has it. */
/** @typedef {HTMLElement & { value?: string, placeholder?: string, name?: string, type?: string, href?: string, disabled?: boolean }} FormLikeElement */
/** A form control as read by dumpForms; every property is optional because not every element has it. */
/** @typedef {HTMLElement & { name?: string, type?: string, value?: string, required?: boolean, disabled?: boolean }} FormControlLike */
/** One recorded postMessage event, sent by the page or received from another window. */
/** @typedef {{ direction: 'sent' | 'received', origin?: string, targetOrigin?: string | WindowPostMessageOptions, data: unknown, timestamp: number }} PostMessageLog */
/** The page window with the state that hookPostMessage keeps on it. */
/** @typedef {Window & { __postMessageHookInstalled?: boolean, __postMessageLogs: PostMessageLog[] }} HookedWindow */

// Page-side functions: puppeteer serializes the function it is given, so each one must be self-contained
// (it cannot call its neighbours) — that is why the interactive-element selector is repeated where needed.

/**
 * Runs in the page. Scrolls the element into view and reports why it cannot be acted on.
 * @param {Node} node
 * @returns {string} '' when the element is actionable, else the reason
 */
function refusalReasonInPage(node) {
  const el = /** @type {HTMLElement & { disabled?: boolean }} */ (node);
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
  if (el.disabled) return 'disabled';
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit && hit !== el && !el.contains(hit)) {
    const label = hit.id ? '#' + hit.id : '';
    return 'covered by <' + hit.tagName.toLowerCase() + label + '>';
  }
  return '';
}

/**
 * Runs in the page: focus and click at DOM level, because a pointer click waits on IntersectionObserver
 * in background windows.
 * @param {Node} node
 */
function domClickInPage(node) {
  const el = /** @type {HTMLElement} */ (node);
  if (typeof el.focus === 'function') {
    el.focus();
  }
  el.click();
}

/**
 * Runs in the page: the interactive element whose visible text matches (exact beats substring).
 * @param {string} target
 * @returns {Element | null}
 */
function findTextElementInPage(target) {
  const SELECTOR = 'a, button, [role=button], [role=tab], [onclick], summary, input[type=submit], input[type=button]';
  const norm = (/** @type {string | null | undefined} */ s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(target);
  let exact = null, partial = null;
  for (const el of /** @type {NodeListOf<FormLikeElement>} */ (document.querySelectorAll(SELECTOR))) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const t = norm(el.innerText || el.value);
    if (t === want) { exact = el; break; }
    if (!partial && t.includes(want)) partial = el;
  }
  return exact || partial;
}

class DOMController {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession | null} [cdpSession]
   */
  constructor(page, cdpSession = null) {
    if (!page) throw new TypeError('Page instance is required for DOMController');
    this._page = page;
    this._cdp = cdpSession;
  }

  /**
   * Brings the window back to visible before keyboard input. A hidden window drops synthesized keys without an error;
   * a minimize-then-restore forces the real activation.
   * @returns {Promise<void>}
   */
  async ensureVisible() {
    let vis;
    try {
      vis = await this._page.evaluate(() => document.visibilityState);
    } catch { return; } // detached context — nothing to revive
    if (vis === 'visible' || !this._cdp) return;
    // Poll for the state we asked for instead of fixed sleeps: returns as soon as
    // Chromium has applied the bounds change, and gives up after `ms` (best effort).
    const awaitState = async (/** @type {string} */ want, /** @type {number} */ ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const state = await this._page.evaluate(() => document.visibilityState).catch(() => null); // NOSONAR S9382
        if (state === want) return;
        await new Promise((r) => setTimeout(r, 50)); // NOSONAR S9382
      }
    };
    try {
      const { windowId } = await this._cdp.send('Browser.getWindowForTarget');
      await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await awaitState('hidden', WINDOW_HIDE_WAIT_MS);
      await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await awaitState('visible', WINDOW_SHOW_WAIT_MS);
    } catch {} // best effort — the typed text may land in a visible case only
  }

  /**
   * @param {string} selector
   * @returns {Promise<import('puppeteer-core').ElementHandle | null>}
   */
  async $(selector) {
    return this._page.$(selector);
  }

  /**
   * Lists the interactive elements in the DOM, so selectors come from what the page shows now.
   * @param {string} [selector] restrict the scan to a subtree
   * @param {import('puppeteer-core').Frame | import('puppeteer-core').Page} [frame] scan this frame instead of the page (iframes, games)
   * @returns {Promise<InteractiveSnapshot | null>}
   */
  async interactiveSnapshot(selector, frame = this._page) {
    return frame.evaluate((scope) => {
      const SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [onclick], summary, label[for]';
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return null;
      const clean = (/** @type {string | null | undefined} */ s, /** @type {number} */ n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      // No dedupe by tag+id+text: querySelectorAll returns each element once, so such a key can only
      // collapse distinct elements (two unnamed inputs with no text look identical).
      const elements = [];
      let matched = 0;
      for (const el of /** @type {NodeListOf<FormLikeElement>} */ (root.querySelectorAll(SELECTOR))) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // count reports every interactive element; the list stops at 150 so the reply stays small.
        matched += 1;
        if (elements.length >= 150) continue;
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.value || el.placeholder, 60);
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
      }
      return { url: location.href, readyState: document.readyState, count: matched, truncated: matched > elements.length || undefined, elements };
    }, selector || '');
  }

  /**
   * Human-style click: find the interactive element whose visible text matches
   * (exact match wins over substring, case-insensitive) and click it through the same
   * disabled/covered check the selector path uses.
   * @param {string} text
   * @returns {Promise<{ tag: string, text: string } | null>} what was clicked, or null if nothing matched
   */
  async clickByText(text) {
    const handle = await this._page.evaluateHandle(findTextElementInPage, text);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    try {
      const info = await element.evaluate((node) => {
        const el = /** @type {HTMLElement & { value?: string }} */ (node);
        return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
      });
      const why = await element.evaluate(refusalReasonInPage).catch(() => '');
      if (why) throw new Error(`click refused: text=${text} is ${why}. Nothing was clicked.`);
      await element.evaluate(domClickInPage);
      return info;
    } finally {
      await element.dispose().catch(() => {});
    }
  }

  /**
   * @param {import('puppeteer-core').KeyInput} key
   * @returns {Promise<void>}
   */
  async press(key) {
    await this.ensureVisible(); // occluded windows swallow synthesized keys
    await this._page.keyboard.press(key);
  }

  /**
   * @param {string} selector
   * @returns {Promise<Array<import('puppeteer-core').ElementHandle>>}
   */
  async $$(selector) {
    return this._page.$$(selector);
  }

  /**
   * Clicks an element. Uses DOM focus and click, because a pointer click waits on IntersectionObserver in background windows.
   * @param {string} selector
   * @param {{ timeout?: number } & import('puppeteer-core').ClickOptions} [options]
   *   timeout (ms) bounds the wait for the element; the rest goes to the page.click fallback.
   */
  async click(selector, { timeout, ...clickOptions } = {}) {
    await this._page.waitForSelector(selector, { timeout });
    const handle = await this._page.$(selector);
    if (!handle) {
      await this._page.click(selector, clickOptions);
      return;
    }
    try {
      // Refuse a silent no-op: a disabled element ignores el.click(), and a covering element takes it instead.
      const why = await handle.evaluate(refusalReasonInPage).catch(() => '');
      if (why) throw new Error(`click refused: ${selector} is ${why}. Nothing was clicked.`);
      await handle.evaluate(domClickInPage).catch(async () => {
        // Detached or stale handle: fall back to a real pointer click.
        await this._page.click(selector, clickOptions);
      });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  /**
   * Types text into an element matching selector.
   * @param {string} selector
   * @param {string} text
   * @param {{ timeout?: number, delay?: number }} [options]
   *   timeout (ms) bounds the wait for a visible element; delay is the per-key pause.
   */
  async type(selector, text, { timeout, delay } = {}) {
    await this._page.waitForSelector(selector, { visible: true, timeout });
    // Same refusal as click: a disabled field ignores the keys, a covered one types into the overlay.
    const handle = await this._page.$(selector);
    const why = handle ? await handle.evaluate(refusalReasonInPage).catch(() => '') : '';
    await handle?.dispose().catch(() => {});
    if (why) throw new Error(`type refused: ${selector} is ${why}. Nothing was typed.`);
    await this.ensureVisible(); // occluded windows swallow synthesized keys
    await this._page.type(selector, text, { delay });
    // Verify the keys landed; if the revive failed they were dropped silently.
    const readBack = await this._page.$eval(selector, (node) => {
      const el = /** @type {HTMLElement & { value?: unknown }} */ (node);
      return typeof el.value === 'string' ? el.value : el.textContent;
    }).catch(() => null);
    if (readBack === null || !readBack.includes(text)) {
      // note: fallback is CDP Input.insertText — delivered even while occluded
      // (reported behaviour). Focus + select-all first, so it replaces the content
      // deterministically instead of appending at an unknown cursor. It fires
      // only an `input` event, no keydown/keyup — keystroke-dependent UIs
      // (autocomplete-on-keypress) may need a visible window; upgrade path:
      // per-key insertText loop.
      await this._page.evaluate((sel) => {
        // note: the caller passes inputs and textareas; any other element throws in setSelectionRange and is skipped by the try below.
        const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(sel));
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.focus();
        // setSelectionRange throws InvalidStateError on email/number inputs —
        // focus alone is enough there: insertText lands at the caret.
        try { el.setSelectionRange(0, el.value.length); } catch {}
      }, selector);
      if (!this._cdp) throw new Error('insertText fallback needs a CDP session; this DOMController has none');
      await this._cdp.send('Input.insertText', { text });
    }
  }

  /**
   * Sets a field's value through the native setter. Frameworks such as React ignore a plain `.value =`, so the change
   * event would carry nothing; the native setter fires input and change with the new value.
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    await this._page.waitForSelector(selector, { visible: true });
    await this._page.evaluate(
      (sel, val) => {
        const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(sel));
        if (!el) throw new Error(`Element not found: ${sel}`);
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc?.set) desc.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      selector,
      value
    );
  }

  /**
   * @param {string} selector
   * @returns {Promise<string | undefined>} undefined when the element has no value property
   */
  async getValue(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (node) => /** @type {FormLikeElement} */ (node).value);
  }

  /**
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getText(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.textContent.trim());
  }

  /**
   * @param {string} selector
   * @param {string} attribute
   * @returns {Promise<string | null>}
   */
  async getAttribute(selector, attribute) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
  }

  /**
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async getOuterHtml(selector) {
    await this._page.waitForSelector(selector);
    return this._page.$eval(selector, (el) => el.outerHTML);
  }

  /**
   * @returns {Promise<string>}
   */
  async getHtml() {
    return this._page.content();
  }

  /**
   * @param {string} selector
   * @returns {Promise<object>}
   */
  async inspectElement(selector) {
    await this._page.waitForSelector(selector);
    /** @type {Record<string, unknown>} */
    const elementData = await this._page.$eval(selector, (node) => {
      const el = /** @type {FormLikeElement} */ (node);
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      /** @type {Record<string, string>} */
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
   * @param {string} [target='window'] - CSS selector or 'window' or 'document'
   * @returns {Promise<Array<Pick<import('devtools-protocol').Protocol.DOMDebugger.EventListener, 'type' | 'useCapture' | 'passive' | 'once' | 'scriptId' | 'lineNumber' | 'columnNumber'> & { handlerDescription: string | null }>>}
   */
  /**
   * @param {string} [target] 'window', 'document', or a selector
   * @param {{ pierce?: boolean }} [options] pierce also reports listeners inside iframes and shadow roots
   */
  async getEventListeners(target = 'window', options = {}) {
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

    try {
      // depth -1 covers the whole subtree under the object, so one call on the document lists every element's listeners
      const response = await this._cdp.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId,
        depth: -1,
        pierce: Boolean(options.pierce),
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
    } finally {
      // Fire and forget: the listeners are already parsed, and a blocked renderer never answers this —
      // awaiting it would hang the command after its work is done. The release still has to happen.
      this._cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    }
  }

  /**
   * @returns {Promise<Array<object>>}
   */
  async dumpForms() {
    return this._page.evaluate(() => {
      return Array.from(document.forms).map((form, index) => {
        const inputs = Array.from(form.elements, (node) => {
          const el = /** @type {FormControlLike} */ (node);
          return {
            name: el.name || '',
            id: el.id || '',
            tagName: el.tagName.toLowerCase(),
            type: el.type || '',
            value: el.value || '',
            required: el.required || false,
            disabled: el.disabled || false,
          };
        });

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
   * @returns {Promise<Array<object>>}
   */
  async dumpHiddenInputs() {
    return this._page.evaluate(() => {
      /** @type {Array<Record<string, string | null>>} */
      const items = [];

      document.querySelectorAll('input[type="hidden"]').forEach((node) => {
        const el = /** @type {HTMLInputElement} */ (node);
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
   * @returns {Promise<{ localStorage: object, sessionStorage: object }>}
   */
  async dumpStorage() {
    return this._page.evaluate(() => {
      /** @type {Record<string, string | null>} */
      const local = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i) ?? '';
          local[k] = window.localStorage.getItem(k);
        }
      } catch {}

      /** @type {Record<string, string | null>} */
      const session = {};
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i) ?? '';
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
      const w = /** @type {HookedWindow} */ (/** @type {unknown} */ (window)); // the hook keeps its state on window, which TypeScript does not know
      if (w.__postMessageHookInstalled) return;
      w.__postMessageHookInstalled = true;
      w.__postMessageLogs = [];

      const originalAddEventListener = window.addEventListener;
      const originalRemoveEventListener = window.removeEventListener;
      // Keep the wrapper addressable, otherwise the page's own removeEventListener('message', fn)
      // silently does nothing and the handler stays attached for the rest of the session.
      /** @type {WeakMap<EventListenerOrEventListenerObject, EventListener>} */
      const wrappers = new WeakMap();

      /** @this {Window} @param {string} type @param {EventListenerOrEventListenerObject | null} listener @param {boolean | AddEventListenerOptions} [options] */
      window.addEventListener = function (type, listener, options) {
        if (type === 'message' && listener) {
          let wrappedListener = wrappers.get(listener);
          if (!wrappedListener) {
            /** @this {unknown} @param {Event} event */
            wrappedListener = function (event) {
              const message = /** @type {MessageEvent} */ (event);
              w.__postMessageLogs.push({
                direction: 'received',
                origin: message.origin,
                data: message.data,
                timestamp: Date.now(),
              });
              return typeof listener === 'function'
                ? Reflect.apply(listener, this, arguments)
                : listener.handleEvent(event);
            };
            wrappers.set(listener, wrappedListener);
          }
          return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return Reflect.apply(originalAddEventListener, this, arguments);
      };

      /** @this {Window} @param {string} type @param {EventListenerOrEventListenerObject | null} listener @param {boolean | AddEventListenerOptions} [options] */
      window.removeEventListener = function (type, listener, options) {
        const wrappedListener = type === 'message' && listener ? wrappers.get(listener) : null;
        if (wrappedListener) {
          return originalRemoveEventListener.call(this, type, wrappedListener, options);
        }
        return Reflect.apply(originalRemoveEventListener, this, arguments);
      };

      const originalPostMessage = window.postMessage;
      /** @this {Window} @param {unknown} message @param {string | WindowPostMessageOptions} [targetOrigin] */
      w.postMessage = function (message, targetOrigin) {
        w.__postMessageLogs.push({
          direction: 'sent',
          targetOrigin,
          data: message,
          timestamp: Date.now(),
        });
        return Reflect.apply(originalPostMessage, this, arguments);
      };
    });
  }

  /**
   * @returns {Promise<PostMessageLog[]>}
   */
  async getPostMessageLogs() {
    return this._page.evaluate(() => /** @type {HookedWindow} */ (/** @type {unknown} */ (window)).__postMessageLogs || []);
  }

  /**
   * @returns {Promise<import('cheerio').CheerioAPI>}
   */
  async toCheerio() {
    const html = await this.getHtml();
    return cheerio.load(html);
  }

  /**
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
