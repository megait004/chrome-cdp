'use strict';
// Everything that decides how a result reaches the terminal: the 60 KB reply cap, credential redaction,
// the traffic projection, and the short `tag#id "text"` hints.
const fs = require('node:fs');
const path = require('node:path');

// Repo root, so replies still land in <repo>/.tmp/results now that the code lives a directory deeper.
const ROOT = path.join(__dirname, '..', '..');

/** Above this size a reply is written to a file instead of stdout, so it cannot flood an agent's context. */
const MAX_INLINE_BYTES = 60_000;

/**
 * Writes the JSON result to stdout, or to `--out <file>`. A file keeps large output out of the agent's context.
 * @param {object} result JSON-serializable command result
 * @param {string|null} outFile `--out` value
 */
async function emit(result, outFile) {
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    const abs = path.resolve(outFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true }); // agents forget to mkdir
    await fs.promises.writeFile(abs, json, 'utf8');
    console.log(`Saved ${Buffer.byteLength(json)} bytes of JSON to: ${abs}`);
    return;
  }
  if (Buffer.byteLength(json) > MAX_INLINE_BYTES) {
    // A reply this large costs more context than the answer is worth. File it and say where.
    const dir = path.join(ROOT, '.tmp', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, `result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.promises.writeFile(abs, json, 'utf8');
    const keys = result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : [];
    console.log(JSON.stringify({ savedTo: abs, bytes: Buffer.byteLength(json), keys, note: 'Reply was over 60 KB, so it went to a file. Read it, or pass --out <file> to choose the path.' }, null, 2));
    return;
  }
  console.log(json);
}

/**
 * Short `tag#id "text"` lines for error hints, shared by the click and wait failure paths.
 * @param {import('../types/snapshot').SnapshotElement[]} elements result of interactiveSnapshot()
 * @param {{ limit?: number, skipDisabled?: boolean }} [options]
 * @returns {string[]}
 */
function interactiveHints(elements, { limit = 8, skipDisabled = false } = {}) {
  return elements
    .filter((e) => !skipDisabled || !e.disabled)
    .slice(0, limit)
    // name is shown as an attribute selector when there is no id, so the hint can be used as a selector.
    .map((e) => `${e.tag}${e.id ? '#' + e.id : e.name ? '[name="' + e.name + '"]' : ''}${e.text ? ' "' + e.text.slice(0, 30) + '"' : ''}`);
}

/**
 * @param {Array<import('../network-controller').TrafficEntry>} httpTraffic
 * @param {import('../types/websocket').WsSocket[]} wsSockets
 * @param {string} finalUrl
 * @param {boolean} showHeaders
 */
function printTraffic(httpTraffic, wsSockets, finalUrl, showHeaders) {
  console.log(`\n=== HTTP Requests (${httpTraffic.length}) === (final URL: ${finalUrl})`);
  httpTraffic.forEach((t) => {
    console.log(`[${t.method || 'GET'}] ${t.status || '...'} ${t.url} (${t.resourceType})`);
    if (showHeaders) {
      for (const [name, value] of Object.entries(t.headers || {})) console.log(`    > ${name}: ${value}`);
      // A header sent twice (Set-Cookie) is joined with newlines by CDP: print each value on its own line, with the name.
      for (const [name, value] of Object.entries(t.rawResponseHeaders || t.responseHeaders || {})) {
        for (const line of String(value).split('\n')) console.log(`    < ${name}: ${line}`);
      }
    }
  });

  console.log(`\n=== WebSocket Connections (${wsSockets.length}) ===`);
  wsSockets.forEach((s) => {
    console.log(`[WS] ${s.url} - State: ${s.state}, Frames: ${s.frames.length}`);
  });
}

/** Headers whose value is a credential. Redacted when a reply is printed to stdout, kept in --out files. */
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

/**
 * @template {Record<string, string> | null} T
 * @param {T} headers
 * @returns {T}
 */
function redactHeaders(headers) {
  if (!headers) return headers;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = SECRET_HEADERS.test(name) ? '[REDACTED]' : value;
  return /** @type {T} */ (out);
}

/** @param {string} text */
function redactRawText(text) {
  return text.replace(/^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token):[^\r\n]*/gim, '$1: [REDACTED]');
}

/** @param {import('../network-controller').TrafficEntry} entry */
function redactEntry(entry) {
  const copy = { ...entry };
  copy.headers = redactHeaders(entry.headers);
  copy.rawHeaders = redactHeaders(entry.rawHeaders);
  copy.responseHeaders = redactHeaders(entry.responseHeaders);
  copy.rawResponseHeaders = redactHeaders(entry.rawResponseHeaders);
  if (typeof entry.rawResponseHeadersText === 'string')
    copy.rawResponseHeadersText = entry.rawResponseHeadersText.replace(/^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key):[^\r\n]*/gim, '$1: [REDACTED]');
  return copy;
}

/**
 * The fields a reader needs to find a request and decide what to read next. The raw header maps,
 * initiator and cookie bookkeeping are what make a full capture megabytes for a page like deadshot.io.
 * @param {import('../network-controller').TrafficEntry & { body?: unknown, parsedJson?: unknown }} entry
 * @param {boolean} redact
 */
function slimEntry(entry, redact) {
  return {
    id: entry.id,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    resourceType: entry.resourceType,
    mimeType: entry.mimeType,
    protocol: entry.protocol,
    startTime: entry.startTime,
    durationMs: entry.durationMs,
    encodedDataLength: entry.encodedDataLength,
    failed: entry.failed || undefined,
    errorText: entry.errorText || undefined,
    redirectIndex: entry.redirectIndex || undefined,
    redirectedFrom: entry.redirectedFrom || undefined,
    redirectedTo: entry.redirectedTo || undefined,
    postData: entry.postData || undefined,
    headers: redact ? redactHeaders(entry.headers) : entry.headers,
    ...('body' in entry ? { body: entry.body } : {}),
    ...('parsedJson' in entry ? { parsedJson: entry.parsedJson } : {}),
  };
}

/** @param {import('../types/websocket').WsSocket} socket @param {boolean} redact */
function slimSocket(socket, redact) {
  return {
    url: socket.url,
    state: socket.state,
    frames: socket.frames.length,
    handshakeRequest: socket.handshakeRequest ? { headers: redact ? redactHeaders(socket.handshakeRequest.headers) : socket.handshakeRequest.headers } : null,
    handshakeResponse: socket.handshakeResponse ? { status: socket.handshakeResponse.status, headers: redact ? redactHeaders(socket.handshakeResponse.headers) : socket.handshakeResponse.headers } : null,
  };
}

module.exports = {
  emit,
  interactiveHints,
  printTraffic,
  redactEntry,
  redactHeaders,
  redactRawText,
  slimEntry,
  slimSocket,
};
