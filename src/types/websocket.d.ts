import type { Protocol } from 'devtools-protocol';

/** One WebSocket frame as the controller records it. */
export interface WsFrame {
  requestId: string;
  url: string;
  direction: 'sent' | 'received';
  /** CDP MonotonicTime: seconds since an arbitrary point in the past, not epoch seconds. */
  timestamp: number;
  /** CDP TimeSinceEpoch: Unix epoch **seconds** — the same unit as WsSocket.startTime/endTime. */
  wallTime: number;
  opcode: number;
  payloadData: string;
  isBinary: boolean;
  isText: boolean;
  parsedJson: unknown;
}

/** One WebSocket connection. Handshake fields are null until the handshake events arrive. */
export interface WsSocket {
  requestId: string;
  url: string;
  initiator: Protocol.Network.Initiator | null;
  /** CDP TimeSinceEpoch: Unix epoch **seconds**. */
  startTime: number;
  /** CDP TimeSinceEpoch: Unix epoch **seconds**; unset while the socket never reported a close. */
  endTime?: number;
  handshakeRequest: {
    headers: Protocol.Network.Headers;
    /** CDP TimeSinceEpoch: Unix epoch **seconds**. */
    wallTime: number;
  } | null;
  handshakeResponse: {
    status: number | undefined;
    statusText: string | undefined;
    headers: Protocol.Network.Headers;
    headersText: string | null;
  } | null;
  state: 'connecting' | 'open' | 'closed' | 'error';
  frames: WsFrame[];
  errorMessage: string | null;
}
