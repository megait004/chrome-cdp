'use strict';

const EventEmitter = require('node:events');

/** Discovers and controls dedicated/shared/service workers through target sessions. */
class WorkerController extends EventEmitter {
  constructor(browser) {
    super();
    if (!browser) throw new TypeError('Browser instance is required');
    this._browser = browser;
    this._workers = new Map();
    this._targetIds = new WeakMap();
    this._browserSession = null;
    this._onTargetCreated = this._onTargetCreated.bind(this);
    this._onTargetDestroyed = this._onTargetDestroyed.bind(this);
    browser.on('targetcreated', this._onTargetCreated);
    browser.on('targetdestroyed', this._onTargetDestroyed);
    this.ready = this._initialize();
  }

  async _initialize() {
    this._browserSession = await this._browser.target().createCDPSession();
    await this._browserSession.send('Target.setDiscoverTargets', {
      discover: true,
      filter: [{ type: 'worker' }, { type: 'service_worker' }, { type: 'shared_worker' }],
    });
    await Promise.all(this._browser.targets().map((target) => this._track(target)));
  }

  _getWorkerType(target) {
    // note: raw CDP type first ON PURPOSE — puppeteer reports dedicated workers
    // as 'other' (public target.type() loses the info), while the CDP targetInfo
    // carries the real 'worker' type. Pinned by unit.test.js 'dedicated worker'.
    const raw = typeof target._getTargetInfo === 'function' ? target._getTargetInfo()?.type : null;
    const type = raw || (typeof target.type === 'function' ? target.type() : null);
    return ['worker', 'service_worker', 'shared_worker'].includes(type) ? type : null;
  }

  async _track(target) {
    const type = this._getWorkerType(target);
    if (!type) return;
    if (this._pendingTargets?.has(target)) return this._pendingTargets.get(target);
    this._pendingTargets ||= new WeakMap();
    const tracking = this._trackTarget(target, type);
    this._pendingTargets.set(target, tracking);
    return tracking;
  }

  async _trackTarget(target, type) {
    let id = this._targetIds.get(target);
    const session = await target.createCDPSession();
    if (!id) {
      const result = await session.send('Target.getTargetInfo');
      id = result.targetInfo.targetId;
      this._targetIds.set(target, id);
    }
    if (this._workers.has(id)) {
      await session.detach();
      return;
    }
    try {
      await session.send('Runtime.enable');
    } catch (error) {
      await session.detach().catch(() => {});
      throw error;
    }
    const item = { id, type: type || this._getWorkerType(target), url: target.url(), target, session };
    this._workers.set(item.id, item);
    this.emit('created', this.info(item));
  }

  _onTargetCreated(target) {
    this._track(target).catch((error) => this.emit('workerError', error));
  }
  _onTargetDestroyed(target) {
    const item = this._workers.get(this._targetIds.get(target));
    if (!item) return;
    this._workers.delete(item.id);
    this.emit('destroyed', this.info(item));
  }
  info(item) { return { id: item.id, type: item.type, url: item.url }; }
  list() { return [...this._workers.values()].map((item) => this.info(item)); }
  _get(id) { const item = this._workers.get(id); if (!item) { throw new Error(`Worker target not found: ${id}`); } return item; }

  async evaluate(id, expression, options = {}) {
    if (typeof expression !== 'string') throw new TypeError('Worker expression must be a string');
    const result = await this._get(id).session.send('Runtime.evaluate', {
      expression, awaitPromise: options.awaitPromise !== false, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Worker evaluation failed');
    return result.result?.value;
  }

  close() {
    this._browser.off('targetcreated', this._onTargetCreated);
    this._browser.off('targetdestroyed', this._onTargetDestroyed);
    this._browserSession?.detach().catch(() => {});
    for (const item of this._workers.values()) item.session.detach().catch(() => {});
    this._workers.clear();
  }
}

module.exports = WorkerController;
