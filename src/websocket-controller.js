'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');

/**
 * Controller for intercepting, inspecting, and searching WebSocket connections and frames via CDP.
 * Tailored for security research, bug bounty, and reverse engineering.
 */
class WebSocketController extends EventEmitter {
  /**
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  constructor(cdpSession) {
    super();
    if (!cdpSession) throw new TypeError('CDPSession is required for WebSocketController');

    this._cdp = cdpSession;
    /** @type {Map<string, object>} */
    this._sockets = new Map();
    this._isRecording = false;

    this._onSocketCreated = this._onSocketCreated.bind(this);
    this._onHandshakeReq = this._onHandshakeReq.bind(this);
    this._onHandshakeRes = this._onHandshakeRes.bind(this);
    this._onFrameSent = this._onFrameSent.bind(this);
    this._onFrameRecv = this._onFrameRecv.bind(this);
    this._onFrameError = this._onFrameError.bind(this);
    this._onSocketClosed = this._onSocketClosed.bind(this);
  }

  /**
   * Enables WebSocket event tracking via CDP Network domain.
   * @returns {Promise<void>}
   */
  async startRecording() {
    if (this._isRecording) return;

    this._cdp.on('Network.webSocketCreated', this._onSocketCreated);
    this._cdp.on('Network.webSocketWillSendHandshakeRequest', this._onHandshakeReq);
    this._cdp.on('Network.webSocketHandshakeResponseReceived', this._onHandshakeRes);
    this._cdp.on('Network.webSocketFrameSent', this._onFrameSent);
    this._cdp.on('Network.webSocketFrameReceived', this._onFrameRecv);
    this._cdp.on('Network.webSocketFrameError', this._onFrameError);
    this._cdp.on('Network.webSocketClosed', this._onSocketClosed);

    // WebSocket events are part of the Network domain; enable it for standalone use.
    await this._cdp.send('Network.enable');
    this._isRecording = true;
  }

  /**
   * Stops WebSocket event tracking.
   */
  stopRecording() {
    if (!this._isRecording) return;

    this._cdp.off('Network.webSocketCreated', this._onSocketCreated);
    this._cdp.off('Network.webSocketWillSendHandshakeRequest', this._onHandshakeReq);
    this._cdp.off('Network.webSocketHandshakeResponseReceived', this._onHandshakeRes);
    this._cdp.off('Network.webSocketFrameSent', this._onFrameSent);
    this._cdp.off('Network.webSocketFrameReceived', this._onFrameRecv);
    this._cdp.off('Network.webSocketFrameError', this._onFrameError);
    this._cdp.off('Network.webSocketClosed', this._onSocketClosed);

    this._isRecording = false;
  }

  /**
   * Clears all recorded WebSocket connections and frames.
   */
  clear() {
    this._sockets.clear();
  }

  /**
   * Retrieves recorded WebSocket connections with optional filtering.
   * @param {{
   *   url?: string | RegExp,
   *   state?: 'connecting' | 'open' | 'closed' | 'error'
   * }} [filter]
   * @returns {Array<object>}
   */
  getSockets(filter = {}) {
    const list = Array.from(this._sockets.values());
    return list.filter((sock) => {
      if (filter.url) {
        const matches = matchesQuery(sock.url, filter.url);
        if (!matches) return false;
      }
      if (filter.state && sock.state !== filter.state) {
        return false;
      }
      return true;
    });
  }

  /**
   * Retrieves frames for a specific socket or across all sockets.
   * @param {string} [socketIdOrUrl]
   * @param {{
   *   direction?: 'sent' | 'received',
   *   opcode?: number,
   *   query?: string | RegExp,
   *   jsonOnly?: boolean
   * }} [filter]
   * @returns {Array<object>}
   */
  getFrames(socketIdOrUrl, filter = {}) {
    let sockets = [];

    if (socketIdOrUrl) {
      if (this._sockets.has(socketIdOrUrl)) {
        sockets = [this._sockets.get(socketIdOrUrl)];
      } else {
        sockets = this.getSockets({ url: socketIdOrUrl });
      }
    } else {
      sockets = Array.from(this._sockets.values());
    }

    const allFrames = [];
    for (const s of sockets) {
      allFrames.push(...s.frames);
    }

    return allFrames.filter((frame) => {
      if (filter.direction && frame.direction !== filter.direction) {
        return false;
      }
      if (filter.opcode !== undefined && frame.opcode !== filter.opcode) {
        return false;
      }
      if (filter.jsonOnly && !frame.parsedJson) {
        return false;
      }
      if (filter.query) {
        const matches = matchesQuery(frame.payloadData, filter.query);
        if (!matches) return false;
      }
      return true;
    });
  }

  /**
   * Searches across all recorded WebSocket frames for matching strings or patterns.
   * Crucial for finding auth tokens, signatures, or specific API payloads in live WS traffic.
   * @param {string | RegExp} query
   * @param {{ direction?: 'sent' | 'received' }} [options]
   * @returns {Array<{ socketId: string, url: string, frame: object }>}
   */
  searchFrames(query, options = {}) {
    const frames = this.getFrames(undefined, {
      direction: options.direction,
      query,
    });

    return frames.map((f) => ({
      socketId: f.requestId,
      url: f.url,
      frame: f,
    }));
  }

  /**
   * @private
   */
  _getOrCreateSocket(requestId, url = '') {
    if (!this._sockets.has(requestId)) {
      this._sockets.set(requestId, {
        requestId,
        url,
        initiator: null,
        startTime: Date.now(),
        handshakeRequest: null,
        handshakeResponse: null,
        state: 'connecting',
        frames: [],
        errorMessage: null,
      });
    }
    return this._sockets.get(requestId);
  }

  /**
   * @private
   */
  _tryParseJson(str) {
    if (typeof str !== 'string' || (!str.startsWith('{') && !str.startsWith('['))) {
      return null;
    }
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  _onSocketCreated(event) {
    const sock = this._getOrCreateSocket(event.requestId, event.url);
    sock.url = event.url;
    sock.initiator = event.initiator || null;
    this.emit('socketCreated', sock);
  }

  /**
   * @private
   */
  _onHandshakeReq(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.handshakeRequest = {
      headers: event.request?.headers || {},
      wallTime: event.wallTime || Date.now() / 1000,
    };
    this.emit('handshakeRequest', { requestId: event.requestId, ...sock.handshakeRequest });
  }

  /**
   * @private
   */
  _onHandshakeRes(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.state = 'open';
    sock.handshakeResponse = {
      status: event.response?.status,
      statusText: event.response?.statusText,
      headers: event.response?.headers || {},
      headersText: event.response?.headersText || null,
    };
    this.emit('handshakeResponse', { requestId: event.requestId, ...sock.handshakeResponse });
  }

  /**
   * @private
   */
  _onFrameSent(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    // note: attached after the handshake (e.g. a second process on a live tab)
    // creates the socket lazily on its first frame — no handshake was seen, so
    // the URL stays '' and the state must be corrected to 'open' (frames are
    // flowing). Upgrade path: recover the URL via Network domain if CDP ever
    // exposes a request-id → URL lookup for WebSocket requests.
    if (sock.state === 'connecting' && !sock.handshakeResponse) sock.state = 'open';
    const frameData = event.response;
    const entry = {
      requestId: event.requestId,
      url: sock.url,
      direction: 'sent',
      timestamp: event.timestamp,
      wallTime: Date.now(),
      opcode: frameData.opcode, // 1: text, 2: binary, 8: close, 9: ping, 10: pong
      payloadData: frameData.payloadData,
      isBinary: frameData.opcode === 2,
      isText: frameData.opcode === 1,
      parsedJson: this._tryParseJson(frameData.payloadData),
    };
    sock.frames.push(entry);
    this.emit('frameSent', entry);
    this.emit('frame', entry);
  }

  /**
   * @private
   */
  _onFrameRecv(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    if (sock.state === 'connecting' && !sock.handshakeResponse) sock.state = 'open'; // late attach — see _onFrameSent
    const frameData = event.response;
    const entry = {
      requestId: event.requestId,
      url: sock.url,
      direction: 'received',
      timestamp: event.timestamp,
      wallTime: Date.now(),
      opcode: frameData.opcode,
      payloadData: frameData.payloadData,
      isBinary: frameData.opcode === 2,
      isText: frameData.opcode === 1,
      parsedJson: this._tryParseJson(frameData.payloadData),
    };
    sock.frames.push(entry);
    this.emit('frameReceived', entry);
    this.emit('frame', entry);
  }

  /**
   * @private
   */
  _onFrameError(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.state = 'error';
    sock.errorMessage = event.errorMessage;
    this.emit('socketError', { requestId: event.requestId, errorMessage: event.errorMessage });
    if (this.listenerCount('error') > 0) {
      this.emit('error', { requestId: event.requestId, errorMessage: event.errorMessage });
    }
  }

  /**
   * @private
   */
  _onSocketClosed(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.state = 'closed';
    sock.endTime = Date.now();
    this.emit('socketClosed', { requestId: event.requestId, timestamp: event.timestamp });
  }
}

module.exports = WebSocketController;
