'use strict';
const fs = require('node:fs');
const { attach, core, EVAL_PROTOCOL_TIMEOUT_MS, release, untilNotPaused, waitForFrame } = require('../cli/session');
const { emit } = require('../cli/output');
const { isHttpUrl, takeFlag } = require('../cli/args');
const { messageOf } = require('../util');

/** @typedef {import('../cli/session').Ctx} Ctx */
/** @typedef {import('../cli/session').Client} Client */

/** @param {Ctx} ctx */
async function cmdEval({ args, port }) {
  const frame = takeFlag(args, '--frame');
  // --file reads the expression from a file: no shell quoting of regexes, quotes or newlines.
  const file = takeFlag(args, '--file');
  const first = args[1];
  const navigates = first && isHttpUrl(first);
  const expression = file ? fs.readFileSync(file, 'utf8') : (navigates ? args.slice(2) : args.slice(1)).join(' ');
  if (!expression.trim()) {
    throw new Error('Usage: node cli.js eval [url] <expression> [--frame <url part>] [--file <script.js>] — pass a URL to navigate first, or omit it to evaluate on the current tab');
  }

  const client = (await attach(port, { protocolTimeout: EVAL_PROTOCOL_TIMEOUT_MS }));
  if (navigates) await client.goto(first);
  if (frame) await waitForFrame(client, frame);
  const result = await untilNotPaused(frame ? client.visual.frame(frame).evaluate(expression) : client.evaluate(expression));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));

  // Tab stays open — follow-up commands and evals inherit the page state.
  await release(client);
}

/**
 * Reads `break [url] <scriptQuery> <line> [flags]`. The leading URL is optional: it navigates first.
 * @param {string[]} args
 */
function parseBreakArgs(args) {
  const raw = args.slice(1);
  const url = raw[0] && isHttpUrl(raw[0]) ? raw.shift() : null;
  /** @type {{ col: number, condition: string | null, evalExpr: string | null, timeoutS: number, hold: boolean, pauseExc: boolean, trigger: string | null }} */
  const opts = { col: 0, condition: null, evalExpr: null, timeoutS: 15, hold: false, pauseExc: false, trigger: null };
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--col') opts.col = Number(raw[++i]);
    else if (a === '--condition') opts.condition = raw[++i];
    else if (a === '--eval') opts.evalExpr = raw[++i];
    else if (a === '--timeout') opts.timeoutS = Number(raw[++i]);
    else if (a === '--hold') opts.hold = true;
    else if (a === '--exceptions') opts.pauseExc = true;
    else if (a === '--trigger') opts.trigger = raw[++i];
    else pos.push(a);
  }
  const [scriptQuery, lineStr] = pos;
  if (!scriptQuery || lineStr === undefined) {
    throw new Error('Usage: node cli.js break [url] <scriptQuery> <line> [--col N] [--condition expr] [--eval expr] [--trigger js] [--timeout S] [--hold] [--exceptions]');
  }
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 0) throw new Error(`Invalid line: ${lineStr} (0-based, so UI line minus 1)`);
  if (!Number.isFinite(opts.col) || opts.col < 0) throw new Error(`Invalid --col: ${raw[raw.indexOf('--col') + 1]}`);
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) throw new Error('--timeout expects seconds, e.g. --timeout 20');
  return { url, scriptQuery, line, ...opts };
}

/**
 * Sets the breakpoint on the script the query names. The line is given script-relative, as the agent reads it.
 * @param {Client} client
 * @param {string} scriptQuery a scriptId (all digits), or a URL or URL substring
 * @param {number} line
 * @param {number} col
 * @param {string | null} condition
 */
async function setScriptBreakpoint(client, scriptQuery, line, col, condition) {
  // A bare number is a scriptId: the only way to break inside a script with no URL (eval, Function, a
  // decoded payload). URL matching cannot name such a script.
  if (/^\d+$/.test(scriptQuery)) {
    // A numeric query is a scriptId, and an id from the previous page is a mistake worth naming: the ids are only
    // valid for the load that produced them.
    if (!client.sources.getScripts().some((s) => s.scriptId === scriptQuery)) {
      throw new Error(`Script ${scriptQuery} is not in this page (scriptIds change on navigation: list them again with: node cli.js vm-scripts).`);
    }
    const result = await client.debug.setBreakpointAtLocation(scriptQuery, line, col, condition || undefined);
    return { bp: { breakpointId: result.breakpointId, locations: [result.actualLocation] }, targetUrl: `scriptId ${scriptQuery}`, matchedScripts: 1 };
  }
  // Resolve the query to a concrete script URL when possible: exact URLs resolve breakpoints immediately
  // (locations[] non-empty); an unmatched pattern still registers a logical breakpoint that fires on future loads.
  const known = client.sources.getScripts({ url: scriptQuery });
  const targetUrl = known.length ? known[0].url : scriptQuery;
  // setBreakpointByUrl counts lines from the top of the document, but the agent reads script-relative lines.
  // Inline scripts have startLine > 0, so the offset is added; external .js files have startLine 0.
  const startLine = known.length ? (known[0].startLine || 0) : 0;
  // An exact URL is the only form setBreakpointByUrl matches on, so an unresolved query becomes a substring regex.
  const bp = known.length
    ? await client.debug.setBreakpoint(targetUrl, line + startLine, col, condition || undefined)
    : await client.debug.setBreakpointForUrlContaining(scriptQuery, line, condition || undefined, col);
  return { bp, targetUrl, matchedScripts: known.length };
}

/**
 * Resolves with the next pause, or null after `timeoutS` seconds.
 * @param {Client} client
 * @param {number} timeoutS
 */
function waitForPause(client, timeoutS) {
  return new Promise((resolve) => {
    if (client.debug.paused) return resolve(client.debug.paused);
    const onP = (/** @type {unknown} */ ev) => { clearTimeout(to); resolve(ev); };
    const to = setTimeout(() => { client.debug.off('paused', onP); resolve(null); }, timeoutS * 1000);
    client.debug.once('paused', onP);
  });
}

/**
 * The call stack of a pause, with each frame's URL resolved through its scriptId.
 * @param {Client} client
 * @param {{ callFrames?: Array<import('devtools-protocol').Protocol.Debugger.CallFrame> }} hit
 */
function describeFrames(client, hit) {
  // CallFrame.url is deprecated: resolve the script through location.scriptId instead.
  const urlByScriptId = new Map(client.sources.getScripts().map((s) => [s.scriptId, s.url]));
  return (hit.callFrames || []).map((f) => ({
    callFrameId: f.callFrameId,
    functionName: f.functionName || '(anonymous)',
    scriptId: f.location?.scriptId,
    url: (f.location?.scriptId && urlByScriptId.get(f.location.scriptId)) || '',
    lineNumber: f.location?.lineNumber,
    columnNumber: f.location?.columnNumber,
    scopeTypes: (f.scopeChain || []).map((s) => s.type),
  }));
}

/**
 * Evaluates `expr` in the paused top frame. A failure is returned as `{ error }`, not thrown.
 * @param {Client} client
 * @param {string} callFrameId
 * @param {string} expr
 */
async function evaluateOnTop(client, callFrameId, expr) {
  try {
    return await client.debug.evaluateOnCallFrame(callFrameId, expr);
  } catch (err) {
    return { error: messageOf(err).split('\n')[0] };
  }
}

/**
 * One-shot breakpoint: set it, wait for the hit, capture the stack, optionally evaluate on the top frame, then resume.
 * The page is frozen while paused, so resume runs even on error. The CDP session ends with this command, and
 * Chrome resumes any page still paused when it detaches; --hold cannot keep a pause past the command.
 * Multi-step debugging does not survive across CLI calls (each call opens a new CDP session); write a .tmp/ script
 * against client.debug for that (references/api.md).
 * @param {Ctx} ctx
 */
async function cmdBreak({ args, port, outFile }) {
  const o = parseBreakArgs(args);
  const client = (await attach(port));
  if (o.url) await client.goto(o.url);
  await client.debug.enable({ pauseOnExceptions: o.pauseExc });
  await client.sources.enable();
  const { bp, targetUrl, matchedScripts } = await setScriptBreakpoint(client, o.scriptQuery, o.line, o.col, o.condition);

  // Runs the action in this same session, so the pause lands on this breakpoint. Not awaited: the page
  // may pause inside the action's own script, and this call would then never return.
  if (o.trigger) client.evaluate(o.trigger).catch((/** @type {unknown} */ err) => console.error(`trigger failed: ${messageOf(err)}`));

  const hit = await waitForPause(client, o.timeoutS);
  const base = { breakpointId: bp.breakpointId, targetUrl, line: o.line, column: o.col, locations: bp.locations, matchedScripts };
  let evalResult = null;
  try {
    if (!hit) {
      const why = bp.locations?.length
        ? `The line resolved to ${bp.locations.length} location(s) but did not run in that window.`
        : matchedScripts
          ? `Line ${o.line} has no code to pause on in the matched script (a blank or comment line, or a line the page never reaches).`
          : `No loaded script matched "${o.scriptQuery}", so nothing could pause.`;
      await emit({
        ...base,
        hit: false,
        note: `no pause within ${o.timeoutS}s. ${why} The breakpoint lives only inside this command and is removed when it exits. Run the action in the same command with --trigger "<js>", e.g. --trigger "document.getElementById('lazy').click()".`,
      }, outFile);
    } else {
      const frames = describeFrames(client, hit);
      if (o.evalExpr && frames.length) evalResult = await evaluateOnTop(client, frames[0].callFrameId, o.evalExpr);
      await emit({
        ...base,
        hit: true,
        reason: hit.reason,
        hitBreakpoints: hit.hitBreakpoints || [],
        callFrames: frames,
        ...(evalResult !== null ? { eval: evalResult } : {}),
        resumed: true,
      }, outFile);
    }
  } finally {
    try { await client.debug.resume(); } catch {}
    if (o.hold) console.error('[warn] --hold does not keep the page paused after this command exits: the page was resumed. Put the action in the same command with --trigger.');
  }

  await release(client);
}

/** Waits for the next Debugger.paused, ignoring any pause already held (a step resumes first). */
/** @param {Client} client @param {number} timeoutS */
function waitNextPause(client, timeoutS) {
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const onPause = (/** @type {unknown} */ event) => {
      clearTimeout(timer);
      resolve(event);
    };
    client.debug.once('paused', onPause);
    timer = setTimeout(() => {
      client.debug.off('paused', onPause);
      resolve(null);
    }, timeoutS * 1000);
  });
}

/**
 * One pause, N steps, one report. A CLI call is one CDP session and Chrome resumes a paused page when the
 * session detaches, so stepping cannot be split across calls: the breakpoint, the trigger, the steps and the
 * reads all happen here (like `break --eval`, but repeated).
 * @param {Ctx} ctx
 */
async function cmdStep({ args, port, outFile }) {
  const direction = args.includes('--into') ? 'into' : args.includes('--out') ? 'out' : 'over';
  const pauseNow = args.includes('--pause');
  for (const flag of ['--into', '--out', '--pause']) {
    if (args.includes(flag)) args.splice(0, args.length, ...args.filter((a) => a !== flag));
  }
  const times = Number(takeFlag(args, '--times') ?? 1);
  if (!Number.isInteger(times) || times < 1 || times > 50) throw new Error('--times expects 1-50, e.g. --times 5');
  const evalExpr = takeFlag(args, '--eval');
  const timeoutS = Number(takeFlag(args, '--timeout') ?? 10);
  const o = pauseNow ? null : parseBreakArgs(args);

  const client = (await attach(port));
  if (o?.url) await client.goto(o.url);
  await client.debug.enable({ pauseOnExceptions: o?.pauseExc });
  // The script map is the debugger's; enabling it here keeps the mask and the frame URLs working.
  await client.sources.enable();

  let hit = null;
  let start = {};
  if (pauseNow) {
    const paused = waitNextPause(client, timeoutS);
    await client.debug.pause();
    hit = await paused;
    start = { mode: 'pause' };
  } else if (o) {
    const { bp, targetUrl, matchedScripts } = await setScriptBreakpoint(client, o.scriptQuery, o.line, o.col, o.condition);
    start = { targetUrl, line: o.line, column: o.col, locations: bp.locations, matchedScripts };
    if (o.trigger) client.evaluate(o.trigger).catch((/** @type {unknown} */ err) => console.error(`trigger failed: ${messageOf(err)}`));
    hit = await waitForPause(client, o.timeoutS);
  }
  if (!hit) {
    await emit({ ...start, hit: false, note: `no pause within ${timeoutS}s, so there was nothing to step. Arm it with --trigger "<js>" (a breakpoint only fires while this command is attached).` }, outFile);
    await release(client);
    return;
  }

  /** @type {Array<{ step: number, functionName: string, url: string, line: number, column: number, frames: number, note?: string }>} */
  const stops = [];
  const describe = (/** @type {any} */ event) => {
    const frames = describeFrames(client, event);
    const top = frames[0] || { functionName: '(none)', url: '', lineNumber: -1, columnNumber: -1 };
    return { functionName: top.functionName, url: top.url, line: (top.lineNumber ?? -1) + 1, column: (top.columnNumber ?? 0) + 1, frames: frames.length };
  };
  stops.push({ step: 0, ...describe(hit), note: 'entry' });

  for (let i = 1; i <= times; i++) {
    const next = waitNextPause(client, timeoutS);
    const stepFn = direction === 'into' ? () => client.debug.stepInto() : direction === 'out' ? () => client.debug.stepOut() : () => client.debug.stepOver();
    await stepFn();
    const event = await next;
    if (!event) {
      stops.push({ step: i, functionName: '(no pause)', url: '', line: -1, column: -1, frames: 0, note: `the page did not pause again within ${timeoutS}s (the frame returned, or execution left the script)` });
      break;
    }
    hit = event;
    stops.push({ step: i, ...describe(event) });
  }

  const frames = describeFrames(client, hit);
  let evalResult = null;
  if (evalExpr && frames.length) evalResult = await evaluateOnTop(client, frames[0].callFrameId, evalExpr);
  await emit({
    ...start,
    hit: true,
    direction,
    steps: stops.length - 1,
    stops,
    callFrames: frames,
    ...(evalResult !== null ? { eval: evalResult } : {}),
    resumed: true,
  }, outFile);
  try { await client.debug.resume(); } catch {}
  await release(client);
}

/** Resumes the page if a live CLI command holds a pause on it. @param {Ctx} ctx */
async function cmdResume({ port }) {
  const held = core().DebugController.readPauseMarker();
  if (!held) {
    console.log('The page is not paused.');
    return;
  }
  const client = (await attach(port));
  await client.cdp.send('Debugger.enable').catch(() => {});
  await client.cdp.send('Debugger.resume');
  core().DebugController.clearPauseMarker({ force: true });
  console.log(`Resumed. It was paused at ${held.url || held.scriptId}:${held.line} (${held.reason}), held by pid ${held.pid}.`);
  await release(client);
}

module.exports = {
  cmdEval,
  parseBreakArgs,
  waitForPause,
  describeFrames,
  cmdBreak,
  waitNextPause,
  cmdStep,
  cmdResume,
};
