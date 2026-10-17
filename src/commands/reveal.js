'use strict';
// `catch-script`: catch a script the moment before it runs, then stop inside it and read its variables.
//
// Why this exists: a payload built at runtime (eval, Function, a decoded bundle) has no URL, so a URL
// breakpoint cannot name it. Chrome's instrumentation breakpoint reaches every script (V8 attaches it per
// script as it is parsed), and a breakpoint by scriptId reaches inside the payload.
//
// What the two pauses can and cannot do (see references/api.md):
//   - Instrumentation pause: reading script sources and frame positions works; evaluating in a call frame
//     times out, because the renderer's JS thread does not service those requests at this pause.
//   - Breakpoint pause inside a script: evaluating and reading scopes works.
const { messageOf } = require('../util');

/**
 * @typedef {{
 *   reason: string,
 *   script: { scriptId: string, url: string, length: number | null, head: string },
 *   frames: Array<{ functionName: string, scriptId: string, url: string, lineNumber: number, columnNumber: number }>,
 *   callerExcerpt: string | null,
 * }} CatchReport
 */

/**
 * @typedef {InstanceType<typeof import('../chrome-client')>} Client
 * @typedef {{ args: string[], port: number, outFile: string | null }} Ctx
 * @typedef {{
 *   attach: (port: number) => Promise<Client>,
 *   emit: (result: object, outFile: string | null) => Promise<void>,
 *   release: (client: Client) => Promise<void>,
 *   isHttpUrl: (s: string | undefined) => boolean,
 *   T: { CLI_NAV_TIMEOUT_MS: number },
 * }} RevealDeps
 */

/**
 * Pauses as they arrive, in order. Subscribing before the breakpoint is armed removes the race: a pause that
 * lands while the command is busy is queued rather than missed, and a missed pause leaves the page frozen.
 * @param {Client} client
 */
function pauseQueue(client) {
  /** @type {unknown[]} */
  const pending = [];
  /** @type {((event: unknown) => void) | null} */
  let deliver = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const onPaused = (/** @type {unknown} */ event) => {
    if (deliver) {
      const waiting = deliver;
      deliver = null;
      if (timer) clearTimeout(timer);
      waiting(event);
    } else {
      pending.push(event);
    }
  };
  client.debug.on('paused', onPaused);
  return {
    /** @param {number} timeoutS */
    next(timeoutS) {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        timer = setTimeout(() => { deliver = null; resolve(null); }, Math.max(0.5, timeoutS) * 1000);
        deliver = (event) => resolve(event);
      });
    },
    stop() {
      client.debug.off('paused', onPaused);
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Resume, tolerating a pause that ended on its own (a navigation can drop it). Returns false in that case.
 * @param {Client} client
 */
async function resumeIfPaused(client) {
  try {
    await client.debug.resume();
    return true;
  } catch (err) {
    if (!/while paused/.test(messageOf(err))) throw err;
    return false;
  }
}

/**
 * The stack of a pause, with URLs resolved through scriptIds (CallFrame.url is deprecated).
 * @param {Client} client
 * @param {import('devtools-protocol').Protocol.Debugger.PausedEvent} event
 */
function describeFrames(client, event) {
  const urls = new Map(client.sources.getScripts().map((s) => [s.scriptId, s.url]));
  return (event.callFrames ?? []).slice(0, 10).map((f) => ({
    functionName: f.functionName || '(anonymous)',
    scriptId: f.location?.scriptId ?? '',
    url: (f.location?.scriptId && urls.get(f.location.scriptId)) || '',
    lineNumber: f.location?.lineNumber ?? -1,
    columnNumber: f.location?.columnNumber ?? -1,
  }));
}

/**
 * Reports the script about to run, or null when this pause is not the wanted one.
 * @param {Client} client
 * @param {import('devtools-protocol').Protocol.Debugger.PausedEvent} event
 * @param {{ minBytes: number | null, maxBytes: number | null, onlyRuntime: boolean }} options
 * @returns {Promise<CatchReport | null>}
 */
async function describeCandidate(client, event, options) {
  const frames = event.callFrames ?? [];
  // The breakpoint's aux data names the script about to run; frame 0 is inside it.
  const scriptId = /** @type {string} */ (event.data?.scriptId ?? frames[0]?.location?.scriptId ?? '');
  const url = /** @type {string} */ (event.data?.url ?? '');

  // An inline <script> block carries the document URL; the payload this command hunts for has none.
  if (options.onlyRuntime && url !== '') return null;

  // Chrome reports each script's length as it parses, so a size filter can reject a candidate without
  // transferring its source — the payload this command is aimed at can be megabytes.
  const knownLength = client.sources.getScripts().find((s) => s.scriptId === scriptId)?.length ?? null;
  const outOfRange = (/** @type {number} */ length) =>
    (options.minBytes !== null && length < options.minBytes) || (options.maxBytes !== null && length > options.maxBytes);
  if (knownLength !== null && outOfRange(knownLength)) return null;

  let length = null;
  let source = '';
  let sourceError = null;
  try {
    ({ source } = await client.sources.getScriptSource(scriptId));
    length = source.length;
  } catch (err) {
    // WebAssembly has no JavaScript source, and a cleared context loses it: say so instead of guessing a size.
    sourceError = messageOf(err);
    console.error(`source unavailable for script ${scriptId}: ${sourceError}`);
  }
  // With a size filter and no size, the candidate cannot be confirmed: skip it rather than report the wrong one.
  if (length === null && (options.minBytes !== null || options.maxBytes !== null)) return null;
  if (length !== null && outOfRange(length)) return null;

  const caller = frames[1];
  let callerExcerpt = null;
  if (caller?.location?.scriptId) {
    try {
      // A frame's line number counts from the top of the DOCUMENT for an inline script (startLine > 0) and
      // from the script itself otherwise; readAround wants the script's own line.
      const callerStart = client.sources.getScripts().find((s) => s.scriptId === caller.location.scriptId)?.startLine ?? 0;
      const callerLine = Math.max(0, (caller.location.lineNumber ?? 0) - callerStart);
      const callerWindow = await client.sources.readAround(caller.location.scriptId, callerLine, caller.location.columnNumber ?? 0);
      callerExcerpt = callerWindow.text;
    } catch { /* the caller may be a script we cannot read; the frames still name it */ }
  }
  return {
    reason: event.reason ?? '',
    script: { scriptId, url, length, head: source.slice(0, 120).replace(/\s+/g, ' ') },
    frames: describeFrames(client, event),
    callerExcerpt,
  };
}

/** @param {RevealDeps} deps */
function createRevealCommands({ attach, emit, release, isHttpUrl }) {
  /** @param {string[]} args @param {string} name */
  const flag = (args, name) => {
    const index = args.indexOf(name);
    return index > 0 ? args[index + 1] : null;
  };


  /** @param {Ctx} ctx */
  async function cmdCatchScript({ args, port, outFile }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const minBytesArg = flag(args, '--min-bytes');
    const minBytes = minBytesArg === null ? null : Number(minBytesArg);
    const maxBytesArg = flag(args, '--max-bytes');
    const maxBytes = maxBytesArg === null ? null : Number(maxBytesArg);
    const onlyRuntime = args.includes('--only-runtime');
    const breakLineArg = flag(args, '--break-line');
    const breakLine = breakLineArg === null ? null : Number(breakLineArg);
    const breakColArg = flag(args, '--break-col');
    const breakCol = breakColArg === null ? 0 : Number(breakColArg);
    const evalExpr = flag(args, '--eval');
    const frameArg = flag(args, '--frame');
    const evalFrameIndex = frameArg === null ? 0 : Number(frameArg);
    const timeoutSec = Number(flag(args, '--timeout') ?? 30);
    if (minBytes !== null && (!Number.isFinite(minBytes) || minBytes < 0)) throw new Error('--min-bytes expects a number of characters, e.g. --min-bytes 200000');
    if (maxBytes !== null && (!Number.isFinite(maxBytes) || maxBytes <= 0)) throw new Error('--max-bytes expects a number of characters, e.g. --max-bytes 1000000');
    if (minBytes !== null && maxBytes !== null && minBytes > maxBytes) throw new Error(`--min-bytes ${minBytes} is above --max-bytes ${maxBytes}: no script can match`);
    if (breakLine !== null && (!Number.isInteger(breakLine) || breakLine < 0)) throw new Error('--break-line expects a 0-based line inside the caught script');
    if (!Number.isFinite(breakCol) || breakCol < 0) throw new Error('--break-col expects a 0-based column');
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('--timeout expects seconds, e.g. --timeout 30');
    if (!Number.isInteger(evalFrameIndex) || evalFrameIndex < 0) throw new Error('--frame expects a call frame index, e.g. --frame 1 for the caller');

    const client = await attach(port);
    // Subscribe before arming: a pause that arrives while the command works must not be lost.
    const pauses = pauseQueue(client);
    const options = { minBytes, maxBytes, onlyRuntime };
    /** @type {string | null} */
    let armed = null;
    try {
      await client.debug.enable();
      await client.sources.enable();
      ({ breakpointId: armed } = await client.debug.setInstrumentationBreakpoint('beforeScriptExecution'));
      // Page.navigate returns once the navigation is committed, before the page parses. Waiting for a load
      // event here would deadlock: the page is paused at the first script, so the load cannot finish.
      if (url) {
        const { errorText } = await client.cdp.send('Page.navigate', { url });
        if (errorText) throw new Error(`Navigation failed: ${errorText}`);
      }

      const deadline = Date.now() + timeoutSec * 1000;
      let scriptsSeen = 0;
      let expired = 0;
      /** @type {CatchReport | null} */
      let report = null;
      while (Date.now() < deadline && !report) {
        const event = await pauses.next((deadline - Date.now()) / 1000);
        if (!event) break;
        scriptsSeen += 1;
        report = await describeCandidate(client, event, options);
        if (!report) {
          if (!(await resumeIfPaused(client))) expired += 1;
        }
      }
      if (!report) {
        throw new Error(`No script matched within ${timeoutSec}s (${scriptsSeen} script(s) were about to run and were resumed). Narrow with --min-bytes.`);
      }

      /** @type {Record<string, unknown>} */
      const result = { ...report, scriptsSeen };

      if (breakLine !== null) {
        // Debugger locations count from the top of the DOCUMENT when the script starts on a later document line
        // (an inline <script> block), and from the script otherwise. Line 0 of such a script does not resolve.
        const info = client.sources.getScripts().find((s) => s.scriptId === report.script.scriptId);
        if (info && (breakLine < info.startLine || breakLine > info.endLine)) {
          const range = info.startLine === 0
            ? `0..${info.endLine} (relative to the script)`
            : `${info.startLine}..${info.endLine} (lines of the document: this script starts on line ${info.startLine})`;
          throw new Error(`Script ${report.script.scriptId} has no line ${breakLine}: use ${range}.`);
        }
        // Columns are document-relative too for an inline script, whose code starts after its <script> tag:
        // default to where the script's code begins, so a line alone is enough.
        const column = breakColArg === null ? (info?.startColumn ?? 0) : breakCol;
        let bp;
        try {
          bp = await client.debug.setBreakpointAtLocation(report.script.scriptId, breakLine, column);
        } catch (err) {
          // Chrome's own "Could not resolve breakpoint" says nothing about why; the script's start column does.
          throw new Error(`Chrome could not resolve ${report.script.scriptId}:${breakLine}:${column}: ${messageOf(err)}. This script is at line ${info?.startLine ?? 0}, column ${info?.startColumn ?? 0}; pick a line:column that contains code.`);
        }
        result.breakpoint = { line: breakLine, column, actual: bp.actualLocation };
        if (armed) { await client.debug.removeBreakpoint(armed).catch(() => {}); armed = null; }
        await resumeIfPaused(client);

        // Wait for OUR breakpoint: an instrumentation pause can still arrive for a script parsed earlier.
        let hit = null;
        while (Date.now() < deadline) {
          const event = await pauses.next((deadline - Date.now()) / 1000);
          if (!event) break;
          if ((event.hitBreakpoints ?? []).includes(bp.breakpointId)) { hit = event; break; }
          if (!(await resumeIfPaused(client))) expired += 1;
        }
        if (!hit) throw new Error(`The breakpoint at ${report.script.scriptId}:${breakLine} did not hit within the window.`);
        result.hit = { reason: hit.reason, hitBreakpoints: hit.hitBreakpoints ?? [], frames: describeFrames(client, hit) };
        const top = hit.callFrames?.[0];
        const callerFrame = hit.callFrames?.[1];
        if (top) {
          // Works here (unlike at an instrumentation pause): the JS thread answers at a breakpoint.
          result.locals = await client.debug.getScopeValues(top, { limit: 40 });
          // The caller is the code that built this script: its variables are the decoder's own state.
          if (callerFrame) result.callerLocals = await client.debug.getScopeValues(callerFrame, { limit: 40 });
          const wanted = hit.callFrames?.[evalFrameIndex];
          if (evalExpr && wanted) {
            const evaluated = await client.debug.evaluateOnCallFrame(wanted.callFrameId, evalExpr, { silent: true });
            const remote = evaluated.result;
            result.evaluated = {
              frame: evalFrameIndex,
              expression: evalExpr,
              value: typeof remote?.value === 'string'
                ? `${JSON.stringify(remote.value.slice(0, 300))} (${remote.value.length} chars)`
                : JSON.stringify(remote?.value ?? remote?.description ?? null),
            };
          } else if (evalExpr) {
            result.note = `--frame ${evalFrameIndex} does not exist at this pause (the stack has ${hit.callFrames?.length ?? 0} frame(s)).`;
          }
        }
      } else {
        result.note = 'Nothing was read from the stack: at a pause before a script runs, the JS thread does not answer evaluateOnCallFrame or getProperties. Add --break-line <line> to stop inside the caught script and read variables there.';
      }

      await emit({ ...result, pausesExpired: expired }, outFile);
    } finally {
      // The pause belongs to this command: a session that goes away leaves Chrome running, not paused.
      if (client.debug.paused) await resumeIfPaused(client).catch(() => {});
      if (armed) await client.debug.removeBreakpoint(armed).catch(() => {});
      pauses.stop();
      await release(client);
    }
  }

  return { cmdCatchScript };
}

module.exports = { createRevealCommands };
