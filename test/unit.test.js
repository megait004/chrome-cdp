'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const NetworkController = require('../src/network-controller');
const WorkerController = require('../src/worker-controller');
const SourceController = require('../src/source-controller');
const ConsoleController = require('../src/console-controller');

test('WorkerController tracks dedicated worker with raw CDP worker type and ignores unrelated other', async () => {
  const browserEmitter = new EventEmitter();
  const browserSession = {
    send: async () => ({}),
    detach: async () => {},
  };
  const mockTargets = [];
  const browser = Object.assign(browserEmitter, {
    target: () => ({
      createCDPSession: async () => browserSession,
    }),
    targets: () => mockTargets,
  });

  const controller = new WorkerController(browser);
  await controller.ready;

  function createMockTarget({ rawType, puppeteerType, targetId, url }) {
    const session = {
      send: async (method) => {
        if (method === 'Target.getTargetInfo') {
          return { targetInfo: { targetId, type: rawType } };
        }
        return {};
      },
      detach: async () => {},
    };
    return {
      type: () => puppeteerType,
      _getTargetInfo: () => ({ type: rawType, targetId }),
      url: () => url,
      createCDPSession: async () => session,
    };
  }

  // 1. Dedicated worker: Puppeteer reports 'other', CDP raw type is 'worker'
  const dedicatedWorker = createMockTarget({
    rawType: 'worker',
    puppeteerType: 'other',
    targetId: 'worker-target-1',
    url: 'https://example.com/worker.js',
  });
  browserEmitter.emit('targetcreated', dedicatedWorker);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(controller.list().length, 1);
  assert.deepEqual(controller.list()[0], {
    id: 'worker-target-1',
    type: 'worker',
    url: 'https://example.com/worker.js',
  });

  // 2. Unrelated Puppeteer 'other' target: CDP raw type is 'other'
  const unrelatedOther = createMockTarget({
    rawType: 'other',
    puppeteerType: 'other',
    targetId: 'other-target-2',
    url: 'https://example.com/other',
  });
  browserEmitter.emit('targetcreated', unrelatedOther);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(controller.list().length, 1, 'Unrelated "other" target should be ignored');

  // 3. Service worker: CDP raw type 'service_worker'
  const serviceWorker = createMockTarget({
    rawType: 'service_worker',
    puppeteerType: 'service_worker',
    targetId: 'sw-target-3',
    url: 'https://example.com/sw.js',
  });
  browserEmitter.emit('targetcreated', serviceWorker);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(controller.list().length, 2);
  const swItem = controller.list().find((w) => w.id === 'sw-target-3');
  assert.ok(swItem);
  assert.equal(swItem.type, 'service_worker');

  // 4. Shared worker: CDP raw type 'shared_worker'
  const sharedWorker = createMockTarget({
    rawType: 'shared_worker',
    puppeteerType: 'shared_worker',
    targetId: 'shared-target-4',
    url: 'https://example.com/shared.js',
  });
  browserEmitter.emit('targetcreated', sharedWorker);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(controller.list().length, 3);
  const sharedItem = controller.list().find((w) => w.id === 'shared-target-4');
  assert.ok(sharedItem);
  assert.equal(sharedItem.type, 'shared_worker');

  controller.close();
});

test('SourceController enable sends both Debugger.enable and Runtime.enable; disable omits Runtime.disable', async () => {
  const sentMethods = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method) => {
    sentMethods.push(method);
    return {};
  };

  const sources = new SourceController(cdpSession);

  await sources.enable();
  assert.ok(sentMethods.includes('Debugger.enable'), 'enable must send Debugger.enable');
  assert.ok(sentMethods.includes('Runtime.enable'), 'enable must send Runtime.enable');

  sentMethods.length = 0;
  await sources.disable();
  assert.ok(sentMethods.includes('Debugger.disable'), 'disable must send Debugger.disable');
  assert.ok(!sentMethods.includes('Runtime.disable'), 'disable must NOT send Runtime.disable');
});

test('ConsoleController inspectObject handles float expression 1.2 as primitive and real 3-segment IDs directly', async () => {
  const sentCommands = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method, params) => {
    sentCommands.push({ method, params });
    if (method === 'Runtime.evaluate') {
      if (params.expression === '1.2') {
        return { result: { type: 'number', value: 1.2, description: '1.2' } };
      }
      return { result: { objectId: '99999.1.1' } };
    }
    if (method === 'Runtime.getProperties') {
      return {
        result: [
          { name: 'val', value: { type: 'string', value: 'hello' }, writable: true },
        ],
      };
    }
    return {};
  };

  const mockPage = {};
  const consoleController = new ConsoleController(mockPage, cdpSession);

  // 1. inspectObject('1.2') should evaluate as expression and return primitive preview
  sentCommands.length = 0;
  const floatResult = await consoleController.inspectObject('1.2');
  assert.deepEqual(floatResult, [
    {
      name: '(primitive)',
      value: 1.2,
      type: 'number',
      isGetter: false,
      isSetter: false,
    },
  ]);
  assert.equal(sentCommands[0].method, 'Runtime.evaluate');
  assert.equal(sentCommands[0].params.expression, '1.2');

  // 2. inspectObject with negative 3-segment Chrome ID should directly call Runtime.getProperties
  sentCommands.length = 0;
  const negIdResult = await consoleController.inspectObject('-4225222387882249596.1.1');
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, 'Runtime.getProperties');
  assert.equal(sentCommands[0].params.objectId, '-4225222387882249596.1.1');
  assert.equal(negIdResult[0].name, 'val');
  assert.equal(negIdResult[0].value, 'hello');

  // 3. inspectObject with positive 3-segment Chrome ID should directly call Runtime.getProperties
  sentCommands.length = 0;
  const posIdResult = await consoleController.inspectObject('7383723597292307119.1.1');
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, 'Runtime.getProperties');
  assert.equal(sentCommands[0].params.objectId, '7383723597292307119.1.1');
  assert.equal(posIdResult[0].name, 'val');
});

test('searchBodies honors case sensitivity per query kind (native search unavailable → local fallback)', async () => {
  const EventEmitter2 = require('node:events');
  const cdp = new EventEmitter2();
  // Force the local fallback path: no native Network.searchInResponseBody.
  cdp.send = async (method, params) => {
    if (method === 'Network.searchInResponseBody') throw new Error('not available');
    if (method === 'Network.getResponseBody') return { body: 'Token=SECRET\ntoken=secret', base64Encoded: false };
    return {};
  };
  const net = new NetworkController({}, cdp);
  await net.startRecording();
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: { url: 'https://example.test/x', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 1,
  });
  cdp.emit('Network.responseReceived', {
    requestId: 'R1', timestamp: 2, response: { status: 200, statusText: 'OK', headers: {} },
  });

  // Plain string → case-insensitive substring: matches both lines.
  assert.equal((await net.searchBodies('secret'))[0].matchLineNumbers.length, 2);
  // RegExp without i → case-sensitive: only the SECRET line.
  assert.deepEqual((await net.searchBodies(/SECRET/))[0].matchLineNumbers, [0]);
  // /.../flags string with i → case-insensitive: both lines.
  assert.equal((await net.searchBodies('/SECRET/i'))[0].matchLineNumbers.length, 2);
  // /.../flags string without i → case-sensitive: only line 0.
  assert.deepEqual((await net.searchBodies('/secret/'))[0].matchLineNumbers, [1]);
});

test('NetworkController keeps the pre-redirect hop instead of overwriting it', async () => {
  const EventEmitter2 = require('node:events');

  const cdp = new EventEmitter2();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: {
      url: 'https://example.test/authenticate',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'username=tomsmith&password=hunter2',
    },
    type: 'Document',
    timestamp: 1,
  });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R1',
    request: { url: 'https://example.test/secure', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 2,
    redirectResponse: {
      url: 'https://example.test/authenticate',
      status: 303,
      statusText: 'See Other',
      headers: { location: '/secure', 'set-cookie': 'session=abc; HttpOnly' },
    },
  });
  cdp.emit('Network.responseReceived', {
    requestId: 'R1',
    timestamp: 3,
    response: { status: 200, statusText: 'OK', headers: {} },
  });

  const posts = net.getTraffic({ method: 'POST' });
  assert.equal(posts.length, 1, 'the POST must survive the redirect');
  assert.equal(posts[0].url, 'https://example.test/authenticate');
  assert.equal(posts[0].status, 303, 'the redirect status belongs to the POST, not the GET');
  assert.equal(posts[0].postData, 'username=tomsmith&password=hunter2');
  assert.equal(posts[0].responseHeaders['set-cookie'], 'session=abc; HttpOnly');
  assert.equal(posts[0].redirectedTo, 'https://example.test/secure');
  assert.equal(posts[0].cdpRequestId, 'R1', 'CDP calls still address the real request');

  const final = net.getTraffic({ method: 'GET' });
  assert.equal(final.length, 1);
  assert.equal(final[0].status, 200);
  assert.equal(final[0].redirectedFrom, 'https://example.test/authenticate');
  assert.equal(net.getTraffic().length, 2, 'both hops are addressable');

  const raw = await net.toRawRequest(posts[0].id);
  assert.match(raw, /^POST \/authenticate HTTP\/1\.1/);
  assert.match(raw, /username=tomsmith/);
});

test('waitUntil returns as soon as the value is ready instead of burning the whole timeout', async () => {
  const { waitUntil } = require('../src/waiting');

  let polls = 0;
  const started = Date.now();
  const frames = await waitUntil(() => (++polls >= 3 ? ['a', 'b'] : []), { every: 10, timeout: 5000 });

  assert.deepEqual(frames, ['a', 'b']);
  assert.equal(polls, 3);
  assert.ok(Date.now() - started < 1000, 'succeed fast: must not wait out the timeout');
});

test('waitUntil synchronizes rather than claims, so a timeout yields the partial capture', async () => {
  const { waitUntil } = require('../src/waiting');

  const partial = await waitUntil(() => ['only-one'], { min: 5, every: 10, timeout: 60 });
  assert.deepEqual(partial, ['only-one'], 'seven frames are still seven frames');
});

test('assertEventually throws a diagnostic instead of letting a failed wait read as absence', async () => {
  const { assertEventually } = require('../src/waiting');

  await assert.rejects(
    () => assertEventually(() => [], { every: 10, timeout: 60, describe: 'a server PING frame' }),
    (err) => {
      assert.match(err.message, /a server PING frame never became true within 60ms/);
      assert.match(err.message, /last value: length 0/);
      assert.match(err.message, /not observed/, 'the message must warn against misreporting');
      return true;
    },
  );

  const value = await assertEventually(() => ['here'], { every: 10, timeout: 60 });
  assert.deepEqual(value, ['here']);
});

test('assertEventually reports the shortfall when min is not reached', async () => {
  const { assertEventually } = require('../src/waiting');

  await assert.rejects(
    () => assertEventually(() => [1, 2], { min: 10, every: 10, timeout: 60, describe: '10 frames' }),
    /last value: length 2, needed at least 10/,
  );
});

test('waitForEvent listens and resolves on the event itself, filtered by where', async () => {
  const { waitForEvent } = require('../src/waiting');
  const EventEmitter3 = require('node:events');

  const websocket = new EventEmitter3();
  const pending = waitForEvent(websocket, 'frame', {
    count: 2,
    timeout: 5000,
    where: (f) => f.direction === 'received',
  });

  websocket.emit('frame', { direction: 'sent', payloadData: 'subscribe' });
  websocket.emit('frame', { direction: 'received', payloadData: 'ack' });
  websocket.emit('frame', { direction: 'sent', payloadData: 'ping' });
  websocket.emit('frame', { direction: 'received', payloadData: 'trade' });

  const frames = await pending;
  assert.deepEqual(frames.map((f) => f.payloadData), ['ack', 'trade']);
  assert.equal(websocket.listenerCount('frame'), 0, 'must not leak its listener');
});

test('waitForEvent returns the partial collection on timeout and still unsubscribes', async () => {
  const { waitForEvent } = require('../src/waiting');
  const EventEmitter4 = require('node:events');

  const websocket = new EventEmitter4();
  const pending = waitForEvent(websocket, 'frame', { count: 5, timeout: 50 });
  websocket.emit('frame', { payloadData: 'one' });

  const frames = await pending;
  assert.equal(frames.length, 1);
  assert.equal(websocket.listenerCount('frame'), 0);
});

test('inspectObject keeps ownProperties defaulting to true when given an options object without it', async () => {
  const sent = [];
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method, params) => {
    sent.push({ method, params });
    return { result: [] };
  };
  const controller = new ConsoleController({}, cdpSession);

  await controller.inspectObject('1.1.1', {});
  assert.equal(sent.at(-1).params.ownProperties, true, 'empty options must not drop the default');

  await controller.inspectObject('1.1.1', { generatePreview: true });
  assert.equal(sent.at(-1).params.ownProperties, true, 'an unrelated key must not drop the default');

  await controller.inspectObject('1.1.1');
  assert.equal(sent.at(-1).params.ownProperties, true, 'omitting options keeps the default');

  await controller.inspectObject('1.1.1', { ownProperties: false });
  assert.equal(sent.at(-1).params.ownProperties, false, 'an explicit false is still honoured');
});

test('setBreakpoint rejects a condition passed into the columnNumber slot', async () => {
  const DebugController = require('../src/debug-controller');
  const EventEmitter5 = require('node:events');

  const cdp = new EventEmitter5();
  const sent = [];
  cdp.send = async (method, params) => {
    sent.push({ method, params });
    return { breakpointId: 'bp-1' };
  };
  const debugCtl = new DebugController(cdp);

  await assert.rejects(
    () => debugCtl.setBreakpoint('https://x.test/app.js', 120, 'price > 5'),
    (err) => {
      assert.match(err.message, /columnNumber must be a number, got string/);
      assert.match(err.message, /setBreakpoint\(url, line, 0, condition\)/);
      return true;
    },
  );
  assert.equal(sent.length, 0, 'nothing should reach Chrome');

  const ok = await debugCtl.setBreakpoint('https://x.test/app.js', 120, 0, 'price > 5');
  assert.equal(ok.breakpointId, 'bp-1');
  assert.deepEqual(sent.at(-1).params, {
    url: 'https://x.test/app.js',
    lineNumber: 120,
    columnNumber: 0,
    condition: 'price > 5',
  });

  await debugCtl.setBreakpoint('https://x.test/app.js', 7);
  assert.equal(sent.at(-1).params.columnNumber, 0, 'the default still applies');
});

test('removeBreakpoint untracks on success (keeps id on failure); disable resets pause state', async () => {
  const DebugController = require('../src/debug-controller');
  const EventEmitter7 = require('node:events');
  const cdp = new EventEmitter7();
  const sent = [];
  let failRemove = false;
  cdp.send = async (method, params) => {
    sent.push({ method, params });
    if (method === 'Debugger.removeBreakpoint' && failRemove) throw new Error('nope');
    if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'bp-9', locations: [] };
    return {};
  };
  const debugCtl = new DebugController(cdp);
  await debugCtl.enable();
  await debugCtl.setBreakpoint('https://x.test/app.js', 3);
  await debugCtl.removeBreakpoint('bp-9');
  const n = sent.length;
  debugCtl.disable();
  await new Promise((r) => setTimeout(r, 20)); // flush fire-and-forget sends
  const after = sent.slice(n);
  assert.ok(!after.some((s) => s.method === 'Debugger.removeBreakpoint'), 'stale re-remove sent for an already-removed id');
  assert.ok(after.some((s) => s.method === 'Debugger.setPauseOnExceptions' && s.params.state === 'none'), 'disable must reset pause state');

  // failure path: the id stays tracked so disable() retries the removal
  await debugCtl.enable();
  await debugCtl.setBreakpoint('https://x.test/app.js', 4);
  failRemove = true;
  await assert.rejects(() => debugCtl.removeBreakpoint('bp-9'));
  const m = sent.length;
  debugCtl.disable();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sent.slice(m).some((s) => s.method === 'Debugger.removeBreakpoint'), 'failed id not retried on disable');
});

test('pauseOnExceptions state is re-asserted after navigation and forgotten on disable', async () => {
  const DebugController = require('../src/debug-controller');
  const EventEmitter8 = require('node:events');
  const cdp = new EventEmitter8();
  const sent = [];
  cdp.send = async (method, params) => { sent.push({ method, params }); return {}; };
  const debugCtl = new DebugController(cdp);
  await debugCtl.enable({ pauseOnExceptions: 'uncaught' });
  assert.equal(sent.filter((s) => s.method === 'Debugger.setPauseOnExceptions').length, 1, 'initial send missing');
  cdp.emit('Runtime.executionContextsCleared'); // navigation wipes backend state on some stacks
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.at(-1), { method: 'Debugger.setPauseOnExceptions', params: { state: 'uncaught' } }, 'no re-assert after navigation');
  debugCtl.disable();
  const n = sent.length;
  cdp.emit('Runtime.executionContextsCleared');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, n, 're-assert fired after disable');
});

test('getResponseBody refuses a redirect hop instead of returning the final response body', async () => {
  const NetworkController = require('../src/network-controller');
  const EventEmitter6 = require('node:events');

  const cdp = new EventEmitter6();
  cdp.send = async () => ({ body: '<html>SECURE AREA</html>', base64Encoded: false });
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R9',
    request: { url: 'https://example.test/authenticate', method: 'POST', headers: {}, postData: 'u=a' },
    type: 'Document',
    timestamp: 1,
  });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'R9',
    request: { url: 'https://example.test/secure', method: 'GET', headers: {} },
    type: 'Document',
    timestamp: 2,
    redirectResponse: { url: 'https://example.test/authenticate', status: 303, statusText: 'See Other', headers: {} },
  });

  const [hop] = net.getTraffic({ method: 'POST' });
  await assert.rejects(
    () => net.getResponseBody(hop.id),
    (err) => {
      assert.match(err.message, /No response body for redirect hop R9:redirect:0 \(303 to https:\/\/example\.test\/secure\)/);
      assert.match(err.message, /request id R9/);
      return true;
    },
  );

  const final = await net.getResponseBody('R9');
  assert.equal(final.body, '<html>SECURE AREA</html>');
});

test('waitForEvent rejects when the where predicate throws instead of hanging', async () => {
  const { waitForEvent } = require('../src/waiting');
  const EventEmitter7 = require('node:events');

  const websocket = new EventEmitter7();
  const pending = waitForEvent(websocket, 'frame', {
    timeout: 5000,
    where: () => { throw new Error('predicate blew up'); },
  });

  assert.doesNotThrow(() => websocket.emit('frame', { payloadData: 'x' }));
  await assert.rejects(() => pending, /predicate blew up/);
  assert.equal(websocket.listenerCount('frame'), 0, 'must unsubscribe on the error path too');
});

test('global-flag filters survive a stateful /g regex instead of skipping every other entry', async () => {
  const WebSocketController = require('../src/websocket-controller');
  const SourceController = require('../src/source-controller');
  const EventEmitter2 = require('node:events');

  const wsCdp = new EventEmitter2();
  wsCdp.send = async () => ({});
  const ws = new WebSocketController(wsCdp);
  await ws.startRecording();
  for (const id of ['S1', 'S2', 'S3']) {
    wsCdp.emit('Network.webSocketCreated', { requestId: id, url: `wss://live.test/${id}` });
  }
  assert.equal(ws.getSockets({ url: /live\.test/g }).length, 3, 'lastIndex must not leak between sockets');

  const srcCdp = new EventEmitter2();
  srcCdp.send = async () => ({});
  const sources = new SourceController(srcCdp);
  await sources.enable();
  for (const id of ['1', '2', '3']) {
    srcCdp.emit('Debugger.scriptParsed', { scriptId: id, url: `https://cdn.test/app.${id}.js` });
  }
  assert.equal(sources.getScripts({ url: /cdn\.test/g }).length, 3, 'lastIndex must not leak between scripts');
});

test('durationMs stays in the CDP timebase when a request is seen mid-flight', async () => {
  const NetworkController = require('../src/network-controller');
  const EventEmitter2 = require('node:events');

  const cdp = new EventEmitter2();
  cdp.send = async () => ({});
  const net = new NetworkController({}, cdp);
  await net.startRecording();

  // Recording started after requestWillBeSent, so only the response is ever seen.
  cdp.emit('Network.responseReceived', {
    requestId: 'R9',
    timestamp: 42,
    response: { status: 200, statusText: 'OK', headers: {} },
  });

  const [entry] = net.getTraffic();
  assert.equal(entry.startTime, null, 'no epoch clock may be mixed into the CDP timebase');
  assert.equal(entry.durationMs, null, 'an unknown start must read as unknown, not as a negative age');
});
