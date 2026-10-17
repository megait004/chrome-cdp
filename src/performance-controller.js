'use strict';

const { performance } = require('node:perf_hooks');
const { TRACE_STOP_TIMEOUT_MS } = require('./timeouts');

class PerformanceController {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession} cdp
   */
  constructor(page, cdp) {
    if (!page) throw new TypeError('Page instance is required for PerformanceController');
    if (!cdp) throw new TypeError('CDPSession is required for PerformanceController');
    this._page = page;
    this._cdp = cdp;
    this._tracing = false;
    this._profiling = false;
    this._metricsEnabled = false;
  }
  /** @param {{ interval?: number }} [options] sampling interval in microseconds (default 1000) */
  async startProfile(options = {}) {
    if (this._profiling) throw new Error('A CPU profile is already running');
    await this._cdp.send('Profiler.enable');
    await this._cdp.send('Profiler.setSamplingInterval', { interval: options.interval ?? 1000 });
    await this._cdp.send('Profiler.start');
    this._profiling = true;
  }
  /** @returns {Promise<import('devtools-protocol').Protocol.Profiler.Profile>} */
  async stopProfile() {
    if (!this._profiling) throw new Error('No CPU profile is running');
    try {
      const { profile } = await this._cdp.send('Profiler.stop');
      return profile;
    } finally {
      this._profiling = false;
    }
  }
  async metrics() {
    if (!this._metricsEnabled) {
      await this._cdp.send('Performance.enable');
      this._metricsEnabled = true;
    }
    const result = await this._cdp.send('Performance.getMetrics');
    return Object.fromEntries((result.metrics || []).map((/** @type {{ name: string, value: number }} */ metric) => [metric.name, metric.value]));
  }
  /** @param {{ categories?: string }} [options] */
  async startTrace(options = {}) {
    if (this._tracing) throw new Error('A performance trace is already running');
    // Enables the Performance domain up front so counters are already ticking when the
    // trace starts; a first read taken after Tracing.start would miss the early samples.
    await this.metrics();
    const includedCategories = (options.categories || 'devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler')
      .split(',').map((c) => c.trim()).filter(Boolean);
    // Tracing.start.categories is deprecated in the protocol; traceConfig carries the same list.
    await this._cdp.send('Tracing.start', {
      traceConfig: { includedCategories },
      transferMode: 'ReturnAsStream',
    });
    this._tracing = true;
  }
  /** @param {{ timeout?: number }} [options] */
  async stopTrace(options = {}) {
    if (!this._tracing) throw new Error('No performance trace is running');
    const timeout = options.timeout ?? TRACE_STOP_TIMEOUT_MS;
    let stream;
    try {
      stream = await /** @type {Promise<string>} */ (new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const done = () => {
          clearTimeout(timer);
          this._cdp.off('Tracing.tracingComplete', onComplete);
        };
        /** @param {import('devtools-protocol').Protocol.Tracing.TracingCompleteEvent} event */
        const onComplete = (event) => {
          done();
          if (event.stream) resolve(event.stream);
          else reject(new Error('Tracing.tracingComplete arrived without a stream handle'));
        };
        /** @param {unknown} error */
        const fail = (error) => {
          done();
          reject(error);
        };
        this._cdp.on('Tracing.tracingComplete', onComplete);
        timer = setTimeout(
          () => fail(new Error(`Tracing.tracingComplete never arrived within ${timeout}ms`)),
          timeout
        );
        this._cdp.send('Tracing.end').catch(fail);
      }));
    } catch (error) {
      this._tracing = false;
      throw error;
    }
    let trace = '';
    try {
      while (true) {
        const chunk = await this._cdp.send('IO.read', { handle: stream });
        trace += chunk.data || '';
        if (chunk.eof) break;
      }
    } finally {
      await this._cdp.send('IO.close', { handle: stream }).catch(() => {});
      this._tracing = false;
    }
    return trace;
  }
  /**
   * @template {unknown[]} P
   * @template R
   * @param {(...args: import('puppeteer-core').InnerParams<P>) => R} fn
   * @param {P} args
   */
  async measure(fn, ...args) {
    const before = await this.metrics();
    const started = performance.now();
    const value = await this._page.evaluate(fn, ...args);
    return { value, durationMs: performance.now() - started, before, after: await this.metrics() };
  }
}

module.exports = PerformanceController;
