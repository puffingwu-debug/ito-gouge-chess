import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const hostRoot = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const hostOptions = { skip: !existsSync(hostRoot) && 'ITO host is not installed; set ITO_HOST_ROOT to test the integrated package' };
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const itoKeys = ['itoSettings', 'itoSheets', 'itoStorage', 'cutSheet', 'cutProducts'];

function hostHarness() {
  const config = { transport: 'http', apiBase: 'http://127.0.0.1:8787', development: true };
  const storage = new Map([
    ['itoSettings', { scaleMin: 7, scaleMax: 16, rows: 2, cols: 3, lastCode: 'ITO-KEEP' }],
    ['itoSheets', [{ code: 'ITO-KEEP', points: [8.1, 9.2, 10.3] }]],
    ['itoStorage', { marker: 'host-owned-storage' }],
    ['cutSheet', { len: 2440, wid: 1830, wasteMin: 6 }],
    ['cutProducts', [{ name: 'host-glass', len: 500, wid: 600, count: 2 }]]
  ]);
  const calls = [];
  const pages = [];
  const sockets = [];
  const timers = new Map();
  const cache = new Map();
  const definitions = new Map();
  const responses = [];
  let hostApp;
  let timerId = 0;
  let hostAccesses = 0;
  const user = { id: 'chess-user', name: '棋友', avatar: '/avatars/chess-user.png' };
  const now = Date.now();
  const game = {
    id: 'game-1', tableId: 1, mode: 'pvp', status: 'active', version: 2, turnId: 'turn-1', ownerId: user.id,
    board: Array(90).fill(null), legalMoves: [], history: [], turn: 'red',
    seats: { red: user, black: { id: 'other', name: '另一位家人' } }, ready: { red: true, black: true },
    spectators: [], voiceMembers: [], serverNow: now, undo: null, draw: null, outcome: null,
    timeControl: { mode: 'rapid', rapidSeconds: 15 },
    clock: { deadline: now + 15000, red: { usedMs: 2000, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 3000, totalRemainingMs: null, phase: 'rapid' } }
  };
  function responseFor(options) {
    const path = new URL(options.url).pathname;
    if (path === '/api/login/dev' || path === '/api/login/wechat') return { token: 'chess-token', user };
    if (path === '/api/me') return { user: options.method === 'PATCH' ? { ...user, ...options.data } : user };
    if (path === '/api/lobby') return { tables: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, status: 'empty', seats: { red: null, black: null }, spectatorCount: 0 })) };
    if (path === '/api/ai') return { gameId: 'ai-game' };
    if (/^\/api\/tables\/\d+\/(join|watch)$/.test(path)) return { gameId: game.id };
    if (path === '/api/games/' + game.id) return { game };
    if (path === '/api/games/ai-game') return { game: { ...game, id: 'ai-game', mode: 'ai', tableId: null } };
    throw new Error('Unexpected test request: ' + options.method + ' ' + path);
  }
  const wx = {
    getStorageSync(key) { calls.push({ type: 'read', key }); return structuredClone(storage.get(key)); },
    setStorageSync(key, value) { calls.push({ type: 'write', key }); storage.set(key, structuredClone(value)); },
    removeStorageSync(key) { calls.push({ type: 'remove', key }); storage.delete(key); },
    clearStorageSync() { throw new Error('Clearing host storage is forbidden'); },
    navigateTo({ url }) { calls.push({ type: 'navigate', url }); },
    redirectTo({ url }) { calls.push({ type: 'redirect', url }); },
    reLaunch({ url }) { calls.push({ type: 'relaunch', url }); },
    navigateBack({ delta }) { calls.push({ type: 'back', delta }); pages.splice(-delta, delta); },
    login({ success }) { queueMicrotask(() => success({ code: 'test-only-wechat-code' })); },
    request(options) {
      calls.push({ type: 'http', url: options.url, method: options.method, data: plain(options.data || {}), header: plain(options.header) });
      const response = responses.shift() || { statusCode: 200, data: responseFor(options) };
      queueMicrotask(() => options.success(structuredClone(response)));
      return { abort() {} };
    },
    connectSocket({ url }) {
      const handlers = {};
      const socket = {
        url, closed: false, sent: [],
        onOpen(fn) { handlers.open = fn; }, onMessage(fn) { handlers.message = fn; },
        onClose(fn) { handlers.close = fn; }, onError(fn) { handlers.error = fn; },
        send({ data }) { this.sent.push(JSON.parse(data)); },
        close() { this.closed = true; },
        open() { handlers.open(); }
      };
      sockets.push(socket);
      return socket;
    },
    getWindowInfo() { return { windowWidth: 390, windowHeight: 753, screenHeight: 844, safeArea: { bottom: 810 } }; },
    showModal(options) { calls.push({ type: 'modal', title: options.title }); options.success({ confirm: false, cancel: true }); },
    showToast(options) { calls.push({ type: 'toast', title: options.title }); },
    stopPullDownRefresh() {},
    onVoIPChatMembersChanged() {}, offVoIPChatMembersChanged() {},
    onVoIPChatInterrupted() {}, offVoIPChatInterrupted() {}
  };
  const context = {
    wx, console, Date,
    getApp() { hostAccesses++; throw new Error('Chess must not access the host App'); },
    getCurrentPages: () => pages,
    App(app) { hostApp = app; }, Component() {},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); }
  };
  function load(file) {
    file = resolve(hostRoot, file);
    if (!extname(file)) file += '.js';
    if (file === resolve(hostRoot, 'chess/config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      ...context, module, exports: module.exports,
      Page(definition) { definitions.set(file, definition); },
      require(name) {
        assert.ok(name.startsWith('.'), 'Mini-program modules must use local CommonJS imports');
        return load(resolve(dirname(file), name));
      }
    }, { filename: file });
    return module.exports;
  }
  function page(file) {
    load(file);
    const definition = definitions.get(resolve(hostRoot, file));
    assert.ok(definition, 'Page must register itself: ' + file);
    const instance = { ...definition, route: file.replace(/\.js$/, ''), data: structuredClone(definition.data || {}), setData(patch) { Object.assign(this.data, patch); } };
    pages.push(instance);
    return instance;
  }
  function launchHost() { load('app.js'); hostApp.onLaunch(); return hostApp; }
  function itoState() { return plain({ globalData: hostApp.globalData, storage: Object.fromEntries(itoKeys.map(key => [key, storage.get(key)])) }); }
  return { load, page, launchHost, itoState, storage, calls, pages, sockets, timers, responses, game, user, get hostAccesses() { return hostAccesses; } };
}

test('ITO launch restores its tools without initializing the chess session', hostOptions, () => {
  const h = hostHarness();
  const before = plain(Object.fromEntries(h.storage));
  const app = h.launchHost();
  assert.deepEqual(plain(app.globalData.settings), before.itoSettings);
  assert.deepEqual(plain(app.globalData.sheets), before.itoSheets);
  assert.deepEqual(plain(app.globalData.cutSheet), before.cutSheet);
  assert.deepEqual(plain(app.globalData.cutProducts), before.cutProducts);
  assert.deepEqual(plain(Object.fromEntries(h.storage)), before);
  assert.equal(h.calls.some(call => call.key && call.key.startsWith('gouge')), false);
  assert.equal(h.calls.some(call => call.type === 'http'), false);
  assert.equal(h.hostAccesses, 0);
});

test('chess session initializes lazily, restores only its matching backend, and remains separate from ITO', hostOptions, () => {
  const h = hostHarness();
  const app = h.launchHost();
  const before = h.itoState();
  const config = h.load('chess/config.js');
  h.storage.set('gougeSession', { token: 'saved-chess-token', user: h.user, apiBase: config.apiBase, development: config.development });
  const { getChessApp } = h.load('chess/session.js');
  assert.equal(h.calls.some(call => call.key === 'gougeSession'), false);
  const chess = getChessApp();
  assert.equal(chess, getChessApp());
  assert.notEqual(chess.globalData, app.globalData);
  assert.equal(chess.globalData.token, 'saved-chess-token');
  assert.equal(chess.globalData.user.id, 'chess-user');
  assert.equal(chess.globalData.user.avatarUrl, config.apiBase + '/avatars/chess-user.png');
  assert.deepEqual(h.itoState(), before);
  for (const mismatch of [{ apiBase: 'https://another-backend.invalid' }, { development: !config.development }]) {
    const other = hostHarness();
    other.storage.set('gougeSession', { token: 'wrong-backend-token', user: h.user, apiBase: config.apiBase, development: config.development, ...mismatch });
    const isolated = other.load('chess/session.js').getChessApp();
    assert.equal(isolated.globalData.token, '');
    assert.equal(isolated.globalData.user, null);
  }
  assert.equal(h.hostAccesses, 0);
});

test('chess login and an expired API session cannot modify ITO state or storage', hostOptions, async () => {
  const h = hostHarness();
  h.launchHost();
  const before = h.itoState();
  const chess = h.load('chess/session.js').getChessApp();
  const user = await chess.login('棋友');
  assert.equal(user.id, 'chess-user');
  assert.equal(h.storage.get('gougeSession').token, 'chess-token');
  assert.equal(h.calls.find(call => call.type === 'http').header.Authorization, undefined);
  const api = h.load('chess/services/api.js');
  await api.request('/api/me');
  assert.equal(h.calls.filter(call => call.type === 'http').at(-1).header.Authorization, 'Bearer chess-token');
  h.responses.push({ statusCode: 401, data: { error: '会话已过期', code: 'UNAUTHORIZED' } });
  await assert.rejects(api.request('/api/me'), error => error.status === 401 && error.message === '会话已过期');
  assert.equal(chess.globalData.token, '');
  assert.equal(chess.globalData.user, null);
  assert.equal(h.storage.has('gougeSession'), false);
  assert.deepEqual(h.itoState(), before);
  assert.equal(h.hostAccesses, 0);
});

test('logging out in chess settings returns to the chess home and preserves ITO', hostOptions, async () => {
  const h = hostHarness();
  h.launchHost();
  const before = h.itoState();
  const page = h.page('chess/pages/settings/index.js');
  await page.onLoad({});
  page.onShow();
  assert.equal(page.data.name, '棋友');
  assert.equal(page.data.hasGame, false);
  await page.logout();
  assert.equal(h.storage.has('gougeSession'), false);
  assert.equal(h.load('chess/session.js').getChessApp().globalData.user, null);
  assert.deepEqual(h.calls.filter(call => call.type === 'relaunch').at(-1), { type: 'relaunch', url: '/chess/pages/index/index' });
  assert.deepEqual(h.itoState(), before);
  assert.equal(h.hostAccesses, 0);
  page.onUnload();
});

test('the ITO home opens the registered chess subpackage and keeps its existing tool routes', hostOptions, () => {
  const config = JSON.parse(readFileSync(resolve(hostRoot, 'app.json'), 'utf8'));
  assert.deepEqual(config.pages, ['pages/index/index', 'pages/input/input', 'pages/result/result', 'pages/settings/settings', 'pages/cut/cut', 'pages/cut-preview/cut-preview']);
  const chess = config.subPackages.find(group => group.root === 'chess');
  assert.deepEqual(chess.pages, ['pages/index/index', 'pages/ai/index', 'pages/lobby/index', 'pages/game/index', 'pages/settings/index']);
  for (const page of chess.pages) assert.ok(existsSync(resolve(hostRoot, 'chess', page + '.js')));
  const h = hostHarness();
  const home = h.page('pages/index/index.js');
  home.goChess();
  home.goInput();
  home.goCut();
  assert.deepEqual(h.calls, [
    { type: 'navigate', url: '/chess/pages/index/index' },
    { type: 'navigate', url: '/pages/input/input' },
    { type: 'navigate', url: '/pages/cut/cut' }
  ]);
});

test('chess home, AI setup, and lobby use their own session and subpackage routes', hostOptions, async () => {
  const h = hostHarness();
  h.launchHost();
  const before = h.itoState();
  const home = h.page('chess/pages/index/index.js');
  await home.onShow();
  assert.equal(home.data.user, null);
  await home.navigate({ currentTarget: { dataset: { page: 'ai' } } });
  assert.equal(home.data.user.id, 'chess-user');
  assert.equal(h.calls.filter(call => call.type === 'navigate').at(-1).url, '/chess/pages/ai/index');
  const ai = h.page('chess/pages/ai/index.js');
  ai.onLoad();
  assert.equal(ai.data.control.totalSeconds, 600);
  await ai.start();
  assert.equal(ai.data.error, '');
  assert.equal(h.calls.filter(call => call.type === 'redirect').at(-1).url, '/chess/pages/game/index?id=ai-game');
  const lobby = h.page('chess/pages/lobby/index.js');
  lobby.onShow();
  await settle();
  assert.equal(lobby.data.tables.length, 6);
  assert.equal(lobby.data.error, '');
  await lobby.table({ currentTarget: { dataset: { id: 1, action: 'join', color: 'red' } } });
  assert.equal(h.calls.filter(call => call.type === 'navigate').at(-1).url, '/chess/pages/game/index?id=game-1');
  assert.deepEqual(plain(h.storage.get('gougeLastGame')), { gameId: 'game-1', userId: 'chess-user' });
  assert.equal(new URL(h.sockets[0].url).searchParams.get('token'), 'chess-token');
  lobby.onHide();
  assert.equal(h.sockets[0].closed, true);
  home.returnTools();
  assert.equal(h.calls.filter(call => call.type === 'relaunch').at(-1).url, '/pages/index/index');
  assert.deepEqual(h.itoState(), before);
  assert.equal(h.hostAccesses, 0);
});

test('game and settings retain the same chess identity and return with navigateBack only to the matching game', hostOptions, async () => {
  const h = hostHarness();
  h.launchHost();
  const before = h.itoState();
  const game = h.page('chess/pages/game/index.js');
  game.onLoad({ id: 'game-1' });
  game.onShow();
  await settle();
  assert.equal(game.data.error, '');
  assert.equal(game.data.game.id, 'game-1');
  assert.equal(game.data.myColor, 'red');
  assert.equal(game.data.cells.length, 90);
  h.sockets[0].open();
  await settle();
  assert.equal(game.data.connection, '已连接');
  assert.ok(h.sockets[0].sent.some(message => message.type === 'subscribe' && message.gameId === 'game-1'));
  game.openSettings();
  assert.equal(h.calls.filter(call => call.type === 'navigate').at(-1).url, '/chess/pages/settings/index?gameId=game-1');
  game.onHide();
  const settings = h.page('chess/pages/settings/index.js');
  await settings.onLoad({ gameId: 'game-1' });
  settings.onShow();
  await settle();
  assert.equal(settings.data.gameError, '');
  assert.equal(settings.data.myColor, 'red');
  assert.equal(settings.data.game.id, 'game-1');
  settings.onHide();
  settings.returnGame();
  assert.deepEqual(h.calls.at(-1), { type: 'back', delta: 1 });
  settings.onUnload();
  game.onShow();
  await settle();
  assert.equal(game.data.game.id, 'game-1');
  assert.equal(h.load('chess/session.js').getChessApp().globalData.token, 'chess-token');
  const otherSettings = h.page('chess/pages/settings/index.js');
  await otherSettings.onLoad({ gameId: 'game-2' });
  otherSettings.returnGame();
  assert.deepEqual(h.calls.at(-1), { type: 'redirect', url: '/chess/pages/game/index?id=game-2' });
  otherSettings.onUnload();
  game.onUnload();
  await settle();
  assert.equal(h.timers.size, 0);
  assert.ok(h.sockets.every(socket => socket.closed));
  assert.deepEqual(h.itoState(), before);
  assert.equal(h.hostAccesses, 0);
});
