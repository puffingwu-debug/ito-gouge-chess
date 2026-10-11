import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/wechat-cloud-smoke.fn.js', import.meta.url), 'utf8');
const args = { env: 'gouge-chess-d1gubfb4x25bc5571', service: 'gouge-chess' };
function fixture(overrides = {}) {
  const requests = [], calls = [], app = { globalData: { itoTools: 'unchanged' } };
  let onMessage, onClose;
  const socket = { closed: false,
    onOpen(fn) { queueMicrotask(fn); }, onMessage(fn) { onMessage = fn; }, onClose(fn) { onClose = fn; }, onError() {},
    send(options) { calls.push(JSON.parse(options.data)); onMessage({ data: JSON.stringify({ type: 'lobby', tables: Array(6).fill({}) }) }); onMessage({ data: JSON.stringify({ type: 'pong', serverNow: Date.now() }) }); },
    close() { this.closed = true; onClose(); }
  };
  const health = { ok: true, devMode: false, wechatConfigured: true, storage: { kind: 'cloudbase', healthy: true }, voiceConfigured: false, deepseekConfigured: false };
  const wx = { getDeviceInfo: () => ({ platform: 'devtools' }),
    login(options) { calls.push('wx.login'); options.success({ code: 'sensitive-login-code' }); },
    setStorageSync() { throw new Error('Smoke must not change client storage'); },
    cloud: { init(options) { calls.push({ init: options }); },
      callContainer(options) { requests.push(options); return Promise.resolve({ statusCode: 200,
        data: options.path === '/api/health' ? health : options.path === '/api/login/wechat' ? { token: 'sensitive-app-token', user: { id: 'actual-user' } } : { user: { id: 'actual-user' } } }); },
      connectContainer(options) { calls.push({ connection: options }); return Promise.resolve({ socketTask: socket }); }
    }
  };
  if (overrides.health) Object.assign(health, overrides.health);
  if (overrides.request) wx.cloud.callContainer = overrides.request;
  if (overrides.connect) wx.cloud.connectContainer = overrides.connect;
  const run = payload => vm.runInNewContext(source + '\ncloudSmoke(arg)', { wx, arg: payload, getApp: () => app, setTimeout, clearTimeout });
  return { wx, calls, requests, socket, run };
}

test('native cloud smoke fixture checks health, real-login seam, bearer identity and container ping without returning credentials or changing the host', async () => {
  const f = fixture(), report = await f.run(args);
  assert.equal(report.ok, true); assert.equal(report.hostAppUnchanged, true); assert.equal(report.physicalDevice, false);
  assert.equal(Object.values(report.checks).every(Boolean), true);
  assert.equal(f.requests[1].path, '/api/login/wechat'); assert.equal(f.requests[1].data.code, 'sensitive-login-code');
  assert.equal(f.requests[2].header.Authorization, 'Bearer sensitive-app-token');
  assert.equal(f.calls.find(call => call.connection).connection.path, '/ws?token=sensitive-app-token');
  assert.deepEqual(f.calls.filter(call => call.type), [{ type: 'ping' }]); assert.equal(f.socket.closed, true);
  assert.doesNotMatch(JSON.stringify(report), /sensitive|actual-user/);
});

test('native cloud smoke refuses an unhealthy or development backend before login and websocket', async () => {
  for (const health of [{ devMode: true }, { ok: false }, { storage: { kind: 'local-json', healthy: true } }]) {
    const f = fixture({ health }), report = await f.run(args);
    assert.equal(report.ok, false); assert.equal(report.failedStage, 'health'); assert.equal(report.errorCode, 'HEALTH_NOT_READY');
    assert.equal(f.calls.includes('wx.login'), false); assert.equal(f.calls.some(call => call.connection), false);
  }
});

test('native cloud smoke reports transport failure without leaking raw SDK errors or using an HTTP fallback', async () => {
  const f = fixture({ request: () => Promise.reject(new Error('private sensitive-app-token request URL')) });
  const report = await f.run(args);
  assert.equal(report.ok, false); assert.equal(report.failedStage, 'health'); assert.equal(report.errorCode, 'SDK_FAILURE');
  assert.doesNotMatch(JSON.stringify(report), /private|sensitive/);
  const invalid = fixture(), invalidReport = await invalid.run({ env: args.env });
  assert.equal(invalidReport.errorCode, 'CLOUD_CONFIG_REQUIRED'); assert.equal(invalid.calls.length, 0);
});

test('native cloud smoke retains the SDK numeric errCode without exposing login codes, tokens or headers', async () => {
  const f = fixture({ request: () => Promise.reject({ errCode: 85088, errMsg: 'system error sensitive-login-code',
    token: 'sensitive-app-token', header: { Authorization: 'Bearer sensitive-app-token' } }) });
  const report = await f.run(args);
  assert.equal(report.ok, false); assert.equal(report.failedStage, 'health'); assert.equal(report.errCode, 85088);
  assert.equal(report.errorCode, 'SDK_FAILURE'); assert.doesNotMatch(JSON.stringify(report), /sensitive|Authorization|Bearer|header|errMsg/);
  const malformed = fixture({ request: () => Promise.reject({ errCode: 'sensitive-login-code' }) });
  assert.equal((await malformed.run(args)).errCode, undefined);
});
