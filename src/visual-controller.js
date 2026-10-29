'use strict';

// Windows virtual-key codes for the keys games usually read.
/** @type {Record<string, number>} */
const KEY_CODES = {
  Space: 32, Enter: 13, Escape: 27, Shift: 16, Control: 17, Alt: 18, Tab: 9,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
  MetaLeft: 91, MetaRight: 92, CapsLock: 20, Insert: 45,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Backspace: 8, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

/** `KeyW` -> 87, `Digit1` -> 49, otherwise the table above. */
/** @param {string} code */
function keyCodeOf(code) {
  if (KEY_CODES[code] !== undefined) return KEY_CODES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].codePointAt(0);
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1].codePointAt(0);
  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return 111 + Number(fn[1]);
  throw new Error(`Unknown key code "${code}". Use a KeyboardEvent.code such as KeyW, Space, ArrowLeft, ShiftLeft (or KeyA-KeyZ, Digit0-Digit9, F1-F12).`);
}

/**
 * Canvas and iframe access. The DOM controller cannot see canvas drawings or iframe content, so this file works
 * with coordinates and pixels. Input goes through CDP so it reaches iframes, shadow roots and cross-origin frames
 * the same way a real mouse would.
 */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ width: number, height: number, cssWidth: number, cssHeight: number, scaleX: number, scaleY: number, rect: Rect, dataUrl: string }} CanvasRead */
/** @typedef {{ rect: Rect, bitmap: { width: number, height: number }, scroll: Point }} CanvasInfo */

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

class VisualController {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession} cdpSession
   * @param {import('./dom-controller')} dom used to revive an occluded window before input
   */
  constructor(page, cdpSession, dom) {
    this._page = page;
    this._cdp = cdpSession;
    this._dom = dom;
  }

  /** Every child frame of the page (the main frame is excluded). */
  frames() {
    return this._page.frames().filter((f) => f !== this._page.mainFrame());
  }

  /**
   * Finds a child frame. `spec` is one of:
   *  - a number: the index in frames() (as listed by `frames`)
   *  - a string: substring of the frame URL. Git Bash rewrites a leading "/" into
   *    "C:/Program Files/Git/", so that prefix is stripped before matching
   *  - a RegExp tested against the URL
   * @param {number | string | RegExp} spec
   * @returns {import('puppeteer-core').Frame}
   */
  frame(spec) {
    const frames = this.frames();
    if (typeof spec === 'number' || /^\d+$/.test(String(spec))) {
      const f = frames[Number(spec)];
      if (!f) throw new Error(`No frame at index ${spec}; the page has ${frames.length} child frame(s). List them with: node cli.js frames`);
      return f;
    }
    const needle = spec instanceof RegExp ? spec : String(spec).replace(/^[A-Z]:\/+Program Files\/+Git/i, '');
    const matches = (/** @type {string} */ url) => (needle instanceof RegExp ? needle.test(url) : url.includes(needle));
    const found = frames.find((f) => matches(f.url()));
    if (!found) {
      const shown = frames.slice(0, 5).map((f, i) => `  ${i}: ${f.url().slice(0, 100)}`).join('\n');
      throw new Error(`No frame whose URL matches "${needle}". ${frames.length} child frame(s):\n${shown}${frames.length > 5 ? '\n  ...' : ''}\nList them with: node cli.js frames`);
    }
    return found;
  }

  /**
   * Prepares the page for synthesized input. `settle` waits for network idle and is only worth it right after a
   * navigation; DOMController.ensureVisible handles focus without raising the window when it can.
   * @param {{ settle?: boolean }} [options]
   */
  async prepareInput({ settle = false } = {}) {
    if (settle) await this._settle();
    await this._dom.ensureVisible();
  }

  /**
   * Waits for the page to go quiet before input. The first press after a navigation is dropped while the page loads,
   * and a page that polls the network never goes quiet, hence the 3 s cap. Not used by default: an action on an
   * already-loaded page does not need it, and it made every click cost up to 3 s.
   */
  _settle() {
    return this._page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
  }

  /** Top-left of a child frame inside the page, in CSS px. */
  /** @param {string | RegExp} frame @returns {Promise<Point>} */
  async _frameOffset(frame) {
    const el = await this.frame(frame).frameElement();
    const box = el ? await el.boundingBox() : null;
    if (!box) throw new Error('Frame element has no box (hidden or detached)');
    return { x: box.x, y: box.y };
  }

  /** @param {number} x @param {number} y @param {string | RegExp} [frame] @returns {Promise<Point>} */
  async _toPage(x, y, frame) {
    if (!frame) return { x, y };
    const off = await this._frameOffset(frame);
    return { x: x + off.x, y: y + off.y };
  }

  /**
   * @param {'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'} type
   * @param {Point} at
   * @param {Record<string, unknown>} [extra]
   */
  async _mouse(type, at, extra = {}) {
    await this._cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, ...extra });
  }

  /**
   * Sends a real mouse click through Input.dispatchMouseEvent. Coordinates are
   * relative to the frame's top-left when `frame` is given, else to the page.
   * @param {number} x
   * @param {number} y
   * @param {{ frame?: string | RegExp, button?: 'left' | 'middle' | 'right', clickCount?: number, settle?: boolean }} [options]
   */
  async click(x, y, { frame, button = 'left', clickCount = 1, settle = false } = {}) {
    const at = await this._toPage(x, y, frame);
    await this.prepareInput({ settle });
    const pressed = BUTTON_MASK[button]; // bitmask of the buttons held down
    await this._mouse('mouseMoved', at, { button: 'none', buttons: 0 });
    // Chromium drops a press that arrives in the same frame as the move it follows
    await sleep(50);
    await this._mouse('mousePressed', at, { button, buttons: pressed, clickCount });
    // A human press lasts ~100 ms. Games poll the button once per frame, so an instant release
    // can be missed entirely when the app polls button state once per frame.
    await sleep(100);
    await this._mouse('mouseReleased', at, { button, buttons: 0, clickCount });
  }

  /**
   * Press, move in small steps, release — the input a game reads for aiming, dragging a map, or a slider.
   * The intermediate moves matter: a single jump to the end is often ignored as a teleport.
   * @param {Point} from @param {Point} to
   * @param {{ frame?: string | RegExp, button?: 'left' | 'middle' | 'right', steps?: number, stepMs?: number, settle?: boolean }} [options]
   */
  async drag(from, to, { frame, button = 'left', steps = 12, stepMs = 16, settle = false } = {}) {
    const start = await this._toPage(from.x, from.y, frame);
    const end = await this._toPage(to.x, to.y, frame);
    await this.prepareInput({ settle });
    const pressed = BUTTON_MASK[button];
    await this._mouse('mouseMoved', start, { button: 'none', buttons: 0 });
    await sleep(50);
    await this._mouse('mousePressed', start, { button, buttons: pressed, clickCount: 1 });
    await sleep(60);
    // Sequential by design: a game samples the pointer once per frame, so the moves have to arrive in order and
    // spread over time. Promise.all would collapse the drag into one teleport, which most games ignore.
    for (let i = 1; i <= steps; i++) {
      const at = { x: start.x + (end.x - start.x) * (i / steps), y: start.y + (end.y - start.y) * (i / steps) };
      await this._mouse('mouseMoved', at, { button: 'none', buttons: pressed }); // NOSONAR S9382
      if (stepMs > 0) await sleep(stepMs); // NOSONAR S9382
    }
    await sleep(60);
    await this._mouse('mouseReleased', end, { button, buttons: 0, clickCount: 1 });
  }

  /**
   * Scrolls with a real mouse wheel. Coordinates default to the middle of the frame, which is where a game listens.
   * @param {number} dx @param {number} dy
   * @param {{ frame?: string | RegExp, x?: number, y?: number, settle?: boolean }} [options]
   */
  async wheel(dx, dy, { frame, x, y, settle = false } = {}) {
    const at = await this._toPage(x ?? 0, y ?? 0, frame);
    if (x === undefined || y === undefined) {
      const vp = await this._page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const center = await this._toPage(vp.w / 2, vp.h / 2, frame);
      at.x = center.x;
      at.y = center.y;
    }
    await this.prepareInput({ settle });
    await this._cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: dx, deltaY: dy, button: 'none', buttons: 0 });
  }

  /** @param {string} code */
  _keyBase(code) {
    const keyCode = keyCodeOf(code);
    // KeyboardEvent.key: the character for letters and digits, a space for Space, otherwise the name
    const key = code === 'Space' ? ' ' : code.replace(/^Key/, '').replace(/^Digit/, '');
    return { code, key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  }

  /**
   * Holds one key (or a chord: `['KeyW', 'ShiftLeft']`) for `holdMs`. Games read held keys from keydown and keyup,
   * so a tap is not enough for movement. All keys go down before any comes up, which is what a chord is.
   * @param {string | string[]} codes KeyboardEvent.code, e.g. 'KeyW', 'Space', 'ArrowLeft'
   * @param {{ holdMs?: number, settle?: boolean }} [options] default 0 (a plain tap)
   */
  async key(codes, { holdMs = 0, settle = false } = {}) {
    const list = Array.isArray(codes) ? codes : [codes];
    await this.prepareInput({ settle });
    // Sequential by design: a chord is an order, not a batch. Every key must go down before any comes up,
    // and the releases run in reverse, so the page sees the same sequence a person would produce.
    for (const code of list) await this._cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...this._keyBase(code) }); // NOSONAR S9382
    if (holdMs > 0) await sleep(holdMs);
    for (const code of [...list].reverse()) await this._cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...this._keyBase(code) }); // NOSONAR S9382
  }

  /**
   * Keeps WebGL drawing buffers so `canvas()` can read them. Without it a WebGL canvas reads back blank once composited.
   * Applies to documents created after this call, so the page reloads (`canvas --preserve` does that).
   * Prefer `canvasScreenshot()`, which captures the composited pixels without a reload.
   */
  async preserveWebGL() {
    await this._page.evaluateOnNewDocument(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      /** @type {(this: HTMLCanvasElement, type: string, options?: CanvasRenderingContext2DSettings & WebGLContextAttributes) => RenderingContext | null} */
      const patched = function (type, options) {
        const webgl = type.startsWith('webgl');
        return original.call(this, type, webgl ? { ...options, preserveDrawingBuffer: true } : options);
      };
      // note: getContext is overloaded per context id; the patch forwards every call to the original, so the
      // cast only tells TypeScript that the single signature is compatible with all overloads.
      HTMLCanvasElement.prototype.getContext = /** @type {typeof HTMLCanvasElement.prototype.getContext} */ (/** @type {unknown} */ (patched));
    });
  }

  /**
   * Every canvas in the document (or the frame), with the numbers an agent needs to choose one:
   * index, bitmap size, CSS size and whether it is visible. Game pages carry ad canvases, and the
   * game canvas is often created last, so index 0 is not a safe default.
   * @param {{ frame?: string | RegExp }} [options]
   * @returns {Promise<Array<{ index: number, id?: string, width: number, height: number, cssWidth: number, cssHeight: number, visible: boolean }>>}
   */
  async listCanvases({ frame } = {}) {
    const owner = frame ? this.frame(frame) : this._page.mainFrame();
    return owner.evaluate(() => [...document.querySelectorAll('canvas')].map((el, index) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        index,
        id: el.id || undefined,
        width: el.width,
        height: el.height,
        cssWidth: Math.round(r.width),
        cssHeight: Math.round(r.height),
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      };
    }));
  }

  /**
   * Where the canvas is and how its bitmap relates to its on-screen size. A game canvas is often scaled by CSS,
   * and then a game coordinate and a page coordinate are not the same number.
   * @param {{ frame?: string | RegExp, index?: number }} [options]
   * @returns {Promise<CanvasInfo>}
   */
  async canvasInfo({ frame, index = 0 } = {}) {
    const owner = frame ? this.frame(frame) : this._page.mainFrame();
    const info = await owner.evaluate((/** @type {number} */ i) => {
      const el = document.querySelectorAll('canvas')[i];
      if (!el) return { error: `no canvas at index ${i}` };
      const r = el.getBoundingClientRect();
      return {
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        bitmap: { width: el.width, height: el.height },
        scroll: { x: scrollX, y: scrollY },
      };
    }, index);
    if ('error' in info) throw new Error(`canvas read failed: ${info.error}`);
    return info;
  }

  /**
   * Reads one canvas as a PNG data URL inside the frame that owns it. Exact pixels for a 2D canvas; a WebGL canvas
   * reads blank unless the app keeps its drawing buffer (use `canvasScreenshot()` for that).
   * @param {{ frame?: string | RegExp, index?: number }} [options] index into the frame's canvases (default 0)
   * @returns {Promise<CanvasRead>}
   */
  async canvas({ frame, index = 0 } = {}) {
    const info = await this.canvasInfo({ frame, index });
    const owner = frame ? this.frame(frame) : this._page.mainFrame();
    /** @type {{ dataUrl: string } | { error: string }} */
    const result = await owner.evaluate((/** @type {number} */ i) => {
      const el = document.querySelectorAll('canvas')[i];
      if (!el) return { error: `no canvas at index ${i}` };
      try {
        return { dataUrl: el.toDataURL('image/png') };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }, index);
    if ('error' in result) throw new Error(`canvas read failed: ${result.error}`);
    const scaleX = info.rect.width ? info.bitmap.width / info.rect.width : 1;
    const scaleY = info.rect.height ? info.bitmap.height / info.rect.height : 1;
    return { width: info.bitmap.width, height: info.bitmap.height, cssWidth: Math.round(info.rect.width), cssHeight: Math.round(info.rect.height), scaleX, scaleY, rect: info.rect, dataUrl: result.dataUrl };
  }

  /**
   * Captures what the compositor shows for the canvas, so WebGL renders without `preserveDrawingBuffer` and
   * without reloading the tab. This is the pixel path for games (HUD overlays are included, like a screenshot).
   * @param {{ frame?: string | RegExp, index?: number }} [options]
   * @returns {Promise<{ buffer: Buffer, width: number, height: number, cssWidth: number, cssHeight: number }>}
   */
  async canvasScreenshot({ frame, index = 0 } = {}) {
    const info = await this.canvasInfo({ frame, index });
    let x = info.rect.x, y = info.rect.y;
    if (frame) {
      const off = await this._frameOffset(frame);
      x += off.x;
      y += off.y;
    } else {
      x += info.scroll.x;
      y += info.scroll.y;
    }
    const width = Math.max(1, Math.round(info.rect.width));
    const height = Math.max(1, Math.round(info.rect.height));
    const shot = await this._cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: 1 },
      captureBeyondViewport: true,
      fromSurface: true,
    });
    return { buffer: Buffer.from(shot.data, 'base64'), width, height, cssWidth: width, cssHeight: height };
  }
}

module.exports = VisualController;
