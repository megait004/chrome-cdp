'use strict';

// Windows virtual-key codes for the keys games usually read. Others: not supported yet.
/** @type {Record<string, number>} */
const KEY_CODES = {
  Space: 32, Enter: 13, Escape: 27, Shift: 16, Control: 17,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};

/** `KeyW` -> 87, `Digit1` -> 49, otherwise the table above. */
/** @param {string} code */
function keyCodeOf(code) {
  if (KEY_CODES[code] !== undefined) return KEY_CODES[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].codePointAt(0);
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1].codePointAt(0);
  throw new Error(`Unknown key code "${code}". Use a KeyboardEvent.code such as KeyW, Space, ArrowLeft.`);
}

/**
 * Canvas and iframe access. The DOM controller cannot see canvas drawings or iframe content, so this file works
 * with coordinates and pixels.
 */
/** What the page-side read returns: the PNG, or the browser's reason it failed. */
/** @typedef {{ width: number, height: number, dataUrl: string } | { error: string }} CanvasRead */

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
   * Keeps WebGL drawing buffers so `canvas()` can read them. Without it a WebGL canvas reads back blank once composited.
   * Applies to documents created after this call, so the page reloads (`canvas --preserve` does that).
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
   * Sends a real mouse click through Input.dispatchMouseEvent. Coordinates are
   * relative to the frame's top-left when `frame` is given, else to the page.
   * @param {number} x
   * @param {number} y
   * @param {{ frame?: string | RegExp, button?: 'left' | 'middle' | 'right', clickCount?: number }} [options]
   */
  async click(x, y, { frame, button = 'left', clickCount = 1 } = {}) {
    let ox = 0, oy = 0;
    if (frame) {
      const box = await this.frame(frame).frameElement().then((el) => el?.boundingBox() ?? null);
      if (!box) throw new Error('Frame element has no box (hidden or detached)');
      ox = box.x; oy = box.y;
    }
    await this._settle(); // first: the window can be covered while the page is still loading
    await this._dom.ensureVisible(); // a hidden window drops synthesized mouse events
    const at = { x: x + ox, y: y + oy, button };
    const pressed = { left: 1, right: 2, middle: 4 }[button]; // bitmask of the buttons held down
    await this._cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, buttons: 0 });
    // Chromium drops a press that arrives in the same frame as the move it follows
    await new Promise((r) => setTimeout(r, 50));
    await this._cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: pressed, clickCount });
    // A human press lasts ~100 ms. Games poll the button once per frame, so an instant release
    // can be missed entirely when the app polls button state once per frame.
    await new Promise((r) => setTimeout(r, 100));
    await this._cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0, clickCount });
  }

  /**
   * Waits for the page to go quiet before input. The first press after a navigation is dropped while the page loads.
   * Capped at 3 s, because a page that polls the network never goes quiet.
   */
  _settle() {
    return this._page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
  }

  /**
   * Holds a key down for `holdMs`. Games read held keys from keydown and keyup, so a tap is not enough for movement.
   * Input goes to the focused element.
   * @param {string} code KeyboardEvent.code, e.g. 'KeyW', 'Space', 'ArrowLeft'
   * @param {{ holdMs?: number }} [options] default 0 (a plain tap)
   */
  async key(code, { holdMs = 0 } = {}) {
    await this._settle(); // first: the window can be covered while the page is still loading
    await this._dom.ensureVisible(); // a hidden window drops synthesized key events
    // Keys go to the focused window only (mouse does not need focus), so raise it when it lacks focus
    if (!(await this._page.evaluate(() => document.hasFocus()))) await this._page.bringToFront();
    const keyCode = keyCodeOf(code);
    // KeyboardEvent.key: the character for letters and digits, a space for Space, otherwise the name
    const key = code === 'Space' ? ' ' : code.replace(/^Key/, '').replace(/^Digit/, '');
    const base = { code, key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this._cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    await this._cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /**
   * Reads one canvas as a PNG data URL inside the frame that owns it. Fails if cross-origin images taint the canvas.
   * WebGL canvases read blank unless the app keeps its drawing buffer.
   * @param {{ frame?: string | RegExp, index?: number }} [options] index into the frame's canvases (default 0)
   * @returns {Promise<{ width: number, height: number, dataUrl: string }>}
   */
  async canvas({ frame, index = 0 } = {}) {
    const owner = frame ? this.frame(frame) : this._page.mainFrame();
    /** @type {CanvasRead} */
    const result = await owner.evaluate((i) => {
      const el = document.querySelectorAll('canvas')[i];
      if (!el) return { error: `no canvas at index ${i}` };
      try {
        return { width: el.width, height: el.height, dataUrl: el.toDataURL('image/png') };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }, index);
    if ('error' in result) throw new Error(`canvas read failed: ${result.error}`);
    return result;
  }
}

module.exports = VisualController;
