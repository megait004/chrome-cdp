'use strict';
const T = require('../timeouts');
const { attach, release } = require('../cli/session');
const { emit, interactiveHints } = require('../cli/output');
const { isHttpUrl } = require('../cli/args');
const { messageOf } = require('../util');

/** @typedef {import('../cli/session').Ctx} Ctx */
/** @typedef {import('../cli/session').Client} Client */

/**
 * Canvases and interactive elements of one frame. A frame removed mid-scan yields nothing.
 * @param {Client} client
 * @param {import('puppeteer-core').Frame} frame
 */
async function scanFrame(client, frame) {
  if (frame.detached) return { canvases: [], elements: [] };
  /** @type {string[]} */
  const errors = [];
  const canvases = await frame.evaluate(() => [...document.querySelectorAll('canvas')]
    .map((c, i) => ({ index: i, width: c.width, height: c.height, id: c.id || undefined }))).catch((err) => { errors.push(`canvases: ${messageOf(err)}`); return []; });
  const elements = await client.dom.interactiveSnapshot(undefined, frame).then((s) => s?.elements ?? []).catch((err) => { errors.push(`elements: ${messageOf(err)}`); return []; });
  return { canvases, elements, error: errors.join("; ") || undefined };
}

/** @param {Client} client */
async function frameSnapshots(client) {
  const scans = await Promise.all(client.visual.frames().map(async (frame, index) => ({ index, frame, ...(await scanFrame(client, frame)) })));
  const rows = scans.map(({ index, frame, canvases, elements }) => ({ frame: index, url: frame.url(), canvases, elements }));
  // A frame that is still loading has nothing to report yet. Returning [] then would read as "no iframes",
  // so fall back to the bare URLs; the caller can see the frame exists and read it again.
  const withContent = rows.filter((row) => row.canvases.length || row.elements.length);
  return withContent.length ? withContent : rows;
}

/** @param {Ctx} ctx */
async function cmdSnapshot({ args, port, outFile }) {
  const client = (await attach(port));
  let selector = args[1] && !args[1].startsWith('--') ? args[1] : null;
  if (selector && isHttpUrl(selector)) {
    await client.goto(selector, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    selector = args[2] && !args[2].startsWith('--') ? args[2] : null;
  }
  if (client.url() === 'about:blank') {
    throw new Error('The tab is blank — open a page first: pass a URL, node cli.js click <url> <sel>, or open the page yourself');
  }
  const snap = await client.dom.interactiveSnapshot(selector ?? undefined);
  if (!snap) throw new Error(`No element matches scope selector: ${selector}`);
  await emit({ url: snap.url, readyState: snap.readyState, count: snap.count, elements: snap.elements, frames: await frameSnapshots(client) }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDumpForms({ args, port, outFile }) {
  const url = args[1] && !args[1].startsWith('--') ? args[1] : null;

  const client = (await attach(port));
  if (url) await client.goto(url);

  const forms = await client.dom.dumpForms();
  const hidden = await client.dom.dumpHiddenInputs();

  const result = { url: url || client.url(), forms, hiddenInputs: hidden };
  await emit(result, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdDumpStorage({ args, port, outFile }) {
  const url = args[1] && !args[1].startsWith('--') ? args[1] : null;

  const client = (await attach(port));
  if (url) await client.goto(url);

  const storage = await client.dom.dumpStorage();
  const cookies = await client.network.getCookies();

  const result = { url: url || client.url(), ...storage, cookies };
  await emit(result, outFile);

  await release(client);
}

/** @param {Ctx} ctx */
async function cmdListeners({ args, port, outFile }) {
  const url = isHttpUrl(args[1]) ? args[1] : null;
  const selArg = url ? args[2] : args[1];
  const selector = selArg && !selArg.startsWith('--') ? selArg : 'window';

  const client = (await attach(port));
  if (url) await client.goto(url);

  const listeners = await client.dom.getEventListeners(selector);
  await emit({ url: url || client.url(), target: selector, listeners }, outFile);

  await release(client);
}


/** @typedef {NonNullable<Awaited<ReturnType<Client['dom']['interactiveSnapshot']>>>} Snapshot */

/** @param {Snapshot} snap */
function elementKeys(snap) {
  // The live value belongs to the identity: filling a select or a textarea changes no tag, id or text.
  return snap.elements.map((e) => `${e.tag}|${e.id || ''}|${e.text || ''}|${e.value || ''}`);
}

/**
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
function diffSnapshots(before, after) {
  const beforeKeys = new Set(elementKeys(before));
  const afterKeys = elementKeys(after);
  const urlChanged = before.url !== after.url ? { from: before.url, to: after.url } : undefined;
  const addedAll = afterKeys.filter((k) => !beforeKeys.has(k));
  const removedCount = [...beforeKeys].filter((k) => !afterKeys.includes(k)).length;
  // changed: the element list or URL moved. False does not prove nothing changed: canvas drawing and
  // text-only updates are invisible to this diff. valueMismatch is a failure signal, not a change, so it is excluded.
  const changed = Boolean(urlChanged) || addedAll.length > 0 || removedCount > 0;
  return { urlChanged, changed, added: addedAll.slice(0, 10), addedCount: addedAll.length, removedCount };
}

/**
 * `click <selector>` or `click text=<Text>`. A checkbox or radio reports the state it ended in.
 * @param {Client} client
 * @param {string | undefined} target
 */
async function clickTarget(client, target) {
  if (!target) throw new Error('Usage: node cli.js click <selector|text=Text>');
  if (target.startsWith('text=')) {
    const text = target.slice(5);
    const did = await client.dom.clickByText(text);
    if (!did) throw new Error(`No visible element with text "${text}"`);
    return did;
  }
  await client.dom.click(target, { timeout: T.CLI_ACTION_TIMEOUT_MS });
  // A checkbox or radio click reports nothing else, so say what state it ended in (undefined for other elements).
  const checked = await client.page.$eval(target, (el) => (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined)).catch(() => undefined);
  return { selector: target, checked };
}

/**
 * `type` appends to the field, `fill` replaces it. Either way the value is read back, because the
 * occluded-window revive steals focus and stray human keystrokes can land beside ours.
 * @param {Client} client
 * @param {'type' | 'fill'} action
 * @param {string[]} targets
 */
async function typeOrFill(client, action, targets) {
  let [sel, ...rest] = targets;
  // Forgive a single quoted "<selector> <text>" argument — agents type it.
  if (sel && rest.length === 0 && sel.includes(' ')) {
    const i = sel.indexOf(' ');
    rest = [sel.slice(i + 1)];
    sel = sel.slice(0, i);
  }
  if (!sel || rest.length === 0) throw new Error(`Usage: node cli.js ${action} [url] <selector> <${action === 'fill' ? 'value' : 'text'}>`);
  const text = rest.join(' ');
  if (action === 'type') {
    const before = (await client.dom.getValue(sel).catch(() => '')) ?? '';
    await client.dom.type(sel, text, { timeout: T.CLI_ACTION_TIMEOUT_MS, delay: 30 });
    const actual = await client.dom.getValue(sel).catch(() => null);
    return { selector: sel, typed: text, valueAfter: actual, valueMismatch: actual !== before + text || undefined };
  }
  await client.dom.fill(sel, text);
  const actual = await client.dom.getValue(sel).catch(() => null);
  return { selector: sel, value: text, valueAfter: actual, valueMismatch: actual !== text || undefined };
}

/**
 * Runs one action on the live tab and returns its result fields. Unknown actions do nothing.
 * @param {Client} client
 * @param {string} action
 * @param {string[]} targets
 */
async function performAction(client, action, targets) {
  if (action === 'click') return clickTarget(client, targets[0]);
  if (action === 'type' || action === 'fill') return typeOrFill(client, action, targets);
  if (action === 'press') {
    const key = targets[0];
    if (!key) throw new Error('Usage: node cli.js press <key> (Enter, Tab, Escape, ArrowDown, ...)');
    await client.dom.press(/** @type {import('puppeteer-core').KeyInput} */ (key));
    return { key };
  }
  return null;
}

/**
 * Interaction loop. Each action works on the live tab, returns the DOM change, and never navigates unless
 * a leading URL is given.
 * @param {Ctx} ctx
 */
async function cmdInteract(ctx) {
  const { args, port, outFile, command: action } = ctx;
  const client = (await attach(port));
  const targets = args.slice(1).filter((a) => !a.startsWith('--'));

  // An optional leading URL navigates first, as in every other command.
  if (targets[0] && isHttpUrl(targets[0])) {
    await client.goto(targets.shift() ?? '', { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
  }

  if (client.url() === 'about:blank') {
    throw new Error('The tab is blank — nothing to interact with. Pass a URL, or open the page yourself first');
  }

  const before = await client.dom.interactiveSnapshot();
  if (!before) throw new Error('The page has no document to snapshot');
  // Catch a full navigation started by the action (must be armed first);
  // SPAs change the DOM without one, which the post-action diff covers.
  const navPromise = client.page.waitForNavigation({ timeout: T.CLI_ACTION_TIMEOUT_MS }).catch(() => null);

  let did = null;
  try {
    did = await performAction(client, action, targets);
  } catch (err) {
    // The action failed. Show the closest interactive elements, so the next try uses a selector that exists now.
    const snap = await client.dom.interactiveSnapshot().catch(() => null);
    const suggestions = snap ? interactiveHints(snap.elements, { skipDisabled: true }) : [];
    const hint = suggestions.length ? `\nInteractive elements on the current page:\n  ${suggestions.join('\n  ')}` : '\n(no interactive elements found)';
    throw new Error(`${action} failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}${hint}`);
  }

  // Let the page react: a full navigation resolves navPromise; an SPA
  // mutation needs the dwell. Then a short settle before reading the DOM.
  const nav = await Promise.race([navPromise, new Promise((r) => setTimeout(() => r(null), 800))]);
  await new Promise((r) => setTimeout(r, nav ? 500 : 300));
  const after = await client.dom.interactiveSnapshot();
  if (!after) throw new Error('The page has no document to snapshot');
  const d = diffSnapshots(before, after);

  await emit({
    action,
    ...did,
    ok: true,
    changed: d.changed,
    urlChanged: d.urlChanged,
    readyState: after.readyState,
    // After a full navigation the element diff is meaningless (whole new
    // page) — the URL change is the signal; the diff only matters for SPAs.
    added: d.urlChanged ? undefined : d.added.map((k) => k.split('|').filter(Boolean).slice(0, 3).join(' ')),
    addedCount: d.urlChanged ? undefined : d.addedCount,
    removedCount: d.urlChanged ? undefined : d.removedCount,
    interactiveCount: after.count,
  }, outFile);
  await release(client);
}

/** @param {Ctx} ctx */
async function cmdWait({ args, port, outFile, isJson }) {
  const client = (await attach(port));
  let selector = args[1];
  if (!selector) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S]');
  if (isHttpUrl(selector)) {
    await client.goto(selector, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });
    selector = args[2];
    if (!selector) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S]');
  }
  const tIdx = args.indexOf('--timeout');
  const timeout = tIdx !== -1 ? Number(args[tIdx + 1]) * 1000 : T.CLI_ACTION_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Usage: node cli.js wait [url] <selector> [--timeout S] — S must be seconds, e.g. --timeout 10');
  try {
    await client.page.waitForSelector(selector, { timeout, visible: true });
    const text = await client.dom.getText(selector).catch(() => null);
    await emit({ ok: true, selector, waitedSeconds: timeout / 1000, text: text ? String(text).slice(0, 80) : undefined }, outFile);
  } catch {
    // Timeout is a page-state answer, not a bug: say what IS there.
    const snap = await client.dom.interactiveSnapshot().catch(() => null);
    const lines = snap ? interactiveHints(snap.elements) : [];
    // Say why it failed: a missing element and an element that exists but has no size are different fixes.
    const state = await client.page.evaluate((/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      if (!el) return { exists: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { exists: true, width: Math.round(r.width), height: Math.round(r.height), display: cs.display, visibility: cs.visibility };
    }, selector).catch(() => null);
    let reason = 'not-visible-in-time';
    let why = `"${selector}" did not become visible.`;
    if (state && !state.exists) {
      reason = 'missing';
      why = `No element matches "${selector}".`;
    } else if (state?.exists) {
      reason = 'exists-not-visible';
      why = `"${selector}" exists but is not visible (${state.width}x${state.height}px, display: ${state.display}, visibility: ${state.visibility}). wait needs a visible element.`;
    }
    const waited = timeout / 1000;
    if (isJson) {
      // Machine-readable failure: the same facts as the message, in fields an agent can branch on.
      await emit({ ok: false, selector, reason, waitedSeconds: waited, state, interactive: lines }, outFile);
      process.exitCode = 1;
      await release(client);
      return;
    }
    throw new Error(`${why} Waited ${waited}s. Interactive elements now:\n  ${lines.join('\n  ') || '(none)'}`);
  }
  await release(client);
}

module.exports = {
  scanFrame,
  cmdSnapshot,
  cmdDumpForms,
  cmdDumpStorage,
  cmdListeners,
  elementKeys,
  diffSnapshots,
  cmdInteract,
  cmdWait,
};
