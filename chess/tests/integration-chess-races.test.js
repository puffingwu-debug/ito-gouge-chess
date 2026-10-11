import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const options = { skip: !existsSync(resolve(host, 'chess/session.js')) && 'Set ITO_HOST_ROOT to test integrated chess' };
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const config = { apiBase: 'http://127.0.0.1:8787', development: true };
  const user = { id: 'me', name: '棋友' };
  const storage = new Map([['gougeSession', { token: 'token-1', user, ...config }], ['itoSettings', { unchanged: true }]]);
  const requests = [], navigation = [], sockets = [], definitions = new Map(), cache = new Map(), pages = [];
  const delayed = new Set();
  const game = { id: 'game-1', tableId: 1, mode: 'pvp', status: 'active', version: 1, turnId: 'turn-1', ownerId: 'me',
    board: Array(90).fill(null), history: [], legalMoves: [], turn: 'red', seats: { red: user, black: { id: 'other', name: '家人' } },
    ready: { red: false, black: false }, spectators: [], serverNow: Date.now(), undo: null, draw: null,
    timeControl: { mode: 'rapid', rapidSeconds: 15 },
    clock: { deadline: Date.now() + 15000, red: { usedMs: 0, phase: 'rapid' }, black: { usedMs: 0, phase: 'rapid' } } };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 753 }),
    navigateTo: ({ url }) => navigation.push(url), redirectTo: ({ url }) => navigation.push(url), reLaunch: ({ url }) => navigation.push(url),
    showToast() {}, showModal: options => options.success({ confirm: false }),
    requirePrivacyAuthorize: options => options.success({ errMsg: 'requirePrivacyAuthorize:ok' }),
    onVoIPChatMembersChanged() {}, offVoIPChatMembersChanged() {}, onVoIPChatInterrupted() {}, offVoIPChatInterrupted() {},
    request(request) {
      request.path = new URL(request.url).pathname;
      requests.push(request);
      if (delayed.has(request.path)) return;
      const data = request.path === '/api/me' ? { user } : request.path === '/api/lobby' ? { tables: [] } :
        request.path.startsWith('/api/games/') ? { game } : { ok: true };
      request.success({ statusCode: 200, data });
    },
    connectSocket() {
      const socket = { onOpen() {}, onMessage() {}, onClose() {}, onError() {}, send() {}, close() { this.closed = true; } };
      sockets.push(socket); return socket;
    }
  };
  function load(file) {
    file = resolve(host, file); if (!extname(file)) file += '.js';
    if (file === resolve(host, 'chess/config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, wx, console, Date,
      Page: definition => definitions.set(file, definition), getCurrentPages: () => pages,
      getApp() { throw new Error('Chess must not access ITO App'); },
      require: name => load(resolve(dirname(file), name)),
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
    }, { filename: file });
    return module.exports;
  }
  function page(name) {
    const file = resolve(host, 'chess/pages', name, 'index.js'); load(file);
    const definition = definitions.get(file);
    const instance = { ...definition, route: 'chess/pages/' + name + '/index', data: structuredClone(definition.data),
      setData(patch) { Object.assign(this.data, patch); } };
    pages.push(instance); return instance;
  }
  const app = load('chess/session.js').getChessApp();
  function changeSession() { app.globalData.token = 'token-2'; app.globalData.user = { id: 'new-user', name: '新棋友' }; app.saveSession(); }
  async function gamePage(name, waiting = false) {
    if (waiting) game.status = 'waiting';
    const instance = page(name);
    await instance.onLoad(name === 'game' ? { id: game.id } : { gameId: game.id });
    instance.visible = true;
    if (name === 'game') instance.render(game); else instance.renderGame(game);
    return instance;
  }
  function reply(path, data, statusCode = 200, index = 0) {
    const request = requests.filter(request => request.path === path)[index];
    assert.ok(request, 'Request must have started: ' + path); request.success({ statusCode, data });
  }
  return { app, config, user, storage, requests, navigation, sockets, delayed, game, wx, page, gamePage, load, reply, changeSession };
}

test('clearSession invalidates pending login and the newest started login owns the session', options, async () => {
  const h = harness(); h.delayed.add('/api/login/dev');
  const old = h.app.login('旧登录'); const oldResult = assert.rejects(old, /登录/);
  h.app.clearSession(); h.reply('/api/login/dev', { token: 'late', user: h.user }); await oldResult;
  assert.equal(h.storage.has('gougeSession'), false); assert.equal(h.app.globalData.user, null);
  const first = h.app.login('先开始'); const firstResult = assert.rejects(first, /登录/);
  const second = h.app.login('后开始');
  h.reply('/api/login/dev', { token: 'latest', user: { id: 'latest', name: '后开始' } }, 200, 2); await second;
  h.reply('/api/login/dev', { token: 'obsolete', user: h.user }, 200, 1); await firstResult;
  assert.equal(h.storage.get('gougeSession').token, 'latest'); assert.equal(h.app.globalData.user.id, 'latest');
});

test('401 clears only the current authenticated request session', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'); h.delayed.add('/api/me');
  const stale = assert.rejects(api.request('/api/me'), error => error.status === 401);
  h.changeSession(); h.reply('/api/me', { error: '旧会话过期' }, 401); await stale;
  assert.equal(h.app.globalData.token, 'token-2');
  const anonymous = assert.rejects(api.request('/api/me', 'GET', undefined, false), error => error.status === 401);
  h.reply('/api/me', { error: '未认证' }, 401, 1); await anonymous; assert.equal(h.app.globalData.token, 'token-2');
  const current = assert.rejects(api.request('/api/me'), error => error.status === 401);
  h.reply('/api/me', { error: '当前会话过期' }, 401, 2); await current;
  assert.equal(h.app.globalData.user, null); assert.equal(h.storage.has('gougeSession'), false);
});

test('concurrent ensureLogin shares its request and cancelled wx.login does not start a server login', options, async () => {
  const h = harness(); h.app.clearSession(); h.delayed.add('/api/login/dev');
  const first = h.app.ensureLogin(), second = h.app.ensureLogin();
  assert.equal(h.requests.filter(request => request.path === '/api/login/dev').length, 1);
  h.reply('/api/login/dev', { token: 'shared', user: h.user });
  assert.equal((await first).id, 'me'); assert.equal((await second).id, 'me');
  h.config.development = false; let login;
  h.wx.login = options => { login = options; };
  const cancelled = assert.rejects(h.app.login(), /登录/); h.app.clearSession(); login.success({ code: 'late-code' }); await cancelled;
  assert.equal(h.requests.some(request => request.path === '/api/login/wechat'), false);
});

test('settings profile loading and saving cannot revive logout, overwrite a newer identity, or commit after unload', options, async () => {
  for (const method of ['load', 'save']) for (const cancel of ['logout', 'replace', 'unload']) {
    const h = harness(), p = h.page('settings');
    if (method === 'save') await p.onLoad({});
    h.delayed.add('/api/me');
    const pending = method === 'load' ? p.onLoad({}) : p.save({ detail: { value: { name: '迟到资料' } } });
    await settle();
    if (cancel === 'logout') h.app.clearSession(); else if (cancel === 'replace') h.changeSession(); else p.onUnload();
    const expected = structuredClone(h.storage.get('gougeSession'));
    h.reply('/api/me', { user: { ...h.user, name: '迟到资料' } }, 200, method === 'save' ? 1 : 0); await pending;
    assert.deepEqual(h.storage.get('gougeSession'), expected, method + '/' + cancel);
    assert.notEqual(p.data.name, '迟到资料');
  }
});

for (const name of ['game', 'settings']) {
  test(name + ' refresh, action and ready discard responses after unload or session replacement', options, async () => {
    for (const method of ['refresh', 'action', 'ready']) for (const cancel of ['unload', 'replace']) {
      const h = harness(), p = await h.gamePage(name, method === 'ready');
      const path = '/api/games/game-1' + (method === 'refresh' ? '' : '/' + method);
      h.delayed.add(path);
      const pending = method === 'refresh' ? (name === 'game' ? p.refresh() : p.refreshGame()) : p[method]('draw-request');
      if (cancel === 'unload') p.onUnload(); else h.changeSession(); h.storage.delete('gougeLastGame');
      h.reply(path, { game: { ...h.game, version: 2 } }); await pending;
      assert.equal(p.data.game.version, 1, method + '/' + cancel);
      assert.equal(h.storage.has('gougeLastGame'), false, method + '/' + cancel);
    }
  });
  test(name + ' preserves valid hidden-page game responses while rejecting direct renders after unload', options, async () => {
    const h = harness(), p = await h.gamePage(name); h.delayed.add('/api/games/game-1');
    const pending = name === 'game' ? p.refresh() : p.refreshGame(); p.onHide();
    h.reply('/api/games/game-1', { game: { ...h.game, version: 2 } }); await pending;
    assert.equal(p.data.game.version, 2);
    p.onUnload(); h.storage.delete('gougeLastGame');
    if (name === 'game') p.render({ ...h.game, version: 3 }); else p.renderGame({ ...h.game, version: 3 });
    assert.equal(p.data.game.version, 2); assert.equal(h.storage.has('gougeLastGame'), false);
  });
}

test('successful AI creation and table join remain recoverable after leaving the page, but never navigate or cross sessions', options, async () => {
  for (const name of ['ai', 'lobby']) for (const cancel of ['hide', 'unload', 'replace']) {
    const h = harness(), p = h.page(name); if (p.onLoad) p.onLoad();
    const path = name === 'ai' ? '/api/ai' : '/api/tables/1/join'; h.delayed.add(path);
    const pending = name === 'ai' ? p.start() : p.table({ currentTarget: { dataset: { id: 1, action: 'join' } } }); await settle();
    if (cancel === 'replace') h.changeSession(); else if (cancel === 'hide') p.onHide(); else p.onUnload();
    h.game.id = 'late-game';
    h.reply(path, { gameId: 'late-game' }); await pending;
    assert.equal(h.storage.has('gougeLastGame'), cancel !== 'replace', name + '/' + cancel);
    if (cancel !== 'replace') assert.deepEqual(h.storage.get('gougeLastGame'), { gameId: 'late-game', userId: 'me' });
    assert.deepEqual(h.navigation, [], name + '/' + cancel);
  }
});

test('reversed successful POST responses never restore a game that a later game has already ended', options, async () => {
  const h = harness(), a = h.page('ai'), b = h.page('ai'); h.delayed.add('/api/ai'); h.delayed.add('/api/games/game-a');
  const first = a.start(), second = b.start(); await settle(); a.onUnload();
  h.game.id = 'game-b'; h.reply('/api/ai', { gameId: 'game-b' }, 200, 1); await second;
  h.reply('/api/ai', { gameId: 'game-a' }); await settle();
  h.reply('/api/games/game-a', { game: { ...h.game, id: 'game-a', status: 'finished' } }); await first;
  assert.equal(h.storage.get('gougeLastGame').gameId, 'game-b');
  assert.deepEqual(h.navigation, ['/chess/pages/game/index?id=game-b']);
});

test('successful game validation is serial so a delayed old GET cannot discard a newer game', options, async () => {
  const h = harness(), a = h.page('ai'), b = h.page('lobby'); h.delayed.add('/api/ai'); h.delayed.add('/api/games/game-a'); h.delayed.add('/api/tables/1/join');
  const first = a.start(); await settle(); a.onUnload(); h.reply('/api/ai', { gameId: 'game-a' }); await settle();
  h.game.id = 'game-b'; const second = b.table({ currentTarget: { dataset: { id: 1, action: 'join' } } });
  h.reply('/api/tables/1/join', { gameId: 'game-b' }); await settle();
  assert.equal(h.requests.some(request => request.path === '/api/games/game-b'), false);
  h.reply('/api/games/game-a', { game: { ...h.game, id: 'game-a' } }); await first; await second;
  assert.equal(h.requests.some(request => request.path === '/api/games/game-b'), true);
  assert.equal(h.storage.get('gougeLastGame').gameId, 'game-b');
  assert.deepEqual(h.navigation, ['/chess/pages/game/index?id=game-b']);
});

test('failed game verification preserves the prior record, reports the error, and does not block later recovery', options, async () => {
  for (const name of ['ai', 'lobby']) {
    const h = harness(), p = h.page(name), path = name === 'ai' ? '/api/ai' : '/api/tables/1/join';
    h.storage.set('gougeLastGame', { gameId: 'prior-game', userId: 'me' });
    h.delayed.add(path); h.delayed.add('/api/games/new-game');
    const start = () => name === 'ai' ? p.start() : p.table({ currentTarget: { dataset: { id: 1, action: 'join' } } });
    const first = start(); await settle(); h.reply(path, { gameId: 'new-game' }); await settle();
    h.reply('/api/games/new-game', { error: '验证连接失败' }, 503); await first;
    assert.equal(h.storage.get('gougeLastGame').gameId, 'prior-game');
    assert.equal(p.data.error, '验证连接失败'); assert.deepEqual(h.navigation, []);
    const retry = start(); await settle(); h.reply(path, { gameId: 'new-game' }, 200, 1); await settle();
    h.reply('/api/games/new-game', { game: { ...h.game, id: 'new-game', status: 'waiting' } }, 200, 1); await retry;
    assert.equal(h.storage.get('gougeLastGame').gameId, 'new-game');
    assert.deepEqual(h.navigation, ['/chess/pages/game/index?id=new-game']);
  }
});

test('lobby opening cannot start a websocket after hide or after changing session', options, async () => {
  for (const cancel of ['hide', 'replace']) {
    const h = harness(), p = h.page('lobby'); h.delayed.add('/api/lobby');
    const pending = p.open(); await settle();
    if (cancel === 'hide') p.onHide(); else h.changeSession();
    h.reply('/api/lobby', { tables: [] }); await pending; assert.equal(h.sockets.length, 0);
  }
});

test('home login and navigation never update an unloaded menu or jump away from the tools home', options, async () => {
  for (const method of ['login', 'navigate']) {
    const h = harness(), p = h.page('index'); h.app.clearSession(); h.delayed.add('/api/login/dev');
    const pending = method === 'login' ? p.login() : p.navigate({ currentTarget: { dataset: { page: 'ai' } } });
    await settle(); p.onUnload(); h.reply('/api/login/dev', { token: 'valid-login', user: h.user }); await pending;
    assert.deepEqual(h.navigation, []); assert.equal(p.data.user, null);
  }
});

test('late leave and logout responses cannot redirect or clear a replacement session', options, async () => {
  for (const name of ['game', 'settings']) {
    const h = harness(), p = await h.gamePage(name, true); h.delayed.add('/api/tables/1/leave');
    const pending = p.leaveTable(); await settle(); h.changeSession();
    h.reply('/api/tables/1/leave', { ok: true }); await pending;
    assert.deepEqual(h.navigation, []); assert.equal(h.app.globalData.token, 'token-2');
  }
  const h = harness(), p = h.page('settings'); await p.onLoad({}); p.visible = true;
  h.storage.set('gougeLastGame', { gameId: 'game-1', userId: 'me' }); h.delayed.add('/api/games/game-1');
  const pending = p.logout(); h.changeSession(); h.reply('/api/games/game-1', { game: { ...h.game, status: 'finished' } }); await pending;
  assert.equal(h.app.globalData.token, 'token-2'); assert.deepEqual(h.navigation, []);
});
