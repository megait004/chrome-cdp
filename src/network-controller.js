'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');
const { messageOf } = require('./util');

/**
 * One recorded request. Leaf types come from the CDP protocol, so a protocol change fails the
 * type check. Fields filled by a later event are null until it arrives.
 * @typedef {object} TrafficEntry
 * @property {string} id
 * @property {string} cdpRequestId
 * @property {number} redirectIndex
 * @property {string | null} redirectedFrom
 * @property {string | null} redirectedTo
 * @property {import('devtools-protocol').Protocol.Network.Request['url']} url
 * @property {import('devtools-protocol').Protocol.Network.Request['method']} method
 * @property {import('devtools-protocol').Protocol.Network.ResourceType} resourceType
 * @property {import('devtools-protocol').Protocol.Network.Request['headers']} headers
 * @property {import('devtools-protocol').Protocol.Network.RequestWillBeSentExtraInfoEvent['headers'] | null} rawHeaders
 * @property {string | null} postData rebuilt from postDataEntries (postData itself is deprecated)
 * @property {number | null} startTime
 * @property {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent['wallTime']} [wallTime]
 * @property {import('devtools-protocol').Protocol.Network.Initiator} [initiator]
 * @property {import('devtools-protocol').Protocol.Network.Response['status'] | null} status
 * @property {import('devtools-protocol').Protocol.Network.Response['statusText'] | null} statusText
 * @property {import('devtools-protocol').Protocol.Network.Response['headers'] | null} responseHeaders
 * @property {import('devtools-protocol').Protocol.Network.ResponseReceivedExtraInfoEvent['headers'] | null} rawResponseHeaders
 * @property {import('devtools-protocol').Protocol.Network.ResponseReceivedExtraInfoEvent['headersText'] | null} rawResponseHeadersText
 * @property {import('devtools-protocol').Protocol.Network.ResponseReceivedExtraInfoEvent['statusCode']} [rawStatusCode]
 * @property {import('devtools-protocol').Protocol.Network.Response['mimeType'] | null} mimeType
 * @property {import('devtools-protocol').Protocol.Network.Response['remoteIPAddress'] | null} remoteIPAddress
 * @property {import('devtools-protocol').Protocol.Network.Response['remotePort'] | null} remotePort
 * @property {import('devtools-protocol').Protocol.Network.Response['protocol'] | null} protocol
 * @property {import('devtools-protocol').Protocol.Network.LoadingFinishedEvent['encodedDataLength'] | null} encodedDataLength
 * @property {number | null} durationMs
 * @property {boolean} failed
 * @property {import('devtools-protocol').Protocol.Network.LoadingFailedEvent['errorText'] | null} errorText
 * @property {import('devtools-protocol').Protocol.Network.LoadingFailedEvent['canceled']} [canceled]
 * @property {import('devtools-protocol').Protocol.Network.Response['securityState']} [securityState]
 * @property {import('devtools-protocol').Protocol.Network.RequestWillBeSentExtraInfoEvent['clientSecurityState'] | null} [clientSecurityState]
 * @property {import('devtools-protocol').Protocol.Network.RequestWillBeSentExtraInfoEvent['associatedCookies']} [associatedCookies]
 * @property {string} [responseBody]
 * @property {boolean} [responseBase64]
 */

/**
 * Rebuilds the POST body from postDataEntries (base64 chunks). Null when there is no body.
 * Very large bodies may omit entries; getRequestPostData fetches them.
 * @param {Array<{ bytes?: string }> | undefined} entries
 * @returns {string | null}
 */
function decodePostData(entries) {
  if (!entries || entries.length === 0) return null;
  return entries.map((entry) => (entry.bytes ? Buffer.from(entry.bytes, 'base64').toString('utf8') : '')).join('');
}

class NetworkController extends EventEmitter {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').CDPSession} cdpSession
   */
  constructor(page, cdpSession) {
    super();
    if (!page) throw new TypeError('Page instance is required for NetworkController');
    if (!cdpSession) throw new TypeError('CDPSession is required for NetworkController');

    this._page = page;
    this._cdp = cdpSession;
    /** @type {Map<string, TrafficEntry>} */
    this._entries = new Map();
    this._isRecording = false;

    this._onRequestWillBeSent = this._onRequestWillBeSent.bind(this);
    this._onRequestExtraInfo = this._onRequestExtraInfo.bind(this);
    this._onResponseReceived = this._onResponseReceived.bind(this);
    this._onResponseExtraInfo = this._onResponseExtraInfo.bind(this);
    /** @type {Map<string, TrafficEntry[]>} requestId -> finished redirect hops still waiting for their raw headers */
    this._hopsAwaitingRaw = new Map();
    this._onLoadingFinished = this._onLoadingFinished.bind(this);
    this._onLoadingFailed = this._onLoadingFailed.bind(this);
  }

  /**
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this._isRecording) return;

    this._cdp.on('Network.requestWillBeSent', this._onRequestWillBeSent);
    this._cdp.on('Network.requestWillBeSentExtraInfo', this._onRequestExtraInfo);
    this._cdp.on('Network.responseReceived', this._onResponseReceived);
    this._cdp.on('Network.responseReceivedExtraInfo', this._onResponseExtraInfo);
    this._cdp.on('Network.loadingFinished', this._onLoadingFinished);
    this._cdp.on('Network.loadingFailed', this._onLoadingFailed);

    await this._cdp.send('Network.enable');
    // note: store response bodies outside the renderer so they survive
    // cross-process navigations (protocol v0.0.1716261, experimental — older
    // Chrome builds reject the command, hence the silent catch). Without it,
    // bodies die on navigation; this is what makes getResponseBody reliable.
    // Trade-off: Network.searchInResponseBody may not see durable-stored bodies,
    // so searchBodies() falls back to a local match.
    await this._cdp.send('Network.configureDurableMessages', {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 5_000_000,
    }).catch(() => {});
    this._isRecording = true;
  }

  stopRecording() {
    if (!this._isRecording) return;

    this._cdp.off('Network.requestWillBeSent', this._onRequestWillBeSent);
    this._cdp.off('Network.requestWillBeSentExtraInfo', this._onRequestExtraInfo);
    this._cdp.off('Network.responseReceived', this._onResponseReceived);
    this._cdp.off('Network.responseReceivedExtraInfo', this._onResponseExtraInfo);
    this._cdp.off('Network.loadingFinished', this._onLoadingFinished);
    this._cdp.off('Network.loadingFailed', this._onLoadingFailed);

    this._isRecording = false;
  }

  clear() {
    this._entries.clear();
  }

  /**
   * @param {{
   *   url?: string | RegExp,
   *   method?: string,
   *   resourceType?: string,
   *   status?: number,
   *   failedOnly?: boolean
   * }} [filter]
   * @returns {Array<TrafficEntry>}
   */
  getTraffic(filter = {}) {
    const list = Array.from(this._entries.values());
    return list.filter((item) => {
      if (filter.url) {
        const matches = matchesQuery(item.url, filter.url);
        if (!matches) return false;
      }
      if (filter.method && item.method?.toUpperCase() !== filter.method.toUpperCase()) {
        return false;
      }
      if (filter.resourceType && item.resourceType !== filter.resourceType) {
        return false;
      }
      if (filter.status !== undefined && item.status !== filter.status) {
        return false;
      }
      if (filter.failedOnly && !item.failed) {
        return false;
      }
      return true;
    });
  }

  /**
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {string}
   * @private
   */
  _resolveRequestId(query) {
    if (typeof query === 'string') {
      if (this._entries.has(query)) {
        return query;
      }
      const entry = this.getTraffic({ url: query })[0];
      if (entry) return entry.id;
    } else if (query?.requestId) {
      return query.requestId;
    } else if (query?.url) {
      const entry = this.getTraffic({ url: query.url })[0];
      if (entry) return entry.id;
    }
    throw new Error(`No recorded network entry found for query: ${JSON.stringify(query)}`);
  }

  /**
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string | null>}
   */
  async getRequestPostData(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);

    try {
      const res = await this._cdp.send('Network.getRequestPostData', {
        requestId: entry?.cdpRequestId || requestId,
      });
      if (res?.postData) {
        if (entry) entry.postData = res.postData;
        return res.postData;
      }
    } catch {
      if (entry?.postData) {
        return entry.postData;
      }
    }
    return entry?.postData || null;
  }

  /**
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<{ body: string, base64Encoded: boolean, parsedJson?: object | null }>}
   */
  async getResponseBody(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);

    if (entry && entry.id !== entry.cdpRequestId) {
      throw new Error(
        `No response body for redirect hop ${entry.id} (${entry.status} to ${entry.redirectedTo}). ` +
          `Chrome keeps no body for a redirect; asking for one would return the body of the final ` +
          `hop, request id ${entry.cdpRequestId}, which is a different response.`
      );
    }

    try {
      const result = await this._cdp.send('Network.getResponseBody', {
        requestId: entry?.cdpRequestId || requestId,
      });

      let parsedJson = null;
      if (!result.base64Encoded && typeof result.body === 'string') {
        const trimmed = result.body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsedJson = JSON.parse(trimmed);
          } catch {}
        }
      }

      if (entry) {
        entry.responseBody = result.body;
        entry.responseBase64 = result.base64Encoded || false;
      }

      return {
        body: result.body,
        base64Encoded: result.base64Encoded || false,
        parsedJson,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to retrieve response body for request ${requestId}: ${message}`);
    }
  }

  /**
   * Generates a raw HTTP request string suitable for Burp Suite Repeater or analysis.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string>}
   */
  async toRawRequest(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);
    if (!entry) throw new Error(`Entry not found: ${requestId}`);

    const parsedUrl = new URL(entry.url);
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
    const method = entry.method || 'GET';
    const httpVersion = entry.protocol?.toUpperCase().includes('HTTP/2') ? 'HTTP/2' : 'HTTP/1.1';

    const lines = [`${method} ${pathAndQuery} ${httpVersion}`];

    const headers = entry.rawHeaders || entry.headers || {};
    if (!headers['host'] && !headers['Host']) {
      lines.push(`Host: ${parsedUrl.host}`);
    }

    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith(':')) continue; // Skip HTTP/2 pseudo-headers in raw text
      lines.push(`${k}: ${v}`);
    }

    const postData = await this.getRequestPostData(requestId);
    if (postData) {
      lines.push('', postData);
    }

    return lines.join('\r\n');
  }

  /**
   * Generates a raw HTTP response string suitable for security auditing.
   * @param {string | { url?: string | RegExp, requestId?: string }} query
   * @returns {Promise<string>}
   */
  async toRawResponse(query) {
    const requestId = this._resolveRequestId(query);
    const entry = this._entries.get(requestId);
    if (!entry) throw new Error(`Entry not found: ${requestId}`);

    const lines = [];
    if (entry.rawResponseHeadersText) {
      lines.push(entry.rawResponseHeadersText.trim());
    } else {
      const httpVersion = entry.protocol?.toUpperCase().includes('HTTP/2') ? 'HTTP/2' : 'HTTP/1.1';
      lines.push(`${httpVersion} ${entry.status || 200} ${entry.statusText || 'OK'}`);
      const headers = entry.rawResponseHeaders || entry.responseHeaders || {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith(':')) continue;
        lines.push(`${k}: ${v}`);
      }
    }

    try {
      const { body, base64Encoded } = await this.getResponseBody(requestId);
      lines.push('', base64Encoded ? `[Base64 Encoded Binary: ${body.slice(0, 80)}...]` : body);
    } catch (err) {
      lines.push('', `[body unavailable: ${messageOf(err)}]`);
    }

    return lines.join('\r\n');
  }

  /**
   * Searches across all captured HTTP requests and responses for strings or regex.
   * Searches in URL, Request Headers, Request Body, and Response Headers.
   * @param {string | RegExp} query
   * @returns {Array<{ requestId: string, url: string, method: string, status: number | null, matchedFields: string[], entry: TrafficEntry }>}
   */
  searchTraffic(query) {
    const test = (/** @type {string | null | undefined} */ str) => matchesQuery(str, query); // non-strings never match

    const matches = [];
    for (const entry of this._entries.values()) {
      const matchDetails = [];

      if (test(entry.url)) matchDetails.push('url');
      if (test(entry.postData)) matchDetails.push('postData');
      if (test(JSON.stringify(entry.headers))) matchDetails.push('requestHeaders');
      if (test(JSON.stringify(entry.rawHeaders))) matchDetails.push('rawHeaders');
      if (test(JSON.stringify(entry.responseHeaders))) matchDetails.push('responseHeaders');
      if (test(entry.rawResponseHeadersText)) matchDetails.push('rawResponseHeadersText');

      if (matchDetails.length > 0) {
        matches.push({
          requestId: entry.id,
          url: entry.url,
          method: entry.method,
          status: entry.status,
          matchedFields: matchDetails,
          entry,
        });
      }
    }
    return matches;
  }

  /**
   * Searches response bodies. Tries Chrome's native search first; bodies it cannot search (including durable-stored ones)
   * are matched locally, so both storage modes give the same results.
   * @param {string | RegExp} query substring, or RegExp with /flags suffix
   * @param {{ requestId?: string }} [options] limit to one request
   * @returns {Promise<Array<{ requestId: string, url: string, matchLineNumbers: number[] }>>}
   */
  async searchBodies(query, options = {}) {
    const re = typeof query === 'string' ? /^\/(.+)\/([gimsuy]*)$/s.exec(query) : null;
    // A RegExp instance must contribute its source, not String(query)'s '/.../' form.
    const searchQuery = query instanceof RegExp ? query.source : (re ? re[1] : String(query));
    const isRegex = typeof query !== 'string' || Boolean(re);
    const caseSensitive = re
      ? !re[2].includes('i')          // /.../flags string: case-sensitive unless the i flag
      : query instanceof RegExp ? !query.ignoreCase // RegExp instance: its own flag
      : false;                        // plain string: substring search is case-insensitive
    const localRegex = new RegExp(searchQuery, caseSensitive ? '' : 'i');

    const single = options.requestId ? this._entries.get(options.requestId) : undefined;
    const targets = options.requestId ? (single ? [single] : []) : Array.from(this._entries.values());

    const found = await Promise.all(targets.map(async (entry) => {
      const id = entry.cdpRequestId || entry.id;
      /** @type {number[] | null} */
      let lineNumbers = null;
      try {
        const res = await this._cdp.send('Network.searchInResponseBody', {
          requestId: id,
          query: searchQuery,
          caseSensitive,
          isRegex,
        });
        lineNumbers = res.result.map((m) => m.lineNumber);
      } catch {}
      if (!lineNumbers) {
        // Native search can't see this body (evicted or durable-stored).
        // Fall back to a local match over getResponseBody; text bodies only.
        try {
          const body = await this.getResponseBody(id);
          if (body?.base64Encoded) lineNumbers = [];
          else {
            lineNumbers = String(body.body || '')
              .split('\n')
              .map((line, i) => (localRegex.test(line) ? i : -1))
              .filter((i) => i >= 0);
          }
        } catch { return null; } // body gone entirely — nothing to search
      }
      return lineNumbers.length > 0
        ? { requestId: entry.id, url: entry.url, matchLineNumbers: lineNumbers }
        : null;
    }));
    return found.filter((hit) => hit !== null);
  }

  /**
   * Replays an XHR identical to the original (method, url, body, headers) via
   * CDP Network.replayXHR. The replay fires as a fresh recorded request.
   * @param {string} requestId request id from getTraffic()
   * @returns {Promise<void>}
   */
  async replayXHR(requestId) {
    const entry = this._entries.get(this._resolveRequestId(requestId));
    if (!entry) throw new Error(`Unknown request id: ${requestId}`);
    await this._cdp.send('Network.replayXHR', { requestId: entry.cdpRequestId || entry.id });
  }

  /**
   * @param {Array<string>} [urls]
   * @returns {Promise<Array<import('devtools-protocol').Protocol.Network.Cookie>>}
   */
  async getCookies(urls) {
    const params = urls && urls.length > 0 ? { urls } : {};
    const res = await this._cdp.send('Network.getCookies', params);
    return res.cookies || [];
  }

  async clearCache() {
    await this._cdp.send('Network.clearBrowserCache');
  }

  async clearCookies() {
    await this._cdp.send('Network.clearBrowserCookies');
  }

  /**
   * @private
   */
  /** @param {string} id */
  _getOrCreateEntry(id) {
    let entry = this._entries.get(id);
    if (!entry) {
      entry = {
        id,
        cdpRequestId: id,
        redirectIndex: 0,
        redirectedFrom: null,
        redirectedTo: null,
        url: '',
        method: 'GET',
        resourceType: 'Other',
        headers: {},
        rawHeaders: null,
        postData: null,
        // CDP monotonic seconds*1000, set by the first event that carries a timestamp.
        // Never seed with Date.now(): mixing epoch ms into this field yields bogus durationMs.
        startTime: null,
        status: null,
        statusText: null,
        responseHeaders: null,
        rawResponseHeaders: null,
        rawResponseHeadersText: null,
        mimeType: null,
        remoteIPAddress: null,
        remotePort: null,
        protocol: null,
        encodedDataLength: null,
        durationMs: null,
        failed: false,
        errorText: null,
      };
      this._entries.set(id, entry);
    }
    return entry;
  }

  /**
   * @private
   */
  /**
   * Chrome reuses one requestId across a redirect chain. Re-keys the finished hop so each hop keeps its own record,
   * and the next hop gets a fresh one.
   * @returns {number}
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent} event */
  _preserveRedirectedHop(event) {
    const cause = event.redirectResponse;
    const finishedHop = cause && this._entries.get(event.requestId);
    if (!cause || !finishedHop) return 0;

    finishedHop.status = cause.status;
    finishedHop.statusText = cause.statusText;
    finishedHop.responseHeaders = cause.headers;
    finishedHop.mimeType = cause.mimeType || null;
    finishedHop.protocol = cause.protocol || null;
    finishedHop.remoteIPAddress = cause.remoteIPAddress || null;
    finishedHop.remotePort = cause.remotePort || null;
    finishedHop.redirectedTo = event.request.url;
    if (finishedHop.startTime) {
      finishedHop.durationMs = Math.round(event.timestamp * 1000 - finishedHop.startTime);
    }

    finishedHop.id = `${event.requestId}:redirect:${finishedHop.redirectIndex}`;
    this._entries.delete(event.requestId);
    this._entries.set(finishedHop.id, finishedHop);
    // Chrome sends this hop's raw headers (Set-Cookie) after the next hop has started; see _onResponseExtraInfo.
    const waiting = this._hopsAwaitingRaw.get(event.requestId) ?? [];
    waiting.push(finishedHop);
    this._hopsAwaitingRaw.set(event.requestId, waiting);
    this.emit('response', finishedHop);

    return finishedHop.redirectIndex + 1;
  }

  /** @param {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent} event */
  _onRequestWillBeSent(event) {
    const redirectIndex = this._preserveRedirectedHop(event);

    const entry = this._getOrCreateEntry(event.requestId);
    entry.redirectIndex = redirectIndex;
    entry.redirectedFrom = event.redirectResponse?.url || null;
    entry.url = event.request.url;
    entry.method = event.request.method;
    entry.headers = event.request.headers;
    entry.postData = decodePostData(event.request.postDataEntries);
    entry.resourceType = event.type || 'Other';
    entry.startTime = event.timestamp * 1000;
    entry.wallTime = event.wallTime;
    entry.initiator = event.initiator;

    this.emit('request', entry);
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.RequestWillBeSentExtraInfoEvent} event */
  _onRequestExtraInfo(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.rawHeaders = event.headers;
    entry.associatedCookies = event.associatedCookies || [];
    entry.clientSecurityState = event.clientSecurityState || null;
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.ResponseReceivedEvent} event */
  _onResponseReceived(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    const resp = event.response;
    entry.status = resp.status;
    entry.statusText = resp.statusText;
    entry.responseHeaders = resp.headers;
    entry.mimeType = resp.mimeType;
    entry.remoteIPAddress = resp.remoteIPAddress || null;
    entry.remotePort = resp.remotePort || null;
    entry.protocol = resp.protocol || null;
    entry.securityState = resp.securityState || null;

    if (entry.startTime) {
      entry.durationMs = Math.round(event.timestamp * 1000 - entry.startTime);
    }

    this.emit('response', entry);
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.ResponseReceivedExtraInfoEvent} event */
  _onResponseExtraInfo(event) {
    // A redirect hop's extra info arrives after the next hop has started, and the requestId is shared.
    // Without this, the 302's Set-Cookie would land on the final response, and the 302 would show none.
    const waiting = this._hopsAwaitingRaw.get(event.requestId);
    if (event.statusCode >= 300 && event.statusCode < 400 && waiting?.length) {
      const hop = /** @type {TrafficEntry} */ (waiting.shift());
      hop.rawResponseHeaders = event.headers;
      hop.rawResponseHeadersText = event.headersText || null;
      hop.rawStatusCode = event.statusCode;
      return;
    }
    const entry = this._getOrCreateEntry(event.requestId);
    entry.rawResponseHeaders = event.headers;
    entry.rawResponseHeadersText = event.headersText || null;
    entry.rawStatusCode = event.statusCode;
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.LoadingFinishedEvent} event */
  _onLoadingFinished(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.encodedDataLength = event.encodedDataLength;
    if (entry.startTime) {
      entry.durationMs = Math.round(event.timestamp * 1000 - entry.startTime);
    }
    this.emit('finished', entry);
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.LoadingFailedEvent} event */
  _onLoadingFailed(event) {
    const entry = this._getOrCreateEntry(event.requestId);
    entry.failed = true;
    entry.errorText = event.errorText || 'Loading failed';
    entry.canceled = event.canceled || false;
    this.emit('failed', entry);
  }
}

module.exports = NetworkController;
