import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { createApp } from '../server/app.js';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const options = { skip: !existsSync(resolve(host, 'chess/session.js')) && 'Set ITO_HOST_ROOT to test integrated chess' };
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
  const config = { transport: 'cloud', cloudEnv: 'gouge-chess-d1gubfb4x25bc5571', cloudService: 'gouge-chess', development: false, ...overrides };
  const cache = new Map(), calls = [], requests = [], connects = [], timers = new Map(), definitions = new Map();
  const user = { id: 'me', name: '云棋友' };
  const storage = new Map([['gougeSession', { token: 'app-session', user, ...config }], ['itoSettings', { untouched: true }]]);
  let now = 100000, timerId = 0;
  const h = { config, calls, requests, connects, storage, user, timers };
  const wx = h.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    login(options) { calls.push({ type: 'wx-login' }); options.success({ code: 'real-login-code-seam' }); },
    request(options) { calls.push({ type: 'http', options }); options.success({ statusCode: 200, data: { user } }); },
    connectSocket(options) { calls.push({ type: 'http-socket', options }); return socket(); },
    cloud: {
      init(options) { calls.push({ type: 'init', options }); },
      callContainer(options) { requests.push(options); return Promise.resolve({ statusCode: 200, data: { user } }); },
      connectContainer(options) { connects.push(options); return Promise.resolve({ socketTask: socket() }); }
    }
  };
  function socket() {
    const handlers = {};
    return { handlers, sent: [], closed: false,
      onOpen(fn) { handlers.open = fn; }, onMessage(fn) { handlers.message = fn; }, onClose(fn) { handlers.close = fn; }, onError(fn) { handlers.error = fn; },
      send(options) { this.sent.push(JSON.parse(options.data)); }, close() { this.closed = true; },
      open() { handlers.open(); }, message(data) { handlers.message({ data: JSON.stringify(data) }); }, disconnect() { handlers.close(); }
    };
  }
  function schedule(fn, delay, interval = 0) { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; }
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval }); timer.fn();
    }
    now = until;
  }
  function load(file) {
    file = resolve(host, file); if (!extname(file)) file += '.js';
    if (file === resolve(host, 'chess/config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, wx, console,
      require: name => load(resolve(dirname(file), name)), Page: definition => definitions.set(file, definition),
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
      setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: id => timers.delete(id)
    }, { filename: file });
    return module.exports;
  }
  function page(name) {
    const file = resolve(host, 'chess/pages', name, 'index.js'); load(file);
    const definition = definitions.get(file);
    return { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  }
  return Object.assign(h, { load, socket, advance, page });
}

test('cloud release configuration accepts valid environment/service and rejects missing values or development login', options, () => {
  const h = harness(), deployment = h.load('chess/services/deployment.js');
  assert.deepEqual(Array.from(deployment.releaseErrors(h.config)), []);
  assert.equal(deployment.configurationError(h.config), '');
  for (const overrides of [{ cloudEnv: '' }, { cloudService: '' }, { development: true }]) {
    assert.ok(deployment.releaseErrors({ ...h.config, ...overrides }).length);
    assert.match(deployment.configurationError({ ...h.config, ...overrides }), /线上象棋服务尚未配置/);
  }
  assert.deepEqual(Array.from(deployment.releaseErrors({ development: false, apiBase: 'https://chess.example.com' })), []);
});

test('cloud API initializes lazily once and sends application auth through the official container request shape', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js');
  assert.equal(h.calls.length, 0);
  await api.request('/api/me'); await api.request('/api/games/game-1/action', 'POST', { type: 'move' });
  assert.equal(h.calls.filter(call => call.type === 'init').length, 1);
  assert.deepEqual(plain(h.calls[0].options), { env: h.config.cloudEnv });
  assert.equal(h.calls.some(call => call.type === 'http'), false);
  const first = h.requests[0];
  assert.equal(first.path, '/api/me'); assert.equal(first.config.env, h.config.cloudEnv);
  assert.equal(first.header['X-WX-SERVICE'], h.config.cloudService);
  assert.equal(first.header.Authorization, 'Bearer app-session');
  assert.equal(first.header['X-WX-OPENID'], undefined); assert.equal(first.header['X-WX-APPID'], undefined);
  assert.equal(first.method, 'GET'); assert.equal(first.timeout, 20000);
  assert.equal(h.requests[1].path, '/api/games/game-1/action'); assert.equal(h.requests[1].data.type, 'move');
  assert.deepEqual(h.storage.get('itoSettings'), { untouched: true });
});

test('production cloud login still obtains a wx.login code and never falls back to development identity', options, async () => {
  const h = harness(); h.storage.delete('gougeSession');
  h.wx.cloud.callContainer = request => {
    h.requests.push(request); return Promise.resolve({ statusCode: 200, data: { token: 'server-session', user: h.user } });
  };
  const app = h.load('chess/session.js').getChessApp(); await app.login();
  assert.equal(h.calls.filter(call => call.type === 'wx-login').length, 1);
  assert.equal(h.requests[0].path, '/api/login/wechat'); assert.equal(h.requests[0].data.code, 'real-login-code-seam');
  assert.equal(h.requests[0].header.Authorization, undefined);
  const saved = h.storage.get('gougeSession');
  assert.equal(saved.token, 'server-session'); assert.equal(saved.transport, 'cloud');
  assert.equal(saved.cloudEnv, h.config.cloudEnv); assert.equal(saved.cloudService, h.config.cloudService);
});

test('stored tokens are scoped to HTTP/cloud transport, cloud environment, and service', options, () => {
  for (const saved of [
    { token: 'http-token', user: { id: 'other' }, development: false, transport: undefined, cloudEnv: undefined, cloudService: undefined },
    { transport: 'cloud', cloudEnv: 'another-env', cloudService: 'gouge-chess' },
    { transport: 'cloud', cloudEnv: 'gouge-chess-d1gubfb4x25bc5571', cloudService: 'another-service' }
  ]) {
    const h = harness(); h.storage.set('gougeSession', { token: 'wrong-token', user: h.user, ...h.config, ...saved });
    const app = h.load('chess/session.js').getChessApp(); assert.equal(app.globalData.token, ''); assert.equal(app.globalData.user, null);
  }
});

test('cloud errors never retry through public HTTP and stale 401 cannot clear a replacement app session', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'), app = h.load('chess/session.js').getChessApp(); let finish;
  h.wx.cloud.callContainer = () => new Promise(resolve => { finish = resolve; });
  const denied = assert.rejects(api.request('/api/me'), error => error.status === 401);
  app.globalData.token = 'new-session'; finish({ statusCode: 401, data: { error: '旧会话过期' } }); await denied;
  assert.equal(app.globalData.token, 'new-session');
  h.wx.cloud.callContainer = () => Promise.reject({ errMsg: '云托管暂不可用' });
  await assert.rejects(api.request('/api/me'), /云托管暂不可用/);
  assert.equal(h.calls.some(call => call.type === 'http'), false);
  delete h.wx.cloud.callContainer;
  await assert.rejects(api.request('/api/me'), /微信.*云托管/);
});

test('cloud socket uses its returned SocketTask, application token, subscription, and ten-second heartbeats', options, async () => {
  const h = harness(), statuses = [], messages = [], GameSocket = h.load('chess/services/socket.js');
  const client = new GameSocket({ gameId: 'game-1', onStatus: status => statuses.push(status), onMessage: message => messages.push(message) });
  client.start(); await settle();
  assert.equal(h.connects.length, 1); assert.equal(h.calls.some(call => call.type === 'http-socket'), false);
  assert.equal(h.connects[0].config.env, h.config.cloudEnv); assert.equal(h.connects[0].service, h.config.cloudService);
  assert.equal(h.connects[0].path, '/ws?token=app-session');
  const socket = client.socket; socket.open();
  assert.deepEqual(socket.sent, [{ type: 'subscribe', gameId: 'game-1' }, { type: 'ping' }]);
  h.advance(10000); assert.equal(socket.sent.filter(message => message.type === 'ping').length, 2);
  socket.message({ type: 'pong', serverNow: 110000 }); assert.equal(messages[0].type, 'pong');
  client.stop(); h.advance(60000); assert.equal(h.connects.length, 1); assert.equal(socket.closed, true);
  assert.equal(statuses.at(-1), '已连接');
});

test('late container sockets close after hide/stop or session replacement without starting subscriptions or heartbeats', options, async () => {
  for (const cancel of ['stop', 'session']) {
    const h = harness(), statuses = [], GameSocket = h.load('chess/services/socket.js'); let finish;
    h.wx.cloud.connectContainer = request => { h.connects.push(request); return new Promise(resolve => { finish = resolve; }); };
    const client = new GameSocket({ onStatus: status => statuses.push(status), onMessage() {} }); client.start();
    if (cancel === 'stop') client.stop(); else h.load('chess/session.js').getChessApp().globalData.token = 'new-session';
    const socket = h.socket(); finish({ socketTask: socket }); await settle();
    assert.equal(socket.closed, true); assert.deepEqual(socket.sent, []); assert.equal(h.timers.size, 0);
    assert.equal(statuses.includes('已连接'), false);
  }
});

test('cloud websocket failure reconnects only while active and stops old-session callbacks', options, async () => {
  const h = harness(), GameSocket = h.load('chess/services/socket.js'), received = [];
  const client = new GameSocket({ onStatus() {}, onMessage: message => received.push(message) });
  client.start(); await settle(); const old = client.socket; old.open(); old.disconnect();
  h.advance(1000); await settle(); assert.equal(h.connects.length, 2); assert.equal(old.closed, true);
  client.socket.open(); old.message({ type: 'game', game: { id: 'old' } }); assert.deepEqual(received, []);
  h.load('chess/session.js').getChessApp().clearSession(); h.advance(10000);
  assert.equal(client.stopped, true); assert.equal(h.timers.size, 0);
});

test('failed cloud websocket refreshes authenticated lobby snapshots every 2.5 seconds and stops with the page', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'), GameSocket = h.load('chess/services/socket.js'), statuses = [], snapshots = [];
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
  h.wx.cloud.callContainer = request => { h.requests.push(request); return Promise.resolve({ statusCode: 200, data: { tables: [{ id: 1, spectatorCount: snapshots.length }] } }); };
  const client = new GameSocket({ onStatus: status => statuses.push(status), onMessage() {},
    onReconnect: () => api.request('/api/lobby').then(result => snapshots.push(result.tables)) });
  client.start(); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/lobby');
  assert.equal(h.requests[0].header.Authorization, 'Bearer app-session');
  assert.equal(h.requests[0].header['X-WX-SERVICE'], h.config.cloudService);
  assert.equal(h.calls.some(call => call.type === 'http'), false);
  assert.ok(statuses.includes('实时连接中断，已改为定时刷新'));
  h.advance(2499); await settle(); assert.equal(h.requests.length, 1);
  h.advance(1); await settle(); assert.equal(h.requests.length, 2);
  assert.equal(snapshots[1][0].spectatorCount, 1);
  client.stop(); const callsAtStop = h.connects.length;
  h.advance(60000); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.connects.length, callsAtStop); assert.equal(h.timers.size, 0);
});

test('slow cloud fallback never overlaps requests or floods retries, and websocket recovery cancels further polling', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'), GameSocket = h.load('chess/services/socket.js');
  let finish;
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
  h.wx.cloud.callContainer = request => { h.requests.push(request); return new Promise(resolve => { finish = resolve; }); };
  const client = new GameSocket({ onStatus() {}, onMessage() {}, onReconnect: () => api.request('/api/lobby') });
  client.start(); await settle(); assert.equal(h.requests.length, 1);
  for (let i = 0; i < 20; i++) { h.advance(1000); await settle(); }
  assert.equal(h.requests.length, 1); assert.ok(h.connects.length > 1);
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.resolve({ socketTask: h.socket() }); };
  h.advance(10000); await settle(); client.socket.open();
  assert.equal(h.requests.length, 1);
  finish({ statusCode: 200, data: { tables: [] } }); await settle();
  h.advance(5000); await settle(); assert.equal(h.requests.length, 1);
  client.stop(); h.advance(60000); await settle(); assert.equal(h.timers.size, 0);
});

test('lobby hide and changed sessions discard late fallback snapshots and prevent later HTTP or websocket requests', options, async () => {
  for (const cancel of ['hide', 'session', 'expired']) {
    const h = harness(), app = h.load('chess/session.js').getChessApp();
    let finish, lobbyReads = 0;
    h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
    h.wx.cloud.callContainer = request => {
      h.requests.push(request);
      if (request.path === '/api/me') return Promise.resolve({ statusCode: 200, data: { user: h.user } });
      assert.equal(request.path, '/api/lobby');
      if (++lobbyReads === 1) return Promise.resolve({ statusCode: 200, data: { tables: [{ id: 1, spectatorCount: 0 }] } });
      return new Promise(resolve => { finish = resolve; });
    };
    const page = h.page('lobby'); page.onShow(); await settle();
    assert.equal(lobbyReads, 2); assert.equal(page.data.tables[0].spectatorCount, 0);
    if (cancel === 'hide') page.onHide();
    else if (cancel === 'session') app.globalData.token = 'replacement-session';
    finish(cancel === 'expired' ? { statusCode: 401, data: { error: '会话已失效', code: 'LOGIN_REQUIRED' } }
      : { statusCode: 200, data: { tables: [{ id: 1, spectatorCount: 99 }] } });
    await settle(); h.advance(10000); await settle();
    assert.equal(page.data.tables[0].spectatorCount, 0);
    assert.equal(lobbyReads, 2); assert.equal(h.connects.length, 1); assert.equal(h.timers.size, 0);
    if (cancel === 'session') assert.equal(app.globalData.token, 'replacement-session');
    if (cancel === 'expired') assert.equal(app.globalData.token, '');
    assert.deepEqual(h.storage.get('itoSettings'), { untouched: true });
    page.onUnload();
  }
});

test('settings fallback awaits its game refresh and hide cancels polling even while the request is pending', options, async () => {
  const h = harness();
  let finish, gameReads = 0;
  const game = { id: 'settings-game', mode: 'pvp', tableId: 1, status: 'active', version: 1, turn: 'red', serverNow: 100000,
    seats: { red: h.user, black: { id: 'other' } }, ready: { red: true, black: true }, history: [],
    timeControl: { mode: 'normal', perMoveSeconds: null, totalSeconds: null, overtimeSeconds: 20 }, clock: { deadline: null } };
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
  h.wx.cloud.callContainer = request => {
    h.requests.push(request);
    if (request.path === '/api/me') return Promise.resolve({ statusCode: 200, data: { user: h.user } });
    assert.equal(request.path, '/api/games/settings-game');
    if (++gameReads === 1) return Promise.resolve({ statusCode: 200, data: { game } });
    return new Promise(resolve => { finish = resolve; });
  };
  const page = h.page('settings');
  await page.onLoad({ gameId: game.id }); page.onShow(); await settle();
  assert.equal(gameReads, 2); assert.equal(page.data.game.id, game.id);
  for (let i = 0; i < 10; i++) { h.advance(1000); await settle(); }
  assert.equal(gameReads, 2);
  page.onHide(); const connectsAtHide = h.connects.length;
  finish({ statusCode: 200, data: { game: { ...game, version: 2 } } }); await settle();
  h.advance(60000); await settle();
  assert.equal(gameReads, 2); assert.equal(h.connects.length, connectsAtHide); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.storage.get('itoSettings'), { untouched: true });
  page.onUnload();
});

test('cloud table chat works independently while the game websocket falls back to polling', options, async () => {
  const h = harness(), messages = [], chatCalls = [];
  const game = { id: 'cloud-chat-game', mode: 'pvp', tableId: 1, status: 'active', version: 1, turn: 'red', serverNow: 100000,
    board: Array(90).fill(null), legalMoves: [], seats: { red: h.user, black: { id: 'other' } }, ready: { red: true, black: true }, history: [],
    spectators: [], timeControl: { mode: 'normal', perMoveSeconds: null, totalSeconds: null, overtimeSeconds: 20 }, clock: { deadline: null } };
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
  h.wx.cloud.callContainer = request => {
    h.requests.push(request);
    return Promise.resolve({ statusCode: 200, data: request.path === '/api/me' ? { user: h.user } : { game } });
  };
  h.wx.cloud.callFunction = request => {
    chatCalls.push(plain(request));
    const data = request.data;
    if (data.operation === 'send') messages.push({ id: 'msg-1', seq: 1, userId: 'me', name: '云棋友', text: data.text, kind: 'text', at: 100000 });
    return Promise.resolve({ result: { gameId: game.id, seq: messages.length, messages: plain(messages), ...(data.operation === 'send' ? { message: messages[0] } : {}) } });
  };
  const page = h.page('game'); page.onLoad({ id: game.id }); page.onShow(); await settle();
  assert.equal(page.data.connection, '实时连接中断，已改为定时刷新');
  assert.equal(page.data.chatReady, true);
  await page.chatRoom.send({ text: '同桌聊一下' }); await settle();
  assert.equal(page.data.chatMessages[0].name, '云棋友');
  assert.equal(page.data.chatMessages[0].text, '同桌聊一下');
  assert.equal(page.data.game.version, 1);
  for (let i = 0; i < 7; i++) { h.advance(3000); await settle(); }
  assert.ok(h.connects.length > 1); assert.ok(chatCalls.filter(value => value.data.operation === 'list').length > 1);
  assert.ok(chatCalls.every(value => value.name === 'gouge-chess-chat' && value.config.env === h.config.cloudEnv && value.data.userIdHint === 'me'));
  assert.equal(h.requests.some(request => request.path.startsWith('/api/voice/')), false);
  page.onUnload(); await settle(); assert.equal(h.timers.size, 0); assert.deepEqual(h.storage.get('itoSettings'), { untouched: true });
});

test('cloud fallback receives real authenticated game and lobby HTTP snapshots from an isolated backend', { ...options, timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gouge-cloud-fallback-'));
  const server = createApp({ dataDir: directory,
    env: { DEV_MODE: 'false', HOST: '127.0.0.1', PUBLIC_BASE_URL: 'https://chess.example.invalid', WECHAT_APP_ID: 'wx-fallback-test', WECHAT_APP_SECRET: 'test-only-secret' },
    fetch: async url => ({ ok: true, json: async () => ({ openid: new URL(url).searchParams.get('js_code'), session_key: 'test-only-session' }) }) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const { port } = await server.listen(0), base = `http://127.0.0.1:${port}`;
  async function backend(path, token, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { statusCode: response.status, data: await response.json() };
  }
  const red = (await backend('/api/login/wechat', null, { code: 'fallback-red' })).data;
  const black = (await backend('/api/login/wechat', null, { code: 'fallback-black' })).data;
  const { gameId } = (await backend('/api/tables/1/join', red.token, { color: 'red' })).data;
  await backend('/api/tables/1/join', black.token, { color: 'black' });
  await backend('/api/games/' + gameId + '/ready', red.token, { timeControl: { perMoveSeconds: null, totalSeconds: null } });
  await backend('/api/games/' + gameId + '/ready', black.token, {});
  const h = harness(); h.storage.set('gougeSession', { ...h.config, token: red.token, user: red.user });
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return Promise.reject({ errMsg: '未完成的操作' }); };
  h.wx.cloud.callContainer = request => { h.requests.push(request); return backend(request.path, request.header.Authorization?.slice(7), request.method === 'GET' ? undefined : request.data); };
  const api = h.load('chess/services/api.js'), GameSocket = h.load('chess/services/socket.js');
  let nextSnapshot;
  const client = new GameSocket({ gameId, onStatus() {}, onMessage() {},
    onReconnect: () => api.request('/api/games/' + gameId).then(result => { if (nextSnapshot) { const deliver = nextSnapshot; nextSnapshot = null; deliver(result.game); } }) });
  t.after(() => client.stop());
  const initial = new Promise(resolve => { nextSnapshot = resolve; }); client.start();
  const game = await initial;
  assert.equal(game.status, 'active'); assert.equal(game.seats.red.id, red.user.id);
  assert.equal(h.requests[0].header.Authorization, 'Bearer ' + red.token);
  const move = await backend('/api/games/' + gameId + '/action', red.token, {
    type: 'move', moveId: game.legalMoves[0].id, version: game.version, turnId: game.turnId, operationId: 'cloud-poll-real-http-move' });
  assert.equal(move.statusCode, 200);
  const updated = new Promise(resolve => { nextSnapshot = resolve; }); h.advance(2500);
  const snapshot = await updated;
  assert.equal(snapshot.history.length, 1); assert.equal(snapshot.turn, 'black');
  assert.deepEqual(plain(snapshot.board), move.data.game.board); client.stop();
  let deliverLobby;
  const lobbyReady = new Promise(resolve => { deliverLobby = resolve; });
  const lobby = new GameSocket({ onStatus() {}, onMessage() {}, onReconnect: () => api.request('/api/lobby').then(deliverLobby) });
  t.after(() => lobby.stop()); lobby.start();
  const tables = (await lobbyReady).tables;
  assert.equal(tables.length, 6); assert.equal(tables[0].gameId, gameId); assert.equal(tables[0].status, 'active');
  lobby.stop(); assert.equal(h.calls.some(call => call.type === 'http'), false); assert.equal(h.timers.size, 0);
});

test('cloud heartbeat silence reconnects once and late connection rejection after stop cannot revive retries', options, async () => {
  const h = harness(), GameSocket = h.load('chess/services/socket.js');
  const client = new GameSocket({ onStatus() {}, onMessage() {} }); client.start(); await settle();
  const first = client.socket; first.open(); h.advance(41000); await settle();
  assert.equal(h.connects.length, 2); assert.equal(first.closed, true); client.stop();
  let reject;
  h.wx.cloud.connectContainer = request => { h.connects.push(request); return new Promise((resolve, failure) => { reject = failure; }); };
  client.start(); client.stop(); reject({ errMsg: '迟到连接失败' }); await settle();
  h.advance(60000); assert.equal(h.connects.length, 3); assert.equal(h.timers.size, 0);
});

test('HTTP development requests and sockets preserve the original local transport', options, async () => {
  const h = harness({ transport: 'http', apiBase: 'http://127.0.0.1:8787', development: true }); delete h.wx.getAccountInfoSync;
  await h.load('chess/services/api.js').request('/api/me');
  const GameSocket = h.load('chess/services/socket.js'); new GameSocket({ onStatus() {}, onMessage() {} }).start();
  assert.equal(h.requests.length, 0); assert.equal(h.connects.length, 0);
  assert.equal(h.calls.filter(call => call.type === 'http').length, 1); assert.equal(h.calls.filter(call => call.type === 'http-socket').length, 1);
});

test('private cloud avatars resolve through the authenticated backend while stored sessions retain only permanent file IDs', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'), fileID = 'cloud://gouge-chess-d1gubfb4x25bc5571.bucket/avatars/me.png';
  h.wx.cloud.callContainer = request => { h.requests.push(request); return Promise.resolve({ statusCode: 200, data: { url: 'https://storage.example.com/temporary-avatar', expiresAt: 400000 } }); };
  assert.equal(api.avatarUrl(fileID), '');
  const first = api.resolveAvatar(fileID), second = api.resolveAvatar(fileID); await first; await second;
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/api/avatar-url');
  assert.equal(h.requests[0].method, 'POST'); assert.equal(h.requests[0].data.fileID, fileID);
  assert.equal(h.requests[0].header.Authorization, 'Bearer app-session');
  assert.equal(api.avatarUrl(fileID), 'https://storage.example.com/temporary-avatar');
  const app = h.load('chess/session.js').getChessApp(); app.updateUser({ ...h.user, avatar: fileID }, 'app-session');
  assert.equal(app.globalData.user.avatar, fileID); assert.equal(h.storage.get('gougeSession').user.avatar, fileID);
  assert.equal(h.storage.get('gougeSession').user.avatarUrl, undefined);
});

test('late avatar resolution cannot overwrite a newly picked avatar or update an unloaded or new-session settings page', options, async () => {
  for (const cancel of ['pick', 'unload', 'session']) {
    const h = harness(), fileID = 'cloud://gouge-chess-d1gubfb4x25bc5571.bucket/avatars/me.png'; let finish;
    h.wx.cloud.callContainer = request => request.path === '/api/avatar-url'
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ statusCode: 200, data: { user: { ...h.user, avatar: fileID } } });
    const page = h.page('settings'); await page.onLoad({}); await settle(); assert.ok(finish);
    if (cancel === 'pick') page.avatar({ detail: { avatarUrl: 'local-picked-avatar' } });
    else if (cancel === 'unload') page.onUnload();
    else h.load('chess/session.js').getChessApp().clearSession();
    const before = page.data.avatar;
    finish({ statusCode: 200, data: { url: 'https://storage.example.com/late-avatar', expiresAt: 400000 } }); await settle();
    assert.equal(page.data.avatar, before);
  }
});

test('avatar URL cache is session-scoped and denied private file IDs never fall back to direct cloud storage reads', options, async () => {
  const h = harness(), api = h.load('chess/services/api.js'), fileID = 'cloud://gouge-chess-d1gubfb4x25bc5571.bucket/avatars/pending.png';
  h.wx.cloud.callContainer = request => { h.requests.push(request); return Promise.resolve({ statusCode: 200, data: { url: 'https://storage.example.com/first-session', expiresAt: 400000 } }); };
  await api.resolveAvatar(fileID);
  const app = h.load('chess/session.js').getChessApp(); app.globalData.token = 'another-session';
  assert.equal(api.avatarUrl(fileID), '');
  h.wx.cloud.callContainer = request => { h.requests.push(request); return Promise.resolve({ statusCode: 403, data: { error: '头像无权限', code: 'AVATAR_FORBIDDEN' } }); };
  await assert.rejects(api.resolveAvatar(fileID), error => error.status === 403 && error.code === 'AVATAR_FORBIDDEN');
  assert.equal(h.requests.at(-1).header.Authorization, 'Bearer another-session');
  assert.equal(api.avatarUrl(fileID), ''); assert.equal(h.wx.cloud.getTempFileURL, undefined);
});
