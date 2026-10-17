'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { messageOf, sleep } = require('./util');
const { waitUntil } = require('./waiting');

/** @typedef {import('puppeteer-core').CDPSession} CDPSession */
/** @typedef {import('devtools-protocol').Protocol.Network.Headers} Headers */
/** @typedef {InstanceType<typeof import('./chrome-client')>} ChromeClientInstance */

/**
 * Per-request state while its events are still arriving; one entry per in-flight request.
 * @typedef {{
 *   url?: string, method?: string, type?: string, ts?: number,
 *   postData?: string | null, postDataPending?: Promise<string | null> | null, reqHeaders?: Headers, rawReq?: Headers,
 *   status?: number, rawStatus?: number, mimeType?: string, resHeaders?: Headers, rawRes?: Headers,
 *   remoteIp?: string
 * }} RequestState
 */

/**
 * One line of requests.jsonl. Which fields are present depends on `kind`.
 * @typedef {{
 *   kind: 'response' | 'redirect' | 'failed' | 'unfinished', session: string, id?: string,
 *   url?: string, method?: string, type?: string, ts?: number,
 *   status?: number | null, location?: string | null, mimeType?: string | null,
 *   requestHeaders?: Headers | null, responseHeaders?: Headers | null, postData?: string | null,
 *   remoteIp?: string, file?: string | null, bytes?: number, sha256?: string | null,
 *   error?: string | null, canceled?: boolean
 * }} RequestRow
 */

/**
 * One entry of manifest.json. index-site reads `url`, `mimeType` and `file`.
 * @typedef {{
 *   url?: string, method?: string, status?: number, resourceType?: string, mimeType?: string | null,
 *   file: string, bytes?: number, sha256?: string | null, requestHeaders?: Headers | null,
 *   responseHeaders?: Headers | null, postData?: string | null, session: string
 * }} ManifestFile
 */

/**
 * @typedef {{ pageUrl: string, requestedUrl: string, navigationError: string | null, files: ManifestFile[], failed: Array<{ url?: string, error?: string | null }>, redirects: number }} Manifest
 */

const ACTIVE = 'ACTIVE'; // file in outRoot naming the run that is recording now
const MAX_RECORD_MS = 60 * 60 * 1000; // safety stop when nobody runs `mirror stop`

/** @param {number} ms @returns {Promise<void>} */


const STORAGE_JS = `(() => {
  const dump = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch (e) { o.__error = String(e); } return o; };
  return JSON.stringify({ url: location.href, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) });
})()`;

/**
 * @param {string} urlStr
 * @returns {string[]}
 */
function localSegments(urlStr) {
  const u = new URL(urlStr);
  const clean = (/** @type {string} */ s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean).map((s) => (s === '..' ? '_' : clean(s)));
  if (u.pathname.endsWith('/') || segs.length === 0) segs.push('index.html');
  if (u.search) {
    // Same path, different query = different file. Hash the query into the name.
    const h = crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8);
    const last = /** @type {string} */ (segs.pop());
    const ext = path.extname(last);
    segs.push(`${last.slice(0, last.length - ext.length)}__${h}${ext}`);
  }
  return [clean(u.host), ...segs];
}

/**
 * @param {string} outRoot
 * @param {string} url
 * @returns {string}
 */
function createRun(outRoot, url) {
  const host = new URL(url).host.replaceAll(':', '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, host, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outRoot, host, 'LATEST'), stamp);
  fs.writeFileSync(path.join(outRoot, ACTIVE), dir);
  return dir;
}

/**
 * @param {string} outRoot
 * @returns {string | null}
 */
function activeRun(outRoot) {
  const p = path.join(outRoot, ACTIVE);
  if (!fs.existsSync(p)) return null;
  const dir = fs.readFileSync(p, 'utf8');
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, 'manifest.json'))) return null;
  // A recorder that crashed leaves ACTIVE behind and would block every later start. recorder.pid says
  // whether that process still exists; if not, the run is stale and ACTIVE is cleared.
  const pidFile = path.join(dir, 'recorder.pid');
  if (!fs.existsSync(pidFile)) return dir; // the parent writes this right after spawn, so a missing file means it is starting
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  if (isAlive(pid)) return dir;
  fs.rmSync(p, { force: true });
  return null;
}

/** @param {number} pid @returns {boolean} */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'; // exists, owned by someone else
  }
}

/**
 * What one recording run keeps while the tab is being recorded.
 * @typedef {{
 *   runDir: string,
 *   reqs: Map<string, RequestState>,
 *   pending: Set<Promise<void>>,
 *   redirectWait: Map<string, RequestRow[]>,
 *   fetchDone: Set<string>,
 *   used: Set<string>,
 *   seq: number,
 *   lastActivity: number,
 * }} Recorder
 */

/** @param {Recorder} rec @param {string} msg */
function recLog(rec, msg) {
  fs.appendFileSync(path.join(rec.runDir, 'recorder.log'), `${new Date().toISOString()} ${msg}\n`);
}

/** @param {Recorder} rec @param {string} file @param {object} obj */
function recEmit(rec, file, obj) {
  fs.appendFileSync(path.join(rec.runDir, file), JSON.stringify(obj) + '\n');
}

/** @param {string} runDir @returns {Recorder} */
function newRecorder(runDir) {
  return {
    runDir,
    reqs: new Map(),
    pending: new Set(),
    redirectWait: new Map(),
    fetchDone: new Set(),
    used: new Set(),
    seq: 0,
    lastActivity: Date.now(), // mirror stop waits for the network to go quiet after this
  };
}

/**
 * The folder path for a URL. A second URL with the same path (for example another query) gets a numbered name,
 * because Windows folders are case-insensitive and two files cannot share one name.
 * @param {Recorder} rec
 * @param {string} u
 * @returns {string[]}
 */
function uniqueSegments(rec, u) {
  const rel = localSegments(u);
  const key = rel.join('/').toLowerCase();
  if (!rec.used.has(key)) {
    rec.used.add(key);
    return rel;
  }
  const last = /** @type {string} */ (rel.at(-1));
  const ext = path.extname(last);
  rel[rel.length - 1] = `${last.slice(0, last.length - ext.length)}__${++rec.seq}${ext}`;
  rec.used.add(rel.join('/').toLowerCase());
  return rel;
}

/**
 * @param {Recorder} rec
 * @param {string} url
 * @param {Buffer | null} body
 * @returns {{ file: string | null, error: string | null }}
 */
function writeBody(rec, url, body) {
  if (!body) return { file: null, error: null };
  const rel = uniqueSegments(rec, url);
  try {
    fs.mkdirSync(path.join(rec.runDir, ...rel.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(rec.runDir, ...rel), body);
    return { file: rel.join('/'), error: null };
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return { file: null, error: `write: ${code || messageOf(err)}` }; // e.g. a path that is both file and folder
  }
}

/**
 * Saves one finished response. `pre` is set when Fetch already holds the state and the body (Document responses).
 * @param {Recorder} rec
 * @param {CDPSession} session
 * @param {string} tag
 * @param {string} requestId
 * @param {{ s: RequestState, body: Buffer | null, error: string | null }} [pre]
 * @returns {Promise<void>}
 */
async function saveBody(rec, session, tag, requestId, pre) {
  const k = `${tag}:${requestId}`;
  // A redirect hop answered through Fetch keeps its state: the next hop of the same requestId still reads its url.
  const s = pre ? pre.s : rec.reqs.get(k) || {};
  if (!pre) rec.reqs.delete(k);
  if (!pre && rec.fetchDone.has(requestId)) return; // already saved from the Fetch path
  if (!/^https?:/.test(s.url || '')) return;

  let body = pre ? pre.body : null;
  let error = pre ? pre.error : null;
  if (!pre) {
    try {
      const r = await session.send('Network.getResponseBody', { requestId });
      body = Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8');
    } catch (err) {
      error = messageOf(err).slice(0, 200); // e.g. 204, HEAD, CORS preflight: no body exists
    }
  }
  const written = writeBody(rec, s.url || '', body);
  recEmit(rec, 'requests.jsonl', {
    kind: 'response',
    session: tag,
    id: requestId,
    url: s.url,
    method: s.method,
    type: s.type,
    status: s.rawStatus ?? s.status,
    mimeType: s.mimeType,
    requestHeaders: s.rawReq ?? s.reqHeaders ?? null,
    postData: s.postData ?? (await s.postDataPending ?? null),
    responseHeaders: s.rawRes ?? s.resHeaders ?? null,
    remoteIp: s.remoteIp,
    file: written.file,
    bytes: body ? body.length : 0,
    sha256: body ? crypto.createHash('sha256').update(body).digest('hex') : null,
    error: written.error ?? error,
    ts: s.ts,
  });
}

/**
 * @param {Recorder} rec
 * @param {string} tag
 * @param {string} id
 * @returns {RequestState}
 */
function stateOf(rec, tag, id) {
  const k = `${tag}:${id}`;
  if (!rec.reqs.has(k)) rec.reqs.set(k, {});
  return /** @type {RequestState} */ (rec.reqs.get(k));
}

/**
 * A redirect hop ends here. Chrome keeps no body for it, so it is recorded as metadata only. Its raw headers
 * (Set-Cookie) arrive after the next hop has started, so the record waits in redirectWait until
 * responseReceivedExtraInfo delivers them (or the run stops).
 * @param {Recorder} rec
 * @param {string} tag
 * @param {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent} e
 * @param {RequestState} s
 */
function holdRedirectHop(rec, tag, e, s) {
  const redirect = /** @type {import('devtools-protocol').Protocol.Network.Response} */ (e.redirectResponse);
  const k = `${tag}:${e.requestId}`;
  const list = rec.redirectWait.get(k) ?? [];
  list.push({
    kind: 'redirect',
    session: tag,
    id: e.requestId,
    url: s.url,
    method: s.method,
    type: s.type,
    status: redirect.status,
    location: redirect.headers?.location ?? redirect.headers?.Location ?? null,
    requestHeaders: s.rawReq ?? s.reqHeaders ?? null,
    responseHeaders: redirect.headers,
    ts: e.timestamp,
  });
  rec.redirectWait.set(k, list);
  for (const key of /** @type {Array<keyof RequestState>} */ (Object.keys(s))) delete s[key];
}

/**
 * Subscribes to Network events on one CDP session.
 * @param {Recorder} rec
 * @param {CDPSession} session
 * @param {string} tag
 */
function watch(rec, session, tag) {
  session.on('Network.requestWillBeSent', (e) => {
    rec.lastActivity = Date.now();
    const s = stateOf(rec, tag, e.requestId);
    // note: CDP does not guarantee whether requestWillBeSentExtraInfo arrives before or after its
    // requestWillBeSent. Chromium sends it after, which this code relies on. If it ever arrives first
    // for a redirect hop, that hop's raw Cookie is dropped by the reset in holdRedirectHop.
    if (e.redirectResponse) holdRedirectHop(rec, tag, e, s);
    Object.assign(s, {
      url: e.request.url,
      method: e.request.method,
      postData: null,
      // the inline postData field is deprecated; fetch the body only when the request has one
      postDataPending: e.request.hasPostData
        ? session.send('Network.getRequestPostData', { requestId: e.requestId }).then((r) => r.postData).catch(() => null)
        : null,
      reqHeaders: e.request.headers,
      type: e.type,
      ts: e.timestamp,
    });
  });
  session.on('Network.requestWillBeSentExtraInfo', (e) => {
    stateOf(rec, tag, e.requestId).rawReq = e.headers; // raw Cookie header as sent
  });
  session.on('Network.responseReceived', (e) => {
    const s = stateOf(rec, tag, e.requestId);
    Object.assign(s, {
      url: s.url || e.response.url,
      type: s.type || e.type,
      status: e.response.status,
      mimeType: e.response.mimeType,
      resHeaders: e.response.headers,
      remoteIp: e.response.remoteIPAddress,
    });
  });
  session.on('Network.responseReceivedExtraInfo', (e) => {
    const waiting = rec.redirectWait.get(`${tag}:${e.requestId}`);
    if (e.statusCode >= 300 && e.statusCode < 400 && waiting?.length) {
      const hop = /** @type {RequestRow} */ (waiting.shift()); // redirect hops arrive in order
      recEmit(rec, 'requests.jsonl', { ...hop, status: e.statusCode, responseHeaders: e.headers, rawHeaders: true });
      return;
    }
    const s = stateOf(rec, tag, e.requestId);
    s.rawRes = e.headers; // raw Set-Cookie headers
    s.rawStatus = e.statusCode;
  });
  session.on('Network.loadingFinished', (e) => {
    rec.lastActivity = Date.now();
    /** @type {Promise<void>} */
    const p = saveBody(rec, session, tag, e.requestId).finally(() => rec.pending.delete(p));
    rec.pending.add(p);
  });
  session.on('Network.loadingFailed', (e) => {
    const s = stateOf(rec, tag, e.requestId);
    rec.reqs.delete(`${tag}:${e.requestId}`);
    recEmit(rec, 'requests.jsonl', { kind: 'failed', session: tag, id: e.requestId, url: s.url, method: s.method, type: e.type || s.type, error: e.errorText, canceled: Boolean(e.canceled), ts: e.timestamp });
  });
  session.on('Network.webSocketCreated', (e) => recEmit(rec, 'websockets.jsonl', { kind: 'open', session: tag, id: e.requestId, url: e.url }));
  session.on('Network.webSocketFrameSent', (e) => recEmit(rec, 'websockets.jsonl', { kind: 'sent', session: tag, id: e.requestId, opcode: e.response.opcode, payload: e.response.payloadData, ts: e.timestamp }));
  session.on('Network.webSocketFrameReceived', (e) => recEmit(rec, 'websockets.jsonl', { kind: 'recv', session: tag, id: e.requestId, opcode: e.response.opcode, payload: e.response.payloadData, ts: e.timestamp }));
  session.on('Network.webSocketClosed', (e) => recEmit(rec, 'websockets.jsonl', { kind: 'closed', session: tag, id: e.requestId, ts: e.timestamp }));
  session.send('Network.enable', { maxTotalBufferSize: 1024 * 1024 * 1024, maxResourceBufferSize: 256 * 1024 * 1024 })
    .catch((err) => recLog(rec, `Network.enable ${tag}: ${messageOf(err)}`));
}

/**
 * @param {Recorder} rec
 * @param {ChromeClientInstance} client
 * @param {CDPSession} root
 */
async function followTargets(rec, client, root) {
  root.on('Target.attachedToTarget', (e) => {
    const child = root.connection()?.session(e.sessionId);
    if (!child) {
      recLog(rec, `no session handle for child target ${e.targetInfo?.type} ${e.targetInfo?.url}`);
      return;
    }
    watch(rec, child, e.sessionId);
    // Child targets start paused, so the first request of an out-of-process iframe is not lost.
    // Network.enable is sent first; CDP handles messages per session in order.
    if (e.waitingForDebugger) child.send('Runtime.runIfWaitingForDebugger').catch((err) => recLog(rec, `resume ${e.sessionId}: ${messageOf(err)}`));
  });
  await root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    .catch((err) => recLog(rec, `setAutoAttach: ${messageOf(err)}`));
  // Shared and service workers are not auto-attached from a page session; the browser session discovers them.
  // note: attachToTarget cannot pause the target, so requests a shared worker starts before this runs can be missed.
  const browserCdp = await client.browser.target().createCDPSession();
  browserCdp.on('Target.targetCreated', async (e) => {
    if (e.targetInfo.type !== 'shared_worker' && e.targetInfo.type !== 'service_worker') return;
    try {
      const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: e.targetInfo.targetId, flatten: true });
      const child = browserCdp.connection()?.session(sessionId);
      if (child) watch(rec, child, sessionId);
      else recLog(rec, `no session handle for ${e.targetInfo.type} ${e.targetInfo.url}`);
    } catch (err) {
      recLog(rec, `attach ${e.targetInfo.type}: ${messageOf(err)}`);
    }
  });
  await browserCdp.send('Target.setDiscoverTargets', { discover: true }).catch((err) => recLog(rec, `setDiscoverTargets: ${messageOf(err)}`));
}

/**
 * Document bodies of out-of-process iframes never reach loadingFinished, and Page.getResourceContent does not
 * keep them. Fetch paused at response time returns the raw body, so only Documents are paused.
 * @param {Recorder} rec
 * @param {CDPSession} root
 */
async function watchDocuments(rec, root) {
  root.on('Fetch.requestPaused', async (e) => {
    try {
      if (e.networkId && e.responseStatusCode && /^https?:/.test(e.request.url)) {
        rec.fetchDone.add(e.networkId);
        /** @type {Headers} */
        const rawRes = {};
        for (const h of e.responseHeaders || []) rawRes[h.name] = rawRes[h.name] ? `${rawRes[h.name]}\n${h.value}` : h.value;
        const s = { ...rec.reqs.get(`page:${e.networkId}`), url: e.request.url, method: e.request.method, type: e.resourceType, status: e.responseStatusCode, rawRes };
        /** @type {Buffer | null} */
        let body = null;
        /** @type {string | null} */
        let error = null;
        try {
          const b = await root.send('Fetch.getResponseBody', { requestId: e.requestId });
          body = Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8');
        } catch (err) {
          error = messageOf(err).slice(0, 200); // redirects and 204 have no body
        }
        await saveBody(rec, root, 'page', e.networkId, { s, body, error });
      }
    } catch (err) {
      recLog(rec, `fetch ${e.request?.url}: ${messageOf(err)}`);
    } finally {
      await root.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    }
  });
  await root.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] })
    .catch((err) => recLog(rec, `Fetch.enable: ${messageOf(err)}`));
}

/**
 * Writes what never finished: redirect hops still waiting for headers, and requests with no loadingFinished.
 * Recorded, so a gap is visible in the output.
 * @param {Recorder} rec
 */
function flushRecorder(rec) {
  const file = path.join(rec.runDir, 'requests.jsonl');
  for (const list of rec.redirectWait.values()) for (const row of list) fs.appendFileSync(file, JSON.stringify(row) + '\n');
  rec.redirectWait.clear();
  for (const [k, s] of rec.reqs) {
    const id = k.slice(k.indexOf(':') + 1);
    if (s.url && !rec.fetchDone.has(id)) {
      /** @type {RequestRow} */
      const row = { kind: 'unfinished', session: k.split(':')[0] || '', id, url: s.url, method: s.method, type: s.type, status: s.status ?? null, ts: s.ts };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    }
  }
  rec.reqs.clear();
}

/**
 * Records the tab's network responses, WebSocket frames, cookies and storage until <runDir>/STOP appears.
 * Bodies are read as each load finishes, because Chrome evicts them later. Headers are kept raw, cookies included.
 * Child targets (out-of-process iframes) are attached too.
 * @param {ChromeClientInstance} client
 * @param {string} url
 * @param {string} runDir
 */
async function recordSite(client, url, runDir) {
  const root = client.cdp;
  const rec = newRecorder(runDir);
  watch(rec, root, 'page');
  await followTargets(rec, client, root);
  // Cache off so the page is served fresh; otherwise "latest" is whatever the browser kept.
  await root.send('Network.setCacheDisabled', { cacheDisabled: true });
  await watchDocuments(rec, root);
  fs.writeFileSync(path.join(runDir, 'READY'), url);
  /** @type {string | null} */
  let navigationError = null;
  await client.goto(url, { waitUntil: 'load' }).catch((err) => {
    navigationError = messageOf(err);
    recLog(rec, `goto: ${navigationError}`);
  });

  const stopFile = path.join(runDir, 'STOP');
  await waitUntil(() => fs.existsSync(stopFile), { timeout: MAX_RECORD_MS, every: 500 });
  if (!fs.existsSync(stopFile)) recLog(rec, 'max duration reached, stopping');

  await root.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  // Stop only once the network has been quiet for 1.5s (at most 10s more), so a lazy load that is still
  // starting is not cut off. Without this, the caller had to guess a sleep.
  await waitUntil(() => Date.now() - rec.lastActivity >= 1500, { timeout: 10000, every: 200 });
  await sleep(1000); // let the last events land
  await waitUntil(async () => {
    await Promise.allSettled(rec.pending);
    return rec.pending.size === 0;
  }, { timeout: 60000, every: 0 });
  flushRecorder(rec);
  await finalize(client, runDir, url, navigationError);
}
/**
 * Writes cookies, storage, rendered DOM, and manifest.json from the streamed requests.jsonl.
 * @param {ChromeClientInstance} client
 * @param {string} runDir
 * @param {string} requestedUrl
 * @param {string | null} navigationError
 * @returns {Promise<void>}
 */
async function finalize(client, runDir, requestedUrl, navigationError) {
  const root = client.cdp;
  /** @param {string} name @param {unknown} data */
  // note: an error page (chrome-error://) yields no value, so undefined is written as null, not thrown on.
  const write = (name, data) => fs.writeFileSync(path.join(runDir, name), typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2));

  const cookies = await root.send('Storage.getCookies').then((r) => r.cookies ?? []).catch((err) => ({ error: messageOf(err) }));
  write('cookies.json', cookies);
  const storage = await root.send('Runtime.evaluate', { expression: STORAGE_JS, returnByValue: true })
    .then((r) => /** @type {string | undefined} */ (r.result.value) ?? '{}')
    .catch((err) => JSON.stringify({ error: messageOf(err) }));
  write('storage.json', storage);
  const html = await root.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })
    .then((r) => /** @type {unknown} */ (r.result.value))
    .catch(() => null);
  if (typeof html === 'string') write('rendered.html', html);

  const requestsFile = path.join(runDir, 'requests.jsonl');
  /** @type {RequestRow[]} */
  const rows = fs.existsSync(requestsFile)
    ? fs.readFileSync(requestsFile, 'utf8').split('\n').filter(Boolean).map((l) => /** @type {RequestRow} */ (JSON.parse(l)))
    : [];
  /** @type {ManifestFile[]} */
  const files = rows.filter((r) => r.kind === 'response' && r.file).map((r) => ({
    url: r.url, method: r.method, status: r.status ?? undefined, resourceType: r.type, mimeType: r.mimeType,
    file: /** @type {string} */ (r.file), bytes: r.bytes, sha256: r.sha256, requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
    postData: r.postData, session: r.session,
  }));
  const failed = rows.filter((r) => (r.kind === 'response' && r.error) || r.kind === 'failed').map((r) => ({ url: r.url, error: r.error }));
  const redirects = rows.filter((r) => r.kind === 'redirect').length;
  /** @type {Manifest} */
  /** @type {Manifest} */
  const manifest = { pageUrl: client.url() || requestedUrl, requestedUrl, navigationError, files, failed, redirects };
  write('manifest.json', manifest);

  fs.rmSync(path.join(runDir, 'STOP'), { force: true });
  const active = path.join(path.dirname(path.dirname(runDir)), ACTIVE);
  if (fs.existsSync(active) && fs.readFileSync(active, 'utf8') === runDir) fs.rmSync(active);
}

/**
 * Unpacks each saved JS file with webcrack into `<stampDir>/unpacked`, one output file per input file.
 * @param {string} stampDir
 */
async function indexSite(stampDir) {
  const { webcrack } = require('webcrack');
  /** @type {Manifest} */
  const manifest = JSON.parse(fs.readFileSync(path.join(stampDir, 'manifest.json'), 'utf8'));
  const unpacked = path.join(stampDir, 'unpacked');
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });

  const jsFiles = manifest.files.filter((f) => /javascript/.test(f.mimeType || '') || /\.m?js$/.test(f.file));
  /** @type {Array<{ file: string, error: string }>} */
  const errors = [];
  // Files are independent: unpack them concurrently, and keep each file's failure with its name.
  const outcomes = await Promise.all(jsFiles.map(async (f) => {
    try {
      const src = fs.readFileSync(path.join(stampDir, f.file), 'utf8');
      const result = await webcrack(src, { unpack: true, deobfuscate: true, unminify: true });
      await result.save(path.join(unpacked, f.file));
      return null;
    } catch (err) {
      return { file: f.file, error: messageOf(err).slice(0, 160) };
    }
  }));
  for (const o of outcomes) if (o) errors.push(o);

  return { unpacked, jsFiles: jsFiles.length, errors };
}

module.exports = { recordSite, createRun, activeRun, indexSite };
