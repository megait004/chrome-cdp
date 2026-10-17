'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');

/**
 * One console message or uncaught exception as this controller records it.
 * @typedef {{ type: string, text: string, args?: unknown[], stackTrace: Array<{ functionName: string, scriptId: string, url: string, lineNumber: number, columnNumber: number }>, executionContextId?: number, timestamp: number, scriptId?: string, url?: string, lineNumber?: number, columnNumber?: number }} ConsoleEntry
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
    /** @type {ConsoleEntry[]} */
    this._logs = [];
    this._isRecording = false;

    this._onConsoleAPICalled = this._onConsoleAPICalled.bind(this);
    this._onExceptionThrown = this._onExceptionThrown.bind(this);
  }

  /**
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this._isRecording) return;

    this._cdp.on('Runtime.consoleAPICalled', this._onConsoleAPICalled);
    this._cdp.on('Runtime.exceptionThrown', this._onExceptionThrown);

    try {
      await this._cdp.send('Runtime.enable');
    } catch (error) {
      // Enable failed, so _isRecording stays false and a later startRecording() would arm these
      // handlers a second time — every message would then be recorded twice. Undo, then rethrow so
      // the caller gets to report it.
      this._cdp.off('Runtime.consoleAPICalled', this._onConsoleAPICalled);
      this._cdp.off('Runtime.exceptionThrown', this._onExceptionThrown);
      throw error;
    }
    this._isRecording = true;
  }

  stopRecording() {
    if (!this._isRecording) return;

    this._cdp.off('Runtime.consoleAPICalled', this._onConsoleAPICalled);
    this._cdp.off('Runtime.exceptionThrown', this._onExceptionThrown);

    this._isRecording = false;
  }

  clear() {
    /** @type {ConsoleEntry[]} */
    this._logs = [];
  }

  /**
   * @param {{
   *   type?: string,
   *   query?: string | RegExp,
   *   hasStackTrace?: boolean
   * }} [filter]
   * @returns {ConsoleEntry[]}
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
   * @template {unknown[]} P
   * @template R
   * @param {string | ((...args: import('puppeteer-core').InnerParams<P>) => R)} expressionOrFn
   * @param {P} args
   * @returns {Promise<Awaited<R>>} For a string expression the value is whatever JSON the page produced; the caller states its type through R.
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

    return /** @type {Awaited<R>} */ (response.result?.value);
  }

  /**
   * Inspects an object with Runtime.getProperties, so cyclic references and getters do not break serialization.
   * @param {string} objectIdOrExpression
   * @param {{ ownProperties?: boolean }} [options]
   * @returns {Promise<Array<{ name: string, value: unknown, type: string, isGetter: boolean, isSetter: boolean, writable?: boolean, enumerable?: boolean, configurable?: boolean }>>}
   */
  async inspectObject(objectIdOrExpression, { ownProperties = true } = {}) {
    let targetObjectId = objectIdOrExpression;
    let releaseTarget = false;

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
   * @param {string} prototypeExpression - e.g. "UserSession.prototype" or "MyService.prototype"
   * @param {{ limit?: number }} [options] at most this many instances are returned (default 100). Common prototypes such as HTMLElement.prototype can match thousands of live objects, and dumping them all by value fails with "Internal error"
   * @returns {Promise<unknown[]>}
   */
  async queryObjects(prototypeExpression, { limit = 100 } = {}) {
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
      // note: DOM nodes serialize to {} through JSON, and cyclic objects throw; both fall back to String()
      // so one bad instance cannot fail the whole query. Use dom.inspectElement for DOM nodes.
      functionDeclaration: 'function(limit) { return Array.from(this).slice(0, limit).map((o) => { try { return JSON.parse(JSON.stringify(o)); } catch { return String(o); } }); }',
      arguments: [{ value: limit }],
      returnByValue: true,
    });

    await this._cdp.send('Runtime.releaseObject', { objectId: queryRes.objects.objectId }).catch(() => {});
    return /** @type {unknown[]} */ (dumpRes.result?.value || []);
  }

  /**
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
