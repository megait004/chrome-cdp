'use strict';

const EventEmitter = require('node:events');

/** Breakpoints, pause state, stepping and exception diagnostics for one target. */
class DebugController extends EventEmitter {
  /** @param {import('puppeteer-core').CDPSession} cdp */
  constructor(cdp) {
    super();
    if (!cdp) throw new TypeError('CDPSession is required');
    this._cdp = cdp;
    this._paused = null;
    this._enabled = false;
    this._breakpoints = new Set();
    this._onPaused = (/** @type {import('devtools-protocol').Protocol.Debugger.PausedEvent} */ event) => { this._paused = event; this.emit('paused', event); };
    this._onResumed = () => { this._paused = null; this.emit('resumed'); };
    this._pauseState = null; // armed pauseOnExceptions enum; re-asserted after navigation
    this._onContextsCleared = () => {
      // note: pause-on-exceptions does not reliably survive a navigation —
      // some stacks wipe it on reload (cf. Lynx caching the state and
      // re-sending setPauseOnExceptions after reloading), so re-assert the
      // armed state for the fresh contexts. Harmless when the backend kept
      // it: same state, sent idempotently.
      if (this._enabled && this._pauseState) {
        this._cdp.send('Debugger.setPauseOnExceptions', { state: this._pauseState }).catch(() => {});
      }
    };
  }
  /**
   * @param {{ pauseOnExceptions?: boolean | 'none' | 'caught' | 'uncaught' | 'all', asyncStackDepth?: number }} [options]
   */
  async enable(options = {}) {
    if (this._enabled) return;
    this._cdp.on('Debugger.paused', this._onPaused);
    this._cdp.on('Debugger.resumed', this._onResumed);
    this._cdp.on('Runtime.executionContextsCleared', this._onContextsCleared);
    try {
      await Promise.all([
        this._cdp.send('Debugger.enable'),
        this._cdp.send('Runtime.enable'),
      ]);
      // Spec enum for Debugger.setPauseOnExceptions: none | caught | uncaught | all.
      // `true` keeps backward compat (means 'all'); false/'none'/absent all mean "leave it".
      const pauseOpt = options.pauseOnExceptions;
      const state = pauseOpt === true ? 'all' : pauseOpt;
      if (state !== undefined && state !== false && state !== 'none') {
        if (!['caught', 'uncaught', 'all'].includes(state)) {
          throw new TypeError(`pauseOnExceptions must be true or one of 'caught' | 'uncaught' | 'all', got ${JSON.stringify(pauseOpt)}`);
        }
        await this._cdp.send('Debugger.setPauseOnExceptions', { state });
        this._pauseState = state;
      }
      if (options.asyncStackDepth !== undefined) {
        await this._cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: options.asyncStackDepth });
      }
      this._enabled = true;
    } catch (error) {
      await this.disable();
      throw error;
    }
  }
  /**
   * @param {string} url
   * @param {number} lineNumber 0-based line
   * @param {number} [columnNumber]
   * @param {string} [condition]
   */
  async setBreakpoint(url, lineNumber, columnNumber, condition) {
    if (columnNumber === undefined) columnNumber = 0; // omitted column = start of the line
    if (!url || !Number.isInteger(lineNumber) || lineNumber < 0) throw new TypeError('url and non-negative lineNumber are required');
    if (!Number.isFinite(columnNumber)) {
      throw new TypeError(
        `columnNumber must be a number, got ${typeof columnNumber} (${JSON.stringify(columnNumber)}). ` +
          'To pass a condition without a column, call setBreakpoint(url, line, 0, condition).'
      );
    }
    /** @type {import('devtools-protocol').Protocol.Debugger.SetBreakpointByUrlRequest} */
    const params = { url, lineNumber, columnNumber };
    if (condition) params.condition = condition;
    const result = await this._cdp.send('Debugger.setBreakpointByUrl', params);
    this._breakpoints.add(result.breakpointId);
    return result;
  }
  pause() { return this._cdp.send('Debugger.pause'); }
  resume() { return this._cdp.send('Debugger.resume'); }
  stepOver() { return this._cdp.send('Debugger.stepOver'); }
  stepInto() { return this._cdp.send('Debugger.stepInto'); }
  stepOut() { return this._cdp.send('Debugger.stepOut'); }
  /**
   * @param {string} callFrameId
   * @param {string} expression
   * @param {{ returnByValue?: boolean, silent?: boolean, includeCommandLineAPI?: boolean, objectGroup?: string }} [options]
   */
  evaluateOnCallFrame(callFrameId, expression, options = {}) {
    if (!callFrameId || typeof expression !== 'string') throw new TypeError('callFrameId and expression are required');
    // Spec passthrough for Debugger.evaluateOnCallFrame: silent (don't report
    // exceptions / don't re-pause — overrides pause-on-exceptions), and
    // includeCommandLineAPI (DevTools $0 / $_ helpers). returnByValue defaults true
    // so the CLI gets plain JSON instead of object handles. (No awaitPromise here:
    // the protocol has it only on Runtime.evaluate / callFunctionOn / runScript.)
    return this._cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId, expression, returnByValue: options.returnByValue !== false,
      ...(options.silent !== undefined ? { silent: Boolean(options.silent) } : {}),
      ...(options.includeCommandLineAPI !== undefined ? { includeCommandLineAPI: Boolean(options.includeCommandLineAPI) } : {}),
      ...(options.objectGroup !== undefined ? { objectGroup: options.objectGroup } : {}),
    });
  }
  /** @param {string} breakpointId */
  async removeBreakpoint(breakpointId) {
    await this._cdp.send('Debugger.removeBreakpoint', { breakpointId });
    // note: untrack AFTER the send succeeds — a throw means Chrome still holds
    // the breakpoint, so disable() must retry the removal instead of forgetting it.
    this._breakpoints.delete(breakpointId);
  }
  get paused() { return this._paused; }
  /**
   * Detaches listeners and resets the target. Resolves once Chrome has answered
   * the cleanup commands. Best effort: failures are swallowed, never thrown.
   * @returns {Promise<void>}
   */
  disable() {
    this._cdp.off('Debugger.paused', this._onPaused);
    this._cdp.off('Debugger.resumed', this._onResumed);
    this._cdp.off('Runtime.executionContextsCleared', this._onContextsCleared);
    // note: leave the target as we found it — pause-on-exceptions back to 'none'
    // and every armed breakpoint removed, so nothing we set survives disconnect
    // into the live tab.
    const cleanups = [this._cdp.send('Debugger.setPauseOnExceptions', { state: 'none' })];
    for (const breakpointId of this._breakpoints) {
      cleanups.push(this._cdp.send('Debugger.removeBreakpoint', { breakpointId }));
    }
    this._breakpoints.clear();
    this._paused = null;
    this._enabled = false;
    this._pauseState = null;
    return Promise.all(cleanups.map((p) => p.catch(() => {}))).then(() => {});
  }
}

module.exports = DebugController;
