'use strict';
const fs = require('node:fs');
const path = require('node:path');
const T = require('../timeouts');
const { attach, core, release, waitForFrame } = require('../cli/session');
const { emit } = require('../cli/output');
const { takeFlag } = require('../cli/args');
const ROOT = path.join(__dirname, '..', '..');

/** @typedef {import('../cli/session').Ctx} Ctx */
/** @typedef {import('../cli/session').Client} Client */

/**
 * The canvas an agent means when it does not name one: the largest visible canvas.
 * Game pages are full of ad canvases, and the game's own canvas is created last, so index 0 is wrong.
 * @param {Client} client
 * @param {string | null} frame
 * @param {number | null} requested
 * @returns {Promise<number>}
 */
async function resolveCanvasIndex(client, frame, requested) {
  if (requested !== null) return requested;
  const list = await client.visual.listCanvases({ frame: frame ?? undefined });
  if (!list.length) {
    const where = frame ? `in frame "${frame}"` : 'on the page';
    throw new Error(`No <canvas> ${where}. Run: node cli.js canvas --list`);
  }
  const visible = list.filter((c) => c.visible);
  const pool = visible.length ? visible : list;
  pool.sort((a, b) => b.width * b.height - a.width * a.height);
  return pool[0].index;
}

/**
 * Canvas-bitmap pixels -> frame-relative CSS pixels, plus the scale that was applied.
 * A game canvas is often scaled by CSS, so a bitmap pixel is not a CSS pixel.
 * @param {Client} client @param {string | null} frame @param {number | null} requested @param {number} x @param {number} y
 */
async function toCanvasPoint(client, frame, requested, x, y) {
  if (frame) await waitForFrame(client, frame);
  const index = await resolveCanvasIndex(client, frame, requested);
  const info = await client.visual.canvasInfo({ frame: frame ?? undefined, index });
  const scale = { x: info.rect.width ? info.bitmap.width / info.rect.width : 1, y: info.rect.height ? info.bitmap.height / info.rect.height : 1 };
  return { x: info.rect.x + x / scale.x, y: info.rect.y + y / scale.y, scale, bitmap: info.bitmap, index, rect: info.rect };
}

/** @param {Ctx} ctx */
async function cmdClickAt({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  // --button right is needed for games that move the player with the right mouse button.
  const button = takeFlag(args, '--button') ?? 'left';
  if (!['left', 'middle', 'right'].includes(button)) throw new Error(`--button must be left, middle or right (got "${button}")`);
  const indexRaw = takeFlag(args, '--index');
  const requestedIndex = indexRaw === null ? null : Number(indexRaw);
  if (requestedIndex !== null && (!Number.isInteger(requestedIndex) || requestedIndex < 0)) throw new Error('--index expects a canvas index from 0, e.g. --index 1 (see: node cli.js canvas --list)');
  // --canvas: x/y are canvas-bitmap pixels; the CSS size, the canvas offset and the frame offset are added here.
  const canvasRelative = args.includes('--canvas');
  const settle = args.includes('--settle');
  if (canvasRelative) args.splice(0, args.length, ...args.filter((a) => a !== '--canvas'));
  if (settle) args.splice(0, args.length, ...args.filter((a) => a !== '--settle'));
  const [x0, y0] = args.slice(1).map(Number);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) throw new Error('click-at expects two numbers: click-at <x> <y> [--frame <url part>] [--canvas] [--index N]');
  const client = (await attach(port));
  let x = x0, y = y0;
  /** @type {{ x: number, y: number } | undefined} */
  let scale;
  /** @type {{ width: number, height: number } | undefined} */
  let bitmap;
  if (canvasRelative) {
    if (frame) await waitForFrame(client, frame);
    const index = await resolveCanvasIndex(client, frame, requestedIndex);
    const info = await client.visual.canvasInfo({ frame: frame ?? undefined, index });
    // A game canvas is often scaled by CSS: a bitmap pixel is not a CSS pixel. Convert before clicking.
    scale = { x: info.rect.width ? info.bitmap.width / info.rect.width : 1, y: info.rect.height ? info.bitmap.height / info.rect.height : 1 };
    bitmap = info.bitmap;
    x = info.rect.x + x0 / scale.x;
    y = info.rect.y + y0 / scale.y;
  }
  await client.visual.click(x, y, { frame: frame ?? undefined, button: /** @type {'left' | 'middle' | 'right'} */ (button), settle });
  await emit({ ok: true, action: 'click-at', x: x0, y: y0, button, frame: frame ?? null, canvas: canvasRelative, canvasBitmap: bitmap, scale }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdKey({ args, port, outFile }) {
  const hold = takeFlag(args, '--hold');
  const settle = args.includes('--settle');
  if (settle) args.splice(0, args.length, ...args.filter((a) => a !== '--settle'));
  // One or more codes, separated by spaces or '+': `key KeyW ShiftLeft --hold 500` is a chord (run + sprint).
  const codes = args.slice(1).flatMap((a) => a.split('+')).filter(Boolean);
  if (!codes.length) throw new Error('key expects a KeyboardEvent.code: key <KeyW|Space|ArrowLeft> [KeyW+ShiftLeft] [--hold MS]');
  // Keys go to the focused element, not to a frame: a leftover flag would be silently ignored, so refuse it.
  const stray = codes.find((a) => a.startsWith('--'));
  if (stray) throw new Error(`key takes no ${stray}. Keys go to the focused element: click the game first, then key <code...> [--hold MS]`);
  const holdMs = hold === null ? 0 : Number(hold);
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error('--hold expects milliseconds, e.g. --hold 300');
  const client = (await attach(port));
  await client.visual.key(codes, { holdMs, settle });
  await emit({ ok: true, action: 'key', codes, holdMs, settle: settle || undefined }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDrag({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  const button = takeFlag(args, '--button') ?? 'left';
  if (!['left', 'middle', 'right'].includes(button)) throw new Error(`--button must be left, middle or right (got "${button}")`);
  const steps = Number(takeFlag(args, '--steps') ?? 12);
  const indexRaw = takeFlag(args, '--index');
  const requestedIndex = indexRaw === null ? null : Number(indexRaw);
  const canvasRelative = args.includes('--canvas');
  const settle = args.includes('--settle');
  if (canvasRelative) args.splice(0, args.length, ...args.filter((a) => a !== '--canvas'));
  if (settle) args.splice(0, args.length, ...args.filter((a) => a !== '--settle'));
  const nums = args.slice(1).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error('drag expects four numbers: drag <x1> <y1> <x2> <y2> [--frame <part>] [--canvas] [--button left|right|middle] [--steps N]');
  if (!Number.isFinite(steps) || steps < 1 || steps > 200) throw new Error('--steps expects 1-200, e.g. --steps 12');
  const [x1, y1, x2, y2] = nums;
  const client = (await attach(port));
  let from = { x: x1, y: y1 };
  let to = { x: x2, y: y2 };
  /** @type {{ x: number, y: number } | undefined} */
  let scale;
  if (canvasRelative) {
    const a = await toCanvasPoint(client, frame, requestedIndex, x1, y1);
    const b = await toCanvasPoint(client, frame, requestedIndex, x2, y2);
    from = { x: a.x, y: a.y };
    to = { x: b.x, y: b.y };
    scale = a.scale;
  }
  await client.visual.drag(from, to, { frame: frame ?? undefined, button: /** @type {'left' | 'middle' | 'right'} */ (button), steps, settle });
  await emit({ ok: true, action: 'drag', from: [x1, y1], to: [x2, y2], button, frame: frame ?? null, canvas: canvasRelative, scale, steps }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdWheel({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  const atX = takeFlag(args, '--x');
  const atY = takeFlag(args, '--y');
  const indexRaw = takeFlag(args, '--index');
  const requestedIndex = indexRaw === null ? null : Number(indexRaw);
  const canvasRelative = args.includes('--canvas');
  const settle = args.includes('--settle');
  if (canvasRelative) args.splice(0, args.length, ...args.filter((a) => a !== '--canvas'));
  if (settle) args.splice(0, args.length, ...args.filter((a) => a !== '--settle'));
  const [dx, dy] = args.slice(1).map(Number);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('wheel expects two numbers: wheel <dx> <dy> [--frame <part>] [--canvas] [--x N --y N]');
  const client = (await attach(port));
  let x = atX === null ? undefined : Number(atX);
  let y = atY === null ? undefined : Number(atY);
  // A game listens at the canvas, not at 0,0: aim the wheel at its centre unless --x/--y say otherwise.
  if (canvasRelative && (x === undefined || y === undefined)) {
    const p = await toCanvasPoint(client, frame, requestedIndex, 0, 0);
    x = p.rect.x + p.rect.width / 2;
    y = p.rect.y + p.rect.height / 2;
  }
  await client.visual.wheel(dx, dy, { frame: frame ?? undefined, x, y, settle });
  await emit({ ok: true, action: 'wheel', deltaX: dx, deltaY: dy, frame: frame ?? null, canvas: canvasRelative, x: x ?? null, y: y ?? null }, outFile);
  await release(client);
}

/**
 * Reads a frame's canvas size until two samples one second apart agree. A game sets its canvas size
 * after load (and after a preserve reload), so one early sample can report the wrong size.
 * @param {Client} client @param {string} frame @param {number} index
 */
async function waitForStableCanvas(client, frame, index) {
  const sample = () => client.visual.frame(frame).evaluate((i) => {
    const c = document.querySelectorAll('canvas')[i];
    return c ? `${c.width}x${c.height}` : '';
  }, index);
  let previous = await sample();
  return core().waitUntil(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await sample();
    const stable = Boolean(current) && current === previous;
    previous = current;
    return stable;
  }, { timeout: T.CLI_NAV_TIMEOUT_MS, every: 0 }); // false on timeout: no canvas, or a size that never held
}

/** @param {Ctx} ctx */
async function cmdCanvas({ args, port, outFile }) {
  const frame = takeFlag(args, '--frame');
  const indexRaw = takeFlag(args, '--index');
  const requestedIndex = indexRaw === null ? null : Number(indexRaw);
  if (requestedIndex !== null && (!Number.isInteger(requestedIndex) || requestedIndex < 0)) throw new Error('--index expects a canvas index from 0, e.g. --index 1 (see: node cli.js canvas --list)');
  const record = takeFlag(args, '--record');
  const fpsRaw = takeFlag(args, '--fps');
  const screen = args.includes('--screen');
  const list = args.includes('--list');
  if (screen) args.splice(0, args.length, ...args.filter((a) => a !== '--screen'));
  if (list) args.splice(0, args.length, ...args.filter((a) => a !== '--list'));
  const preserveAt = args.indexOf('--preserve');
  const preserve = preserveAt !== -1;
  if (preserve) args.splice(preserveAt, 1);
  const client = (await attach(port));
  if (list) {
    if (frame) await waitForFrame(client, frame);
    const canvases = await client.visual.listCanvases({ frame: frame ?? undefined });
    await emit({ owner: frame ? client.visual.frame(frame).url() : 'main page', canvases, largest: canvases.length ? canvases.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0].index : null }, outFile);
    await release(client);
    return;
  }
  const canvasIndex = await resolveCanvasIndex(client, frame, requestedIndex);
  if (preserve) {
    // Canvases built before this call have no preserved buffer, so the page must be
    // reloaded for the hook to take effect. This resets the game: it is explicit on purpose.
    console.log('Reloading the tab so WebGL canvases keep their drawing buffer (the game restarts)...');
    await client.visual.preserveWebGL();
    await client.page.reload({ waitUntil: 'domcontentloaded' });
  }
  if (frame) {
    await waitForFrame(client, frame);
    if (!(await waitForStableCanvas(client, frame, canvasIndex))) {
      throw new Error(`frame "${frame}" has no settled canvas ${canvasIndex} after ${T.CLI_NAV_TIMEOUT_MS / 1000}s. It may still be loading or not have a canvas: run frames and check the canvases count.`);
    }
  }
  // Say which document was read: a canvas in the main page and one in the game iframe are different things.
  const owner = frame ? client.visual.frame(frame).url() : 'main page';

  if (record !== null) {
    const seconds = Number(record);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('--record expects seconds (0-60), e.g. --record 3');
    if (!outFile) throw new Error('--record writes a PNG sequence: pass --out <dir>, e.g. --out .tmp/frames');
    const fps = Number(fpsRaw ?? 5);
    if (!Number.isFinite(fps) || fps < 1 || fps > 30) throw new Error('--fps expects 1-30, e.g. --fps 10');
    const dir = path.resolve(outFile);
    fs.mkdirSync(dir, { recursive: true });
    const total = Math.max(1, Math.round(seconds * fps));
    const started = Date.now();
    let last = null;
    for (let i = 1; i <= total; i++) {
      // A recording is a timed sequence: each frame is captured, then the loop waits for the next slot.
      // Promise.all would capture N frames at once, all with the same timestamp.
      const shot = await client.visual.canvasScreenshot({ frame: frame ?? undefined, index: canvasIndex }); // NOSONAR S9382
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), shot.buffer);
      last = shot;
      const wait = started + (i * 1000) / fps - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // NOSONAR S9382
    }
    console.log(JSON.stringify({ ok: true, action: 'canvas-record', dir, frames: total, fps, seconds, width: last?.width, height: last?.height, canvasIndex, owner }, null, 2));
    await release(client);
    return;
  }

  if (screen) {
    const shot = await client.visual.canvasScreenshot({ frame: frame ?? undefined, index: canvasIndex });
    const abs = outFile ? path.resolve(outFile) : path.join(ROOT, '.tmp', `canvas-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, shot.buffer);
    console.log(JSON.stringify({ ok: true, action: 'canvas-screen', file: abs, width: shot.width, height: shot.height, bytes: shot.buffer.length, canvasIndex, owner }, null, 2));
    await release(client);
    return;
  }

  const read = await client.visual.canvas({ frame: frame ?? undefined, index: canvasIndex });
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(read.dataUrl.split(',')[1], 'base64'));
    console.log(`Saved ${read.width}x${read.height} PNG to: ${abs} (from ${owner})`);
  } else {
    console.log(`canvas #${canvasIndex} ${read.width}x${read.height} bitmap, ${read.cssWidth}x${read.cssHeight} css, scale ${read.scaleX.toFixed(2)}x${read.scaleY.toFixed(2)} from ${owner}`);
    console.log('pass --out file.png to save the pixels, --screen for a WebGL canvas, --record S --out dir for a sequence');
  }
  await release(client);
}

module.exports = {
  cmdClickAt,
  cmdKey,
  cmdDrag,
  cmdWheel,
  cmdCanvas,
};
