'use strict';

const EventEmitter = require('node:events');
const matchesQuery = require('./match-query');

/**
 * Self-generated times are Unix epoch seconds, the unit CDP's TimeSinceEpoch uses. Frames also carry
 * `timestamp` (MonotonicTime, also seconds) straight from the protocol, so mixing Date.now()'s
 * milliseconds into `wallTime`/`startTime`/`endTime` would put two scales on one socket.
 * @returns {number}
 */
function nowEpochSeconds() {
  return Date.now() / 1000;
}

/** @typedef {import('./types/websocket').WsSocket} WsSocket */
/** @typedef {import('./types/websocket').WsFrame} WsFrame */

class WebSocketController extends EventEmitter {
  /**
   * @param {import('puppeteer-core').CDPSession} cdpSession
   */
  constructor(cdpSession) {
    super();
    if (!cdpSession) throw new TypeError('CDPSession is required for WebSocketController');

    this._cdp = cdpSession;
    /** @type {Map<string, WsSocket>} */
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
   * @param {{ enableNetwork?: boolean }} [options] enableNetwork sends Network.enable, which is what
   *   delivers the webSocket* events on a session that enabled nothing else. chrome-client passes
   *   false: its network controller already enabled the domain on this same session, and a second,
   *   parameterless Network.enable resets the durable-message buffer size that startRecording()
   *   configured right after it (NetworkHandler::Enable zeroes durable_message_max_total_size_).
   *   Restarting this controller by hand with the default sends that second enable: stop and start
   *   `client.network` too if the durable bodies are still needed.
   * @returns {Promise<void>}
   */
  async startRecording({ enableNetwork = true } = {}) {
    if (this._isRecording) return;

    this._cdp.on('Network.webSocketCreated', this._onSocketCreated);
    this._cdp.on('Network.webSocketWillSendHandshakeRequest', this._onHandshakeReq);
    this._cdp.on('Network.webSocketHandshakeResponseReceived', this._onHandshakeRes);
    this._cdp.on('Network.webSocketFrameSent', this._onFrameSent);
    this._cdp.on('Network.webSocketFrameReceived', this._onFrameRecv);
    this._cdp.on('Network.webSocketFrameError', this._onFrameError);
    this._cdp.on('Network.webSocketClosed', this._onSocketClosed);

    try {
      if (enableNetwork) await this._cdp.send('Network.enable');
    } catch (error) {
      // Enable failed, so _isRecording stays false and a later startRecording() would arm these
      // handlers a second time — every frame would then be recorded twice. Undo, then rethrow so the
      // caller gets to report it.
      this._cdp.off('Network.webSocketCreated', this._onSocketCreated);
      this._cdp.off('Network.webSocketWillSendHandshakeRequest', this._onHandshakeReq);
      this._cdp.off('Network.webSocketHandshakeResponseReceived', this._onHandshakeRes);
      this._cdp.off('Network.webSocketFrameSent', this._onFrameSent);
      this._cdp.off('Network.webSocketFrameReceived', this._onFrameRecv);
      this._cdp.off('Network.webSocketFrameError', this._onFrameError);
      this._cdp.off('Network.webSocketClosed', this._onSocketClosed);
      throw error;
    }
    this._isRecording = true;
  }

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

  clear() {
    this._sockets.clear();
  }

  /**
   * @param {{
   *   url?: string | RegExp,
   *   state?: 'connecting' | 'open' | 'closed' | 'error'
   * }} [filter]
   * @returns {WsSocket[]}
   */
  getSockets(filter = {}) {
    const list = Array.from(this._sockets.values());
    return list.filter((sock) =>
      (!filter.url || matchesQuery(sock.url, filter.url)) &&
      (!filter.state || sock.state === filter.state));
  }

  /**
   * @param {string} [socketIdOrUrl]
   * @param {{
   *   direction?: 'sent' | 'received',
   *   opcode?: number,
   *   query?: string | RegExp,
   *   jsonOnly?: boolean
   * }} [filter]
   * @returns {WsFrame[]}
   */
  getFrames(socketIdOrUrl, filter = {}) {
    /** @type {WsSocket[]} */
    let sockets = [];

    if (socketIdOrUrl) {
      if (this._sockets.has(socketIdOrUrl)) {
        sockets = [this._sockets.get(socketIdOrUrl)].filter((sock) => sock !== undefined);
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
   * @param {string | RegExp} query
   * @param {{ direction?: 'sent' | 'received' }} [options]
   * @returns {Array<{ socketId: string, url: string, frame: WsFrame }>}
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
  /**
   * @param {string} requestId
   * @param {string} [url]
   * @returns {WsSocket}
   */
  _getOrCreateSocket(requestId, url = '') {
    let sock = this._sockets.get(requestId);
    if (!sock) {
      sock = {
        requestId,
        url,
        initiator: null,
        startTime: nowEpochSeconds(),
        handshakeRequest: null,
        handshakeResponse: null,
        state: 'connecting',
        frames: [],
        errorMessage: null,
      };
      this._sockets.set(requestId, sock);
    }
    return sock;
  }

  /**
   * @private
   */
  /** @param {string} str */
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
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketCreatedEvent} event */
  _onSocketCreated(event) {
    const sock = this._getOrCreateSocket(event.requestId, event.url);
    sock.url = event.url;
    sock.initiator = event.initiator || null;
    this.emit('socketCreated', sock);
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketWillSendHandshakeRequestEvent} event */
  _onHandshakeReq(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.handshakeRequest = {
      headers: event.request?.headers || {},
      wallTime: event.wallTime || nowEpochSeconds(),
    };
    this.emit('handshakeRequest', { requestId: event.requestId, ...sock.handshakeRequest });
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketHandshakeResponseReceivedEvent} event */
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
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketFrameSentEvent} event */
  _onFrameSent(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    // note: attached after the handshake (e.g. a second process on a live tab)
    // creates the socket lazily on its first frame — no handshake was seen, so
    // the URL stays '' and the state must be corrected to 'open' (frames are
    // flowing). Upgrade path: recover the URL via Network domain if CDP ever
    // exposes a request-id → URL lookup for WebSocket requests.
    if (sock.state === 'connecting' && !sock.handshakeResponse) sock.state = 'open';
    const frameData = event.response;
    /** @type {WsFrame} */
    const entry = {
      requestId: event.requestId,
      url: sock.url,
      direction: 'sent',
      timestamp: event.timestamp,
      wallTime: nowEpochSeconds(),
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
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketFrameReceivedEvent} event */
  _onFrameRecv(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    if (sock.state === 'connecting' && !sock.handshakeResponse) sock.state = 'open'; // late attach — see _onFrameSent
    const frameData = event.response;
    /** @type {WsFrame} */
    const entry = {
      requestId: event.requestId,
      url: sock.url,
      direction: 'received',
      timestamp: event.timestamp,
      wallTime: nowEpochSeconds(),
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
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketFrameErrorEvent} event */
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
  /** @param {import('devtools-protocol').Protocol.Network.WebSocketClosedEvent} event */
  _onSocketClosed(event) {
    const sock = this._getOrCreateSocket(event.requestId);
    sock.state = 'closed';
    sock.endTime = nowEpochSeconds();
    this.emit('socketClosed', { requestId: event.requestId, timestamp: event.timestamp });
  }
}

module.exports = WebSocketController;
