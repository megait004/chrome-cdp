'use strict';

// Pure helpers only: no Chrome needed, so this runs in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { expandEquals, redactRawText, redactHeaders, slimEntry, isHttpUrl } = require('../cli');

test('expandEquals turns --flag=value into two tokens and leaves the rest alone', () => {
  assert.deepEqual(expandEquals(['--wait=5', 'x', '--a=b=c']), ['--wait', '5', 'x', '--a', 'b=c']);
  assert.deepEqual(expandEquals(['--out', 'f.json']), ['--out', 'f.json']);
  assert.deepEqual(expandEquals(['--canvas', 'click-at', '1', '2']), ['--canvas', 'click-at', '1', '2']);
});

test('isHttpUrl accepts navigable schemes and rejects selectors', () => {
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('http://example.com'), true);
  assert.equal(isHttpUrl('data:text/html,<h1>x</h1>'), true);
  assert.equal(isHttpUrl('file:///tmp/x.html'), true);
  assert.equal(isHttpUrl('#main'), false);
  assert.equal(isHttpUrl('button.submit'), false);
  assert.equal(isHttpUrl(undefined), false);
});

test('redactRawText masks credential headers and keeps the rest', () => {
  const raw = ['GET / HTTP/3', 'cookie: a=1; b=2', 'authorization: Bearer t', 'accept: */*'].join('\r\n');
  const out = redactRawText(raw);
  assert.match(out, /cookie: \[REDACTED\]/);
  assert.match(out, /authorization: \[REDACTED\]/);
  assert.match(out, /accept: \*\/\*/);
  assert.doesNotMatch(out, /a=1/);
});

test('redactHeaders leaves a null header map alone and redacts by name, not by value', () => {
  assert.equal(redactHeaders(null), null);
  const out = redactHeaders({ Cookie: 'x=1', 'X-Api-Key': 'k', Accept: '*/*' });
  assert.deepEqual(out, { Cookie: '[REDACTED]', 'X-Api-Key': '[REDACTED]', Accept: '*/*' });
});

test('slimEntry drops raw header maps and keeps what identifies the request', () => {
  const entry = {
    id: '1', url: 'https://x/y', method: 'POST', status: 200, resourceType: 'XHR', mimeType: 'application/json',
    headers: { Cookie: 'a=1', Accept: '*/*' }, rawHeaders: { Cookie: 'a=1' }, responseHeaders: { 'Set-Cookie': 'b=2' },
    rawResponseHeaders: { 'Set-Cookie': 'b=2' }, rawResponseHeadersText: 'HTTP/1.1 200 OK', initiator: { type: 'other' },
    postData: '{"q":1}', encodedDataLength: 10, failed: false, redirectIndex: 0,
  };
  const out = slimEntry(entry, true);
  assert.equal(out.id, '1');
  assert.equal(out.status, 200);
  assert.equal(out.postData, '{"q":1}');
  assert.deepEqual(out.headers, { Cookie: '[REDACTED]', Accept: '*/*' });
  assert.equal('rawHeaders' in out, false);
  assert.equal('rawResponseHeaders' in out, false);
  assert.equal('initiator' in out, false);
});

test('the CLI answers --version without loading Chrome', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, '..', 'cli.js');
  const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
