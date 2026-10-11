import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const options = { skip: !existsSync(resolve(host, 'chess/session.js')) && 'Set ITO_HOST_ROOT to test integrated chess' };
const message = '线上象棋服务尚未配置，请联系管理员更新版本';

function harness(config = { development: true, apiBase: 'http://127.0.0.1:8787' }, envVersion = 'release', platform = 'ios') {
  const cache = new Map(), requests = [], sockets = [], statuses = [], timers = [], definitions = new Map();
  const user = { id: 'saved-user', name: '已登录棋友' };
  const storage = new Map([
    ['gougeSession', { token: 'cached-token', user, ...config }],
    ['gougeLastGame', { gameId: 'saved-game', userId: user.id }],
    ['itoSettings', { marker: 'host-unchanged' }]
  ]);
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }), getDeviceInfo: () => ({ platform }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { user } }); },
    connectSocket(options) {
      sockets.push(options);
      return { onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} };
    }
  };
  function load(file) {
    file = resolve(host, file); if (!extname(file)) file += '.js';
    if (file === resolve(host, 'chess/config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, wx, console,
      require: name => load(resolve(dirname(file), name)), Page: definition => definitions.set(file, definition),
      setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() {}, clearInterval() {}
    }, { filename: file });
    return module.exports;
  }
  function home() {
    const file = resolve(host, 'chess/pages/index/index.js'); load(file);
    const definition = definitions.get(file);
    return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  }
  return { wx, config, load, home, requests, sockets, statuses, timers, storage };
}

test('real API request seam rejects invalid trial/release configuration before any wx.request', options, async () => {
  for (const env of ['trial', 'release']) for (const config of [
    { development: true, apiBase: 'http://127.0.0.1:8787' },
    { development: true, apiBase: 'https://chess.example.com' },
    { development: false, apiBase: 'http://chess.example.com' },
    { development: false, apiBase: 'https://localhost' },
    { development: false, apiBase: 'https://127.0.0.1' },
    { development: false, apiBase: 'https://192.168.1.5' },
    { development: false, apiBase: 'https://[::1]' }
  ]) {
    const h = harness(config, env), before = structuredClone([...h.storage]);
    await assert.rejects(h.load('chess/services/api.js').request('/api/me'), error => error.message === message);
    assert.equal(h.requests.length, 0); assert.deepEqual([...h.storage], before);
  }
});

test('public HTTPS with real login mode is allowed for both trial and release', options, async () => {
  for (const env of ['trial', 'release']) {
    const h = harness({ development: false, apiBase: 'https://chess.example.com' }, env);
    await h.load('chess/services/api.js').request('/api/me');
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].header.Authorization, 'Bearer cached-token');
  }
});

test('develop phones block loopback while same-network LAN and DevTools local requests remain available', options, async () => {
  for (const platform of ['ios', 'android']) for (const apiBase of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const h = harness({ development: true, apiBase }, 'develop', platform);
    await assert.rejects(h.load('chess/services/api.js').request('/api/me'), error => error.message === message);
    assert.equal(h.requests.length, 0);
  }
  for (const [apiBase, platform] of [['http://192.168.1.5:8787', 'ios'], ['http://10.0.0.7:8787', 'android'], ['http://127.0.0.1:8787', 'devtools']]) {
    const h = harness({ development: true, apiBase }, 'develop', platform);
    await h.load('chess/services/api.js').request('/api/me'); assert.equal(h.requests.length, 1);
  }
  const oldMock = harness(); delete oldMock.wx.getAccountInfoSync;
  await oldMock.load('chess/services/api.js').request('/api/me'); assert.equal(oldMock.requests.length, 1);
});

test('cached tokens cannot trigger websocket connections or reconnect timers when deployment is invalid', options, () => {
  for (const [env, platform] of [['trial', 'devtools'], ['release', 'ios'], ['develop', 'android']]) {
    const h = harness(undefined, env, platform), GameSocket = h.load('chess/services/socket.js');
    const socket = new GameSocket({ onStatus: status => h.statuses.push(status), onMessage() {} });
    socket.start(); socket.connect();
    assert.equal(h.sockets.length, 0); assert.equal(h.timers.length, 0); assert.equal(socket.stopped, true);
    assert.deepEqual(h.statuses, [message]);
  }
  const valid = harness({ development: false, apiBase: 'https://chess.example.com' });
  const GameSocket = valid.load('chess/services/socket.js');
  new GameSocket({ onStatus() {}, onMessage() {} }).start();
  assert.equal(valid.sockets.length, 1); assert.ok(valid.sockets[0].url.startsWith('wss://chess.example.com/ws?token='));
});

test('chess home shows the deployment message and skips cached game refresh without changing host or chess storage', options, async () => {
  const h = harness(), before = structuredClone([...h.storage]), page = h.home();
  await page.onShow();
  assert.equal(page.data.error, message); assert.equal(h.requests.length, 0);
  assert.deepEqual([...h.storage], before);
});

test('releaseErrors is a pure shared configuration check with no wx calls', options, () => {
  const h = harness(), { releaseErrors } = h.load('chess/services/deployment.js');
  h.wx.getAccountInfoSync = () => { throw new Error('Pure checker must not access wx'); };
  assert.deepEqual(Array.from(releaseErrors({ development: false, apiBase: 'https://chess.example.com' })), []);
  assert.equal(releaseErrors({ development: true, apiBase: 'http://127.0.0.1:8787' }).length, 2);
  for (const apiBase of ['', 'https://api.localhost', 'https://[2001:db8::1]', 'https://2130706433', 'https://user:pass@chess.example.com', 'https://chess.example.com invalid']) {
    assert.ok(releaseErrors({ development: false, apiBase }).length > 0, apiBase);
  }
});
