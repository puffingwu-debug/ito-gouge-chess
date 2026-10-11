import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';
import { createInitialBoard, createHistoryEntry, getLegalMoves } from '../core/xiangqi.js';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const options = { skip: !existsSync(resolve(host, 'chess/session.js')) && 'Set ITO_HOST_ROOT to test the integrated chess module' };
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function snapshots() {
  let board = createInitialBoard(), history = [];
  const result = [];
  for (let index = 0; index < 4; index++) {
    const turn = index % 2 ? 'black' : 'red';
    result.push({ id: 'host-game', tableId: 1, mode: 'pvp', status: 'active', version: index + 1, turnId: 'turn-' + index,
      board, history, turn, legalMoves: getLegalMoves(board, turn), lastMove: history.at(-1)?.move || null,
      ownerId: 'me', seats: { red: { id: 'me', name: '棋友' }, black: { id: 'other', name: '家人' } },
      ready: { red: true, black: true }, spectators: [], serverNow: 100000, undo: null, draw: null,
      timeControl: { mode: 'rapid', rapidSeconds: 15 },
      clock: { deadline: 115000, red: { usedMs: 200, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 300, totalRemainingMs: null, phase: 'rapid' } } });
    const move = index === 0 ? { from: 70, to: 7 } : index === 1 ? { from: 8, to: 7 } : getLegalMoves(board, turn)[0];
    const entry = createHistoryEntry(board, move, turn);
    history = history.concat({ move: entry.move, color: turn, captured: board[move.to] || null, source: 'human', at: 100000 + index });
    board = entry.boardAfter;
  }
  return result;
}

function harness() {
  let now = 100000, timerId = 0;
  const config = { apiBase: 'http://127.0.0.1:8787', development: false };
  const storage = new Map([
    ['gougeSession', { token: 'chess-only-token', user: { id: 'me', name: '棋友' }, ...config }],
    ['itoSettings', { marker: 'host-state-must-survive' }]
  ]);
  const calls = [], voiceStates = [], pages = [], timers = new Map(), definitions = new Map(), cache = new Map();
  const h = { game: snapshots()[0], calls, storage, voiceStates, pages };
  const wx = h.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 753, screenHeight: 844, safeArea: { bottom: 810 } }),
    navigateTo: ({ url }) => calls.push({ type: 'navigate', url }),
    redirectTo: ({ url }) => calls.push({ type: 'redirect', url }),
    reLaunch: ({ url }) => calls.push({ type: 'relaunch', url }),
    navigateBack: ({ delta }) => { calls.push({ type: 'back', delta }); pages.splice(-delta, delta); },
    showModal: options => options.success({ confirm: true }),
    request(options) {
      calls.push({ type: 'http', url: options.url, data: plain(options.data || {}), header: plain(options.header) });
      const path = new URL(options.url).pathname;
      const data = path === '/api/me' ? { user: { id: 'me', name: '棋友' } } : path === '/api/voice/sign' ?
        { signature: 'mock-signature', nonceStr: 'mock-nonce', timeStamp: 100, groupId: 'host-game' } :
        path === '/api/voice/heartbeat' ? { ok: true, serverNow: now, expiresAt: now + 45000, leaseSeconds: 45 } :
        path.startsWith('/api/games/') ? { game: h.game } : { ok: true };
      options.success({ statusCode: 200, data });
    },
    authorize(options) { calls.push({ type: 'authorize' }); options.success({}); },
    joinVoIPChat(options) { calls.push({ type: 'join', options }); options.success({ openIdList: ['me', 'other'] }); },
    updateVoIPChatMuteConfig(options) { calls.push({ type: 'mute', options }); options.success({}); },
    exitVoIPChat(options) { calls.push({ type: 'exit' }); options.success({}); },
    onVoIPChatMembersChanged() {}, offVoIPChatMembersChanged() {},
    onVoIPChatInterrupted() {}, offVoIPChatInterrupted() {}
  };
  function schedule(fn, delay, interval = 0) { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval }); return id; }
  function load(file) {
    file = resolve(file); if (!extname(file)) file += '.js';
    if (file === resolve(host, 'chess/config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, exports: module.exports, wx, console,
      getApp() { throw new Error('Integrated chess must not access the host App'); },
      getCurrentPages: () => pages,
      Page: definition => definitions.set(file, definition),
      require: name => load(resolve(dirname(file), name)),
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
      setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id)
    }, { filename: file });
    return module.exports;
  }
  h.page = name => {
    const file = resolve(host, 'chess/pages', name, 'index.js'); load(file);
    const definition = definitions.get(file);
    const page = { ...definition, route: 'chess/pages/' + name + '/index', data: structuredClone(definition.data),
      setData(patch, callback) { Object.assign(this.data, patch); if (patch.voice) voiceStates.push(plain(patch.voice)); callback?.(); },
      createSelectorQuery() {
        const q = { select() { return { boundingClientRect: () => q }; }, exec(callback) {
          callback([{ left: 10, top: 100, width: 351, height: 480 }, { left: 35, top: 190, width: 300, height: 337.5 }]);
        } }; return q;
      } };
    pages.push(page);
    return page;
  };
  h.gamePage = () => { const page = h.page('game'); page.onLoad({ id: h.game.id }); page.visible = true; page.render(h.game); page.setData({ connection: '已连接' }); return page; };
  h.app = () => load(resolve(host, 'chess/session.js')).getChessApp();
  h.advance = ms => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
      timer.fn();
    }
    now = until;
  };
  h.assertHostUnchanged = () => assert.deepEqual(storage.get('itoSettings'), { marker: 'host-state-must-survive' });
  return h;
}

test('integrated capture completes fly-away and fade, clocks advance, and hide cancels queued snapshots', options, async () => {
  const h = harness(), states = snapshots(), page = h.gamePage();
  page.render(states[1]); const authority = JSON.stringify(page.data.game);
  h.advance(660); assert.equal(page.data.motion.phase, 'fly-away');
  assert.ok(page.data.motion.flyPoint.x < 0 || page.data.motion.flyPoint.x > 351);
  h.advance(290); assert.equal(page.data.motion.phase, 'fade'); assert.equal(page.data.motion.flyOpacity, 0);
  h.advance(90); assert.equal(page.data.motion, null);
  assert.equal(page.data.cells.find(cell => cell.index === 7).piece.id, 'red-C-7');
  page.tick(); assert.equal(page.data.clock.black.used, '00:02'); assert.equal(page.data.clock.black.remaining, '00:14');
  assert.equal(JSON.stringify(page.data.game), authority);
  page.render(states[2]); page.render(states[3]); page.render(structuredClone(states[3]));
  assert.equal(page.motionQueue.length, 1);
  page.onHide(); h.advance(5000); assert.equal(page.data.motion, null); assert.equal(page.motionQueue.length, 0);
  for (let index = 0; index < 90; index++) assert.equal(page.data.cells.find(cell => cell.index === index).piece?.id || null, states[3].board[index]?.id || null);
  page.onUnload(); await settle(); h.assertHostUnchanged();
});

test('integrated settings keep deadline, latest board, identity and perspective; leave preserves active game and targets waiting game ID', options, async () => {
  const h = harness(), page = h.gamePage(); page.openSettings(); page.onHide();
  const settings = h.page('settings'); await settings.onLoad({ gameId: h.game.id }); settings.visible = true; await settings.refreshGame();
  h.advance(2000); settings.tickGame();
  assert.equal(settings.data.clock.red.remaining, '00:13'); assert.equal(settings.data.game.clock.deadline, 115000);
  settings.flip(); assert.equal(settings.data.perspective, 'red'); h.game = { ...snapshots()[1], serverNow: 102000 }; await settings.refreshGame();
  settings.returnGame(); assert.deepEqual(h.calls.at(-1), { type: 'back', delta: 1 }); settings.onUnload();
  page.visible = true; await page.refresh();
  assert.equal(page.data.game.id, 'host-game'); assert.equal(page.data.myColor, 'red'); assert.equal(page.data.perspective, 'red');
  assert.equal(page.data.game.clock.deadline, 115000); assert.equal(page.data.cells.find(cell => cell.index === 7).piece.id, 'red-C-7');
  assert.equal(h.calls.some(call => call.type === 'http' && call.url.endsWith('/action')), false);
  await page.leaveTable();
  assert.equal(h.calls.at(-1).url, '/chess/pages/index/index');
  assert.deepEqual(plain(h.storage.get('gougeLastGame')), { gameId: 'host-game', userId: 'me' });
  assert.equal(h.calls.some(call => call.type === 'http' && /\/tables\/\d+\/leave$/.test(call.url)), false);
  page.visible = true; h.game = { ...h.game, status: 'waiting', version: 3 }; page.render(h.game); await page.leaveTable();
  assert.deepEqual(h.calls.find(call => call.type === 'http' && call.url.endsWith('/tables/1/leave')).data, { gameId: 'host-game' });
  assert.equal(h.storage.has('gougeLastGame'), false);
  page.onUnload(); await settle(); h.assertHostUnchanged();
});
