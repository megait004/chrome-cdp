'use strict';

const EventEmitter = require('node:events');

/** Breakpoints, pause state, stepping and exception diagnostics for one target. */
class DebugController extends EventEmitter {
  constructor(cdp) {
    super();
    if (!cdp) throw new TypeError('CDPSession is required');
    this._cdp = cdp;
    this._paused = null;
    this._enabled = false;
    this._breakpoints = new Set();
    this._onPaused = (event) => { this._paused = event; this.emit('paused', event); };
    this._onResumed = () => { this._paused = null; this.emit('resumed'); };
  }
  async enable(options = {}) {
    if (this._enabled) return;
    this._cdp.on('Debugger.paused', this._onPaused);
    this._cdp.on('Debugger.resumed', this._onResumed);
    try {
      await Promise.all([
        this._cdp.send('Debugger.enable'),
        this._cdp.send('Runtime.enable'),
      ]);
      if (options.pauseOnExceptions) {
        await this._cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
      }
      if (options.asyncStackDepth !== undefined) {
        await this._cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: options.asyncStackDepth });
      }
      this._enabled = true;
    } catch (error) {
      this.disable();
      throw error;
    }
  }
  async setBreakpoint(url, lineNumber, columnNumber = 0, condition) {
    if (!url || !Number.isInteger(lineNumber) || lineNumber < 0) throw new TypeError('url and non-negative lineNumber are required');
    if (!Number.isFinite(columnNumber)) {
      throw new TypeError(
        `columnNumber must be a number, got ${typeof columnNumber} (${JSON.stringify(columnNumber)}). ` +
          'To pass a condition without a column, call setBreakpoint(url, line, 0, condition).'
      );
    }
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
  evaluateOnCallFrame(callFrameId, expression, options = {}) {
    if (!callFrameId || typeof expression !== 'string') throw new TypeError('callFrameId and expression are required');
    return this._cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId, expression, returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise !== false,
    });
  }
  removeBreakpoint(breakpointId) { return this._cdp.send('Debugger.removeBreakpoint', { breakpointId }); }
  get paused() { return this._paused; }
  disable() {
    this._cdp.off('Debugger.paused', this._onPaused);
    this._cdp.off('Debugger.resumed', this._onResumed);
    for (const breakpointId of this._breakpoints) {
      this._cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    }
    this._breakpoints.clear();
    this._paused = null;
    this._enabled = false;
  }
}

module.exports = DebugController;
