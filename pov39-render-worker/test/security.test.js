import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSourceUrl } from '../src/download.js';
import { newUploadKey, isUploadKey, isReadableKey, belongsTo } from '../src/keys.js';

const allow = ['media.base44.com'];

test('accepts allowlisted HTTPS source links', () => {
  assert.ok(checkSourceUrl('https://media.base44.com/files/private/abc?sig=1', allow));
});

test('rejects SSRF-style source links', () => {
  for (const url of [
    'http://media.base44.com/x',
    'https://evil.com/x',
    'https://media.base44.com.evil.com/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://user:pw@media.base44.com/x',
    'https://media.base44.com:8443/x',
    'file:///etc/passwd',
    'not a url',
  ]) {
    assert.throws(() => checkSourceUrl(url, allow), /source|valid|HTTPS|accept/i, url);
  }
});

test('an empty allowlist rejects everything', () => {
  assert.throws(() => checkSourceUrl('https://media.base44.com/x', []));
});

test('upload keys are scoped to one workspace and one safe shape', () => {
  const key = newUploadKey('ws_1', 'video/mp4');
  assert.match(key, /^uploads\/ws_1\/[0-9a-f-]{36}\/original\.mp4$/);
  assert.ok(isUploadKey(key));
  assert.ok(belongsTo(key, 'ws_1'));
  assert.equal(belongsTo(key, 'ws_2'), false);
  assert.equal(newUploadKey('ws_1', 'text/html'), null);
  assert.equal(newUploadKey('../x', 'video/mp4'), null);
  assert.equal(newUploadKey('ws_1', 'video/quicktime').endsWith('.mov'), true);
});

test('path tricks and foreign prefixes are not readable', () => {
  for (const key of ['sources/j/a', 'uploads/../renders/x/output.mp4', 'renders/a/../../b', '/etc/passwd', 'uploads/ws/x/original.mp4']) {
    assert.equal(isReadableKey(key), false, key);
  }
  assert.ok(isReadableKey('renders/job_1/output.mp4'));
});