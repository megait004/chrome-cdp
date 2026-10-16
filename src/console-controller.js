'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');

/**
 * One console message or uncaught exception as this controller records it.
 * @typedef {{ type: string, text: string, args?: unknown[], stackTrace: Array<{ functionName: string, scriptId: string, url: string, lineNumber: number, columnNumber: number }>, executionContextId?: number, timestamp: number }} ConsoleEntry
 */

/**
 * Advanced Console and Runtime Controller for CDP.
 * Captures full V8 call stack traces, unhandled exceptions, RemoteObject inspection,
 * and heap object querying for reverse engineering.
 */
class ConsoleController extends EventEmitter {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession} cdpSession
   */
  constructor(page, cdpSession) {
    super();
    if (!page) throw new TypeError('Page instance is required for ConsoleController');
    if (!cdpSession) throw new TypeError('CDPSession is required for ConsoleController');

    this._page = page;
    this._cdp = cdpSession;
    /** @type {Array<object>} */
    /** @type {ConsoleEntry[]} */
    this._logs = [];
    this._isRecording = false;

    this._onConsoleAPICalled = this._onConsoleAPICalled.bind(this);
    this._onExceptionThrown = this._onExceptionThrown.bind(this);
  }

  /**
   * Starts listening to console events, call stacks, and runtime exceptions.
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this._isRecording) return;

    this._cdp.on('Runtime.consoleAPICalled', this._onConsoleAPICalled);
    this._cdp.on('Runtime.exceptionThrown', this._onExceptionThrown);

    await this._cdp.send('Runtime.enable');
    this._isRecording = true;
  }

  /**
   * Stops listening to console events.
   */
  stopRecording() {
    if (!this._isRecording) return;

    this._cdp.off('Runtime.consoleAPICalled', this._onConsoleAPICalled);
    this._cdp.off('Runtime.exceptionThrown', this._onExceptionThrown);

    this._isRecording = false;
  }

  /**
   * Clears recorded console logs.
   */
  clear() {
    /** @type {ConsoleEntry[]} */
    this._logs = [];
  }

  /**
   * Returns recorded console messages with optional filters.
   * @param {{
   *   type?: string,
   *   query?: string | RegExp,
   *   hasStackTrace?: boolean
   * }} [filter]
   * @returns {Array<object>}
   */
  getLogs(filter = {}) {
    return this._logs.filter((item) => {
      if (filter.type && item.type !== filter.type) {
        return false;
      }
      if (filter.hasStackTrace && (!item.stackTrace || item.stackTrace.length === 0)) {
        return false;
      }
      if (filter.query) {
        const matches = matchesQuery(item.text, filter.query);
        if (!matches) return false;
      }
      return true;
    });
  }

  /**
   * Evaluates an expression or function in the page context via CDP Runtime.evaluate.
   * Returns unwrapped result value.
   * @param {string | ((...args: any[]) => any)} expressionOrFn
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async evaluate(expressionOrFn, ...args) {
    if (typeof expressionOrFn === 'function') {
      return this._page.evaluate(expressionOrFn, ...args);
    }

    if (typeof expressionOrFn !== 'string') {
      throw new TypeError('Expression must be a string or a function');
    }

    const response = await this._cdp.send('Runtime.evaluate', {
      expression: expressionOrFn,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (response.exceptionDetails) {
      const desc =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'Runtime evaluation error';
      throw new Error(`Runtime.evaluate failed: ${desc}`);
    }

    return response.result?.value;
  }

  /**
   * Inspects complex JavaScript objects, prototypes, symbols, and getters via CDP Runtime.getProperties.
   * Eliminates cyclic reference and serialization errors.
   * @param {string} objectIdOrExpression
   * @param {{ ownProperties?: boolean }} [options]
   * @returns {Promise<Array<{ name: string, value: any, type: string, isGetter: boolean, isSetter: boolean }>>}
   */
  async inspectObject(objectIdOrExpression, { ownProperties = true } = {}) {
    let targetObjectId = objectIdOrExpression;
    let releaseTarget = false;

    // If it is an expression, evaluate it first without value serialization
    if (!/^-?\d+(\.\d+){2,}$/.test(objectIdOrExpression)) {
      const evalRes = await this._cdp.send('Runtime.evaluate', {
        expression: objectIdOrExpression,
        returnByValue: false,
      });

      if (evalRes.exceptionDetails) {
        throw new Error(
          `Failed to evaluate object expression: ${evalRes.exceptionDetails.text || evalRes.exceptionDetails.exception?.description}`
        );
      }

      if (!evalRes.result?.objectId) {
        return [
          {
            name: '(primitive)',
            value: evalRes.result?.value,
            type: evalRes.result?.type || 'undefined',
            isGetter: false,
            isSetter: false,
          },
        ];
      }

      targetObjectId = evalRes.result.objectId;
      releaseTarget = true;
    }

    const res = await this._cdp.send('Runtime.getProperties', {
      objectId: targetObjectId,
      ownProperties: Boolean(ownProperties),
      generatePreview: true,
    });

    const properties = (res.result || []).map((prop) => {
      const val = prop.value;
      const isGetter = Boolean(prop.get);
      const isSetter = Boolean(prop.set);

      let unwrappedValue;
      if (val) {
        unwrappedValue = val.value !== undefined ? val.value : val.description;
      } else if (isGetter) {
        unwrappedValue = '[Getter]';
      } else {
        unwrappedValue = undefined;
      }

      return {
        name: prop.name,
        value: unwrappedValue,
        type: val?.type || (isGetter ? 'getter' : 'unknown'),
        isGetter,
        isSetter,
        writable: prop.writable,
        enumerable: prop.enumerable,
        configurable: prop.configurable,
      };
    });
    if (releaseTarget) await this._cdp.send('Runtime.releaseObject', { objectId: targetObjectId }).catch(() => {});
    return properties;
  }

  /**
   * Queries all active instances of a class or prototype across the entire V8 heap.
   * Exceptional tool for finding secret state, in-memory tokens, and active sessions.
   * @param {string} prototypeExpression - e.g. "UserSession.prototype" or "MyService.prototype"
   * @returns {Promise<Array<any>>}
   */
  async queryObjects(prototypeExpression) {
    const protoRes = await this._cdp.send('Runtime.evaluate', {
      expression: prototypeExpression,
      returnByValue: false,
    });

    if (!protoRes.result?.objectId) {
      throw new Error(`Prototype object not found for: ${prototypeExpression}`);
    }

    const queryRes = await this._cdp.send('Runtime.queryObjects', {
      prototypeObjectId: protoRes.result.objectId,
    });
    await this._cdp.send('Runtime.releaseObject', { objectId: protoRes.result.objectId }).catch(() => {});

    if (!queryRes.objects?.objectId) {
      return [];
    }

    const dumpRes = await this._cdp.send('Runtime.callFunctionOn', {
      objectId: queryRes.objects.objectId,
      functionDeclaration: 'function() { return Array.from(this); }',
      returnByValue: true,
    });

    await this._cdp.send('Runtime.releaseObject', { objectId: queryRes.objects.objectId }).catch(() => {});
    return dumpRes.result?.value || [];
  }

  /**
   * Internal handler for Runtime.consoleAPICalled.
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Runtime.ConsoleAPICalledEvent} event */
  _onConsoleAPICalled(event) {
    const text = event.args
      .map((/** @type {import('devtools-protocol').Protocol.Runtime.RemoteObject} */ a) => (a.value !== undefined ? String(a.value) : a.description || ''))
      .join(' ');

    const stackTrace =
      event.stackTrace?.callFrames?.map((/** @type {import('devtools-protocol').Protocol.Runtime.CallFrame} */ f) => ({
        functionName: f.functionName || '(anonymous)',
        scriptId: f.scriptId,
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      })) || [];

    const entry = {
      type: event.type, // 'log' | 'warning' | 'error' | 'info' | 'debug' | 'trace' | 'table'
      text,
      args: event.args,
      stackTrace,
      executionContextId: event.executionContextId,
      timestamp: event.timestamp || Date.now(),
    };

    this._logs.push(entry);
    this.emit('message', entry);
  }

  /**
   * Internal handler for Runtime.exceptionThrown.
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Runtime.ExceptionThrownEvent} event */
  _onExceptionThrown(event) {
    const details = event.exceptionDetails;
    const text =
      details.exception?.description || details.text || 'Unhandled runtime exception';

    const stackTrace =
      details.stackTrace?.callFrames?.map((/** @type {import('devtools-protocol').Protocol.Runtime.CallFrame} */ f) => ({
        functionName: f.functionName || '(anonymous)',
        scriptId: f.scriptId,
        url: f.url,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      })) || [];

    const entry = {
      type: 'error',
      text,
      stackTrace,
      scriptId: details.scriptId,
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      timestamp: event.timestamp || Date.now(),
    };

    this._logs.push(entry);
    this.emit('exception', entry);
    this.emit('message', entry);
  }
}

module.exports = ConsoleController;
