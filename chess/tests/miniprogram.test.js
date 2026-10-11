import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import vm from 'node:vm';

const root = resolve('miniprogram');

function clientHarness({ development = false } = {}) {
  const calls = [];
  const storage = new Map();
  const pages = [];
  const app = {
    globalData: { token: 'test-token', user: { id: 'me', name: '家人' }, config: { development } },
    async ensureLogin() { return this.globalData.user; },
    updateUser(user) { this.globalData.user = user; },
    clearSession() { this.globalData.token = ''; this.globalData.user = null; }
  };
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    navigateTo(options) { calls.push({ type: 'navigate', url: options.url }); },
    navigateBack(options) { calls.push({ type: 'back', delta: options.delta }); pages.pop(); },
    redirectTo(options) { calls.push({ type: 'redirect', url: options.url }); },
    reLaunch(options) { calls.push({ type: 'relaunch', url: options.url }); },
    request(options) {
      calls.push({ type: 'http', url: options.url, data: options.data });
      const data = options.url.endsWith('/sign') ? { signature: 'server-signature', nonceStr: 'nonce', timeStamp: 100, groupId: 'table-1' } : { ok: true };
      options.success({ statusCode: 200, data });
    },
    authorize(options) { calls.push({ type: 'authorize', scope: options.scope }); options.success({}); },
    joinVoIPChat(options) { calls.push({ type: 'join', options }); options.success({ openIdList: ['one', 'two'] }); },
    updateVoIPChatMuteConfig(options) { calls.push({ type: 'mute', options }); options.success({}); },
    exitVoIPChat(options) { calls.push({ type: 'exit' }); options.success({}); },
    onVoIPChatMembersChanged() {}, onVoIPChatInterrupted() {},
    offVoIPChatMembersChanged() {}, offVoIPChatInterrupted() {}
  };
  const cache = new Map();
  let pageDefinition;
  const context = {
    wx, getApp: () => app, getCurrentPages: () => pages, Page: page => { pageDefinition = page; }, Component() {},
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, console
  };
  function load(file) {
    file = resolve(file);
    if (!extname(file)) file += '.js';
    if (file === resolve(root, 'config.js')) return { apiBase: 'http://127.0.0.1:8787', development };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      ...context, module, exports: module.exports,
      require: name => load(resolve(dirname(file), name))
    }, { filename: file });
    return module.exports;
  }
  function page(file) {
    load(resolve(root, file));
    const instance = { ...pageDefinition, route: file.replace(/\.js$/, ''), data: structuredClone(pageDefinition.data), setData(patch) { Object.assign(this.data, patch); } };
    pages.push(instance);
    return instance;
  }
  return { load, page, context, calls, app, wx, storage };
}

test('native clock advances only the active player and respects authoritative deadline', () => {
  const harness = clientHarness();
  harness.context.Date = class extends Date { static now() { return 2000; } };
  const { displayClock } = harness.load(resolve(root, 'utils/time.js'));
  const game = {
    status: 'active', turn: 'red', serverNow: 1000,
    clock: {
      deadline: 6000,
      red: { usedMs: 1234, totalRemainingMs: 8000, phase: 'total' },
      black: { usedMs: 3000, totalRemainingMs: 12000, phase: 'total' }
    }
  };
  const clock = displayClock(game, 0);
  assert.equal(clock.red.used, '00:03');
  assert.equal(clock.red.remaining, '00:04');
  assert.equal(clock.red.total, '00:07');
  assert.equal(clock.black.used, '00:03');
  assert.equal(clock.black.total, '00:12');
  assert.equal(clock.black.remaining, '—');
  game.clock.red.totalRemainingMs = 500;
  assert.equal(displayClock(game, 0).red.total, '00:00');
  assert.equal(displayClock(game, 0).red.phase, '超时后每步');
  game.status = 'finished';
  assert.equal(displayClock(game, 0).red.used, '00:02');
});

test('black perspective reverses all 90 intersections without changing move IDs', () => {
  const { load } = clientHarness();
  const { boardCells } = load(resolve(root, 'utils/board.js'));
  const game = { board: Array(90).fill(null), legalMoves: [{ id: '89-80', from: 89, to: 80 }], lastMove: { from: 0, to: 9 } };
  game.board[89] = { id: 'red-rook', color: 'red', type: 'R' };
  game.board[0] = { id: 'black-rook', color: 'black', type: 'R' };
  const cells = boardCells(game, 'black', 89);
  assert.equal(cells.length, 90);
  assert.equal(cells[0].index, 89);
  assert.equal(cells[0].label, '车');
  assert.equal(cells[0].selected, true);
  assert.equal(cells[9].index, 80);
  assert.equal(cells[9].destination, true);
  assert.equal(cells[89].index, 0);
  assert.equal(cells[89].left, 100);
  assert.equal(cells[89].top, 100);
});

test('voice requests real signature, joins muted, then updates mute configuration', async () => {
  const harness = clientHarness();
  const VoiceRoom = harness.load(resolve(root, 'services/voice.js'));
  let state;
  const room = new VoiceRoom('game-1', value => { state = value; });
  await room.join();
  assert.equal(harness.calls[0].type, 'authorize');
  assert.equal(harness.calls[0].scope, 'scope.record');
  const join = harness.calls.find(call => call.type === 'join').options;
  assert.equal(join.roomType, 'voice');
  assert.equal(join.groupId, 'table-1');
  assert.equal(join.signature, 'server-signature');
  assert.equal(join.timeStamp, 100);
  assert.equal(join.muteConfig.muteMicrophone, true);
  assert.equal(join.muteConfig.muteEarphone, false);
  assert.equal(state.joined, true);
  assert.equal(state.microphone, false);
  assert.equal(state.count, 2);
  await room.mute(true, false);
  const mute = harness.calls.find(call => call.type === 'mute').options;
  assert.equal(mute.muteConfig.muteMicrophone, false);
  assert.equal(mute.muteConfig.muteEarphone, true);
  assert.equal(state.microphone, true);
  assert.equal(state.earphone, false);
  await room.destroy();
  assert.equal(state.joined, false);
  assert.ok(harness.calls.some(call => call.type === 'exit'));
  assert.ok(harness.calls.some(call => call.type === 'http' && call.url.endsWith('/api/voice/leave')));
});

test('development login cannot pretend to join WeChat voice', async () => {
  const harness = clientHarness({ development: true });
  const VoiceRoom = harness.load(resolve(root, 'services/voice.js'));
  const room = new VoiceRoom('game-1', () => {});
  await assert.rejects(room.join(), /开发账号不能加入微信语音/);
  assert.equal(room.joined, false);
  assert.equal(harness.calls.length, 0);
});

test('native join failure releases the server reservation and preserves honest state', async () => {
  const harness = clientHarness();
  harness.wx.joinVoIPChat = options => options.fail({ errCode: -2, errMsg: '录音设备被占用' });
  const VoiceRoom = harness.load(resolve(root, 'services/voice.js'));
  const room = new VoiceRoom('game-1', () => {});
  await assert.rejects(room.join(), /录音设备被占用.*-2/);
  assert.equal(room.joined, false);
  assert.ok(harness.calls.some(call => call.type === 'http' && call.url.endsWith('/api/voice/leave')));
});

test('hiding the game stops display and chat, without issuing any clock or game mutation', async () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js');
  page.onLoad({ id: 'game-1' });
  const game = {
    id: 'game-1', tableId: 1, mode: 'pvp', status: 'active', version: 2, turnId: 'turn-1', ownerId: 'me',
    board: Array(90).fill(null), legalMoves: [], history: [], turn: 'black',
    seats: { red: { id: 'other', name: '红方' }, black: { id: 'me', name: '黑方' } },
    ready: { red: true, black: true }, spectators: [], serverNow: Date.now(),
    timeControl: { mode: 'rapid', rapidSeconds: 15 },
    clock: { deadline: Date.now() + 15000, red: { usedMs: 2000, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 3000, totalRemainingMs: null, phase: 'rapid' } }
  };
  page.visible = true;
  page.render(game);
  assert.equal(page.data.perspective, 'black');
  assert.equal(page.data.myColor, 'black');
  let chatStopped = 0;
  const stopChat = page.chatRoom.stop.bind(page.chatRoom);
  page.chatRoom.stop = () => { chatStopped++; stopChat(); };
  const original = JSON.stringify(page.data.game);
  let stopped = false;
  page.socket = { stop() { stopped = true; } };
  page.onHide();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(page.visible, false);
  assert.equal(chatStopped, 1);
  assert.equal(JSON.stringify(page.data.game), original);
  assert.equal(harness.calls.some(call => call.type === 'exit' || call.type === 'authorize'), false);
  assert.ok(harness.calls.every(call => call.type !== 'http' || call.url.endsWith('/chat')));
  page.onUnload();
});

test('draw action sheet binds negotiation and natural-limit claims to separate actions', () => {
  const harness = clientHarness();
  const page = harness.page('pages/settings/index.js');
  page.data.game = { status: 'active' };
  page.data.spectator = false;
  const actions = [];
  page.action = (type, extras) => actions.push({ type, extras });
  harness.wx.showActionSheet = options => options.success({ tapIndex: 0 });
  page.draw();
  harness.wx.showActionSheet = options => options.success({ tapIndex: 1 });
  page.draw();
  assert.equal(actions[0].type, 'draw-request');
  assert.equal(actions[1].type, 'draw-claim');
  page.data.spectator = true;
  page.draw();
  assert.equal(actions.length, 2);
});

test('draw response sends request ID and boolean choice, and tolerates absent draw state', () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js');
  page.data.game = { draw: { id: 'draw-1', requesterId: 'other' } };
  page.data.spectator = false;
  const actions = [];
  page.action = (type, extras) => actions.push({ type, extras });
  page.drawRespond({ currentTarget: { dataset: { accept: 'true' } } });
  page.drawRespond({ currentTarget: { dataset: { accept: 'false' } } });
  assert.equal(actions[0].type, 'draw-respond');
  assert.equal(actions[0].extras.requestId, 'draw-1');
  assert.equal(actions[0].extras.accept, true);
  assert.equal(actions[1].extras.accept, false);
  page.data.game = {};
  page.drawRespond({ currentTarget: { dataset: { accept: true } } });
  page.data.game.draw = { id: 'draw-2' };
  page.data.spectator = true;
  page.drawRespond({ currentTarget: { dataset: { accept: true } } });
  assert.equal(actions.length, 2);
});

function sampleGame(patch = {}) {
  const now = Date.now();
  return Object.assign({
    id: 'game-1', tableId: null, mode: 'ai', status: 'active', version: 1, turnId: 'turn-1', ownerId: 'me',
    board: Array(90).fill(null), legalMoves: [], history: [], turn: 'red',
    seats: { red: { id: 'me', name: '家人' }, black: { id: 'ai', name: '狗哥 AI' } },
    ready: { red: true, black: true }, spectators: [], serverNow: now,
    timeControl: { mode: 'rapid', rapidSeconds: 15 },
    clock: { deadline: now + 15000, red: { usedMs: 0, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 0, totalRemainingMs: null, phase: 'rapid' } }
  }, patch);
}

test('home restores active games and removes finished, forbidden, or other-account records', async () => {
  const harness = clientHarness();
  const home = harness.page('pages/index/index.js');
  harness.storage.set('gougeLastGame', { gameId: 'game-1', userId: 'me' });
  let response = { statusCode: 200, data: { game: sampleGame() } };
  harness.wx.request = options => options.success(response);
  await home.onShow();
  assert.equal(home.data.recentGame.gameId, 'game-1');
  assert.equal(home.data.recentGame.statusText, '对局仍在计时');
  home.continueGame();
  assert.ok(harness.calls.some(call => call.type === 'navigate' && call.url.endsWith('id=game-1')));
  response = { statusCode: 200, data: { game: sampleGame({ status: 'finished' }) } };
  await home.onShow();
  assert.equal(home.data.recentGame, null);
  assert.equal(harness.storage.has('gougeLastGame'), false);
  harness.storage.set('gougeLastGame', { gameId: 'game-1', userId: 'me' });
  response = { statusCode: 403, data: { error: '不是该棋局成员', code: 'NOT_MEMBER' } };
  await home.onShow();
  assert.equal(harness.storage.has('gougeLastGame'), false);
  harness.storage.set('gougeLastGame', { gameId: 'game-1', userId: 'me' });
  harness.app.globalData.user = { id: 'another', name: '另一位家人' };
  await home.onShow();
  assert.equal(home.data.recentGame, null);
  assert.equal(harness.storage.has('gougeLastGame'), false);
});

test('authenticated game snapshots remember the own game, retain it on hide, and clear it on finish', async () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js');
  page.onLoad({ id: 'game-1' });
  let game = sampleGame();
  harness.wx.request = options => options.success({ statusCode: 200, data: options.url.includes('/api/games/') ? { game } : { ok: true } });
  page.visible = true;
  await page.refresh();
  assert.equal(harness.storage.get('gougeLastGame').gameId, 'game-1');
  assert.equal(harness.storage.get('gougeLastGame').userId, 'me');
  page.onHide();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.storage.get('gougeLastGame').gameId, 'game-1');
  game = sampleGame({ status: 'finished', version: 2, outcome: { winner: 'red', reason: '认输', rule: '认输' } });
  await page.refresh();
  assert.equal(harness.storage.has('gougeLastGame'), false);
  page.onUnload();
});

test('logout preserves an active development identity and refuses to discard it on network failure', async () => {
  const harness = clientHarness({ development: true });
  const settings = harness.page('pages/settings/index.js');
  settings.data.development = true;
  harness.storage.set('gougeLastGame', { gameId: 'game-1', userId: 'me' });
  harness.wx.request = options => options.success({ statusCode: 200, data: { game: sampleGame() } });
  harness.wx.showModal = options => {
    harness.calls.push({ type: 'modal', content: options.content });
    options.success({ confirm: false });
  };
  await settings.logout();
  assert.equal(harness.app.globalData.user.id, 'me');
  assert.equal(harness.storage.has('gougeLastGame'), true);
  assert.ok(harness.calls.some(call => call.type === 'modal' && call.content.includes('认输')));
  assert.equal(harness.calls.some(call => call.type === 'relaunch'), false);
  harness.wx.request = options => options.fail({ errMsg: 'network down' });
  await settings.logout();
  assert.equal(harness.app.globalData.user.id, 'me');
  assert.match(settings.data.error, /未能确认当前棋局/);
  harness.wx.request = options => options.success({ statusCode: 200, data: { game: sampleGame({ status: 'finished' }) } });
  await settings.logout();
  assert.equal(harness.app.globalData.user, null);
  assert.equal(harness.storage.has('gougeLastGame'), false);
  assert.ok(harness.calls.some(call => call.type === 'relaunch'));
});

test('saved time and move sound preferences affect AI defaults without microphone access', async () => {
  const harness = clientHarness();
  const settings = harness.page('pages/settings/index.js');
  const custom = { mode: 'rapid', rapidSeconds: 7, perMoveSeconds: 30, totalSeconds: 900, overtimeSeconds: 10 };
  settings.control({ detail: { value: custom } });
  settings.moveSound({ detail: { value: true } });
  const ai = harness.page('pages/ai/index.js');
  ai.onLoad();
  assert.equal(ai.data.control.rapidSeconds, 7);
  assert.equal(ai.data.control.totalSeconds, 900);
  assert.equal(harness.storage.get('gougePreferences').moveSound, true);
  assert.equal(harness.calls.some(call => call.type === 'join' || call.type === 'authorize'), false);
});

test('move sound plays only for new confirmed history and is released when hidden', () => {
  const harness = clientHarness();
  harness.storage.set('gougePreferences', { moveSound: true });
  let played = 0, destroyed = 0;
  const audio = { src: '', stop() {}, play() { played++; }, destroy() { destroyed++; }, onError() {} };
  harness.wx.createInnerAudioContext = () => audio;
  const page = harness.page('pages/game/index.js');
  page.onLoad({ id: 'game-1' });
  page.visible = true;
  page.setupAudio();
  page.allowMoveSound = true;
  page.render(sampleGame());
  assert.equal(played, 0);
  const history = [{ move: { from: 54, to: 45 }, color: 'red', source: 'human' }];
  page.render(sampleGame({ version: 2, history }));
  assert.equal(played, 1);
  page.render(sampleGame({ version: 2, history }));
  assert.equal(played, 1);
  page.render(sampleGame({ version: 3, history: [] }));
  assert.equal(played, 1);
  assert.equal(audio.src, '/assets/move.wav');
  page.onHide();
  assert.equal(destroyed, 1);
  assert.equal(page.audio, null);
  assert.equal(page.allowMoveSound, false);
  page.onUnload();
});

test('default move sound stays off and changing preferences never requests microphone access', () => {
  const harness = clientHarness();
  let created = 0;
  harness.wx.createInnerAudioContext = () => { created++; };
  const page = harness.page('pages/game/index.js');
  page.onLoad({ id: 'game-1' });
  page.setupAudio();
  assert.equal(created, 0);
  const settings = harness.page('pages/settings/index.js');
  settings.moveSound({ detail: { value: true } });
  assert.equal(harness.calls.some(call => call.type === 'authorize'), false);
  page.onUnload();
});

test('settings round trip keeps the same game, player identity, deadline, and latest authoritative board', async () => {
  const harness = clientHarness(); let now = 100000;
  harness.context.Date = class extends Date { static now() { return now; } };
  let snapshot = sampleGame({ serverNow: now, clock: { deadline: 115000,
    red: { usedMs: 4000, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 5000, totalRemainingMs: null, phase: 'rapid' } } });
  harness.wx.request = options => {
    harness.calls.push({ type: 'http', url: options.url, data: options.data });
    options.success({ statusCode: 200, data: options.url.endsWith('/api/me') ? { user: harness.app.globalData.user } : { game: snapshot } });
  };
  const game = harness.page('pages/game/index.js'); game.onLoad({ id: 'game-1' }); game.visible = true; game.render(snapshot);
  const initial = JSON.stringify(game.data.game);
  game.openSettings(); game.onHide();
  assert.ok(harness.calls.some(call => call.type === 'navigate' && call.url === '/pages/settings/index?gameId=game-1'));
  assert.equal(JSON.stringify(game.data.game), initial);
  const settings = harness.page('pages/settings/index.js'); await settings.onLoad({ gameId: 'game-1' }); settings.visible = true;
  await settings.refreshGame();
  assert.equal(settings.data.game.id, 'game-1'); assert.equal(settings.data.myColor, 'red');
  assert.equal(settings.data.game.clock.deadline, 115000);
  now += 2000; settings.tickGame();
  assert.equal(settings.data.clock.red.used, '00:06'); assert.equal(settings.data.clock.red.remaining, '00:13');
  assert.equal(settings.data.clock.black.used, '00:05');
  settings.flip();
  assert.equal(settings.data.perspective, 'red');
  const board = Array(90).fill(null); board[45] = { id: 'red-P-0', type: 'P', color: 'red' };
  snapshot = sampleGame({ serverNow: now, version: 2, turn: 'black', board,
    history: [{ move: { from: 54, to: 45 }, color: 'red', source: 'human', at: now, captured: null }], clock: snapshot.clock });
  await settings.refreshGame();
  settings.returnGame(); settings.onUnload(); game.visible = true; await game.refresh();
  assert.ok(harness.calls.some(call => call.type === 'back' && call.delta === 1));
  assert.equal(game.data.game.id, 'game-1'); assert.equal(game.data.myColor, 'red'); assert.equal(game.data.perspective, 'red');
  assert.equal(game.data.cells.find(cell => cell.index === 45).piece.id, 'red-P-0');
  assert.equal(game.data.game.history.length, 1); assert.equal(game.data.game.clock.deadline, 115000);
  assert.equal(harness.calls.some(call => call.type === 'http' && /\/action$|\/tables\//.test(call.url)), false);
  game.onUnload();
});

test('settings auxiliary actions retain spectator, self-approval, expiry, and authoritative version guards', async () => {
  const harness = clientHarness(); let now = 100000;
  harness.context.Date = class extends Date { static now() { return now; } };
  const settings = harness.page('pages/settings/index.js'); settings.gameId = 'game-1'; settings.visible = true;
  const game = sampleGame({ serverNow: now, version: 7, turnId: 'settings-turn',
    history: [{ move: { from: 54, to: 45 }, color: 'red', source: 'human', at: now }] });
  const posts = [];
  harness.wx.request = options => { posts.push(options); options.success({ statusCode: 200, data: { game } }); };
  settings.renderGame(game);
  settings.data.spectator = true; await settings.undo(); await settings.action('draw-request'); await settings.ready();
  assert.equal(posts.length, 0);
  settings.data.spectator = false;
  settings.data.game.undo = { id: 'own-request', requesterId: 'me', expiresAt: now + 15000 };
  await settings.undoRespond({ currentTarget: { dataset: { accept: true } } });
  settings.data.game.undo = { id: 'expired-request', requesterId: 'other', expiresAt: now };
  await settings.undoRespond({ currentTarget: { dataset: { accept: true } } });
  assert.equal(posts.length, 0);
  settings.data.game.undo = { id: 'valid-request', requesterId: 'other', expiresAt: now + 15000 };
  await settings.undoRespond({ currentTarget: { dataset: { accept: 'true' } } });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data.type, 'undo-respond'); assert.equal(posts[0].data.requestId, 'valid-request');
  assert.equal(posts[0].data.accept, true); assert.equal(posts[0].data.version, 7); assert.equal(posts[0].data.turnId, 'settings-turn');
  assert.ok(posts[0].data.operationId);
  settings.data.game.undo = null;
  settings.data.game.draw = { id: 'draw-request', requesterId: 'other', expiresAt: now + 15000 };
  await settings.drawRespond({ currentTarget: { dataset: { accept: 'false' } } });
  assert.equal(posts[1].data.type, 'draw-respond'); assert.equal(posts[1].data.accept, false);
  settings.onUnload();
});

test('waiting-game timing drafts and orientation are scoped to game and identity without altering an active deadline', async () => {
  const harness = clientHarness(); const settings = harness.page('pages/settings/index.js'); settings.gameId = 'game-1';
  const game = sampleGame({ status: 'waiting', ready: { red: false, black: false } });
  settings.renderGame(game);
  const control = { mode: 'rapid', rapidSeconds: 3, perMoveSeconds: 30, totalSeconds: null, overtimeSeconds: 10 };
  settings.gameControl({ detail: { value: control } }); settings.flip();
  assert.equal(harness.storage.get('gougeGameControl').gameId, 'game-1');
  assert.equal(harness.storage.get('gougeGameControl').userId, 'me');
  assert.equal(harness.storage.get('gougeGamePerspective'), undefined);
  assert.equal(settings.data.perspective, 'red');
  const active = sampleGame({ version: 2 }); const deadline = active.clock.deadline;
  settings.renderGame(active); settings.gameControl({ detail: { value: { ...control, rapidSeconds: 99 } } });
  assert.equal(settings.data.game.clock.deadline, deadline);
  assert.equal(harness.storage.get('gougeGameControl').control.rapidSeconds, 3);
  harness.app.globalData.user = { id: 'other' };
  settings.renderGame({ ...active, version: 3 });
  assert.equal(settings.data.spectator, true); assert.equal(settings.data.perspective, 'red');
  settings.flip();
  assert.equal(harness.storage.get('gougeGamePerspective').gameId, 'game-1');
  assert.equal(harness.storage.get('gougeGamePerspective').userId, 'other');
  assert.equal(settings.data.perspective, 'black');
  harness.app.globalData.user = { id: 'me' }; settings.renderGame({ ...active, version: 4 });
  assert.equal(settings.data.perspective, 'red');
  settings.onUnload();
});

test('main resign requires confirmation, uses the latest action version, and rejects nonplayers or inactive games', async () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'game-1' }); page.visible = true;
  const game = sampleGame({ mode: 'pvp', tableId: 1 }); page.render(game);
  const posts = [];
  harness.wx.request = options => {
    posts.push(options);
    options.success({ statusCode: 200, data: { game: { ...page.data.game, status: 'finished', version: 3, outcome: { winner: 'black', reason: '认输', rule: '认输' } } } });
  };
  harness.wx.showModal = options => options.success({ confirm: false });
  await page.resign();
  assert.equal(posts.length, 0);
  let confirm;
  harness.wx.showModal = options => { confirm = options.success; };
  const resigning = page.resign();
  page.render({ ...game, version: 2, turnId: 'latest-turn' });
  confirm({ confirm: true }); await resigning;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data.type, 'resign'); assert.equal(posts[0].data.version, 2);
  assert.equal(posts[0].data.turnId, 'latest-turn'); assert.ok(posts[0].data.operationId);
  assert.equal(page.data.game.status, 'finished'); assert.equal(harness.storage.has('gougeLastGame'), false);
  let modals = 0;
  harness.wx.showModal = () => { modals++; };
  await page.resign();
  page.render({ ...game, version: 4, status: 'waiting', ready: { red: false, black: false } }); await page.resign();
  page.render({ ...game, version: 5, seats: { red: { id: 'other' }, black: { id: 'another' } } }); await page.resign();
  assert.equal(modals, 0); assert.equal(posts.length, 1);
  page.onUnload();
});

test('active main leave cancellation keeps chat and game, confirmation stops chat and retains the recoverable game', async () => {
  for (const mode of ['pvp', 'ai']) {
    const harness = clientHarness();
    const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'game-1' }); page.visible = true;
    const game = sampleGame({ mode, tableId: mode === 'pvp' ? 1 : null }); page.render(game);
    const authority = JSON.stringify(page.data.game);
    let stopped = 0;
    const stopChat = page.chatRoom.stop.bind(page.chatRoom);
    page.chatRoom.stop = () => { stopped++; stopChat(); };
    harness.wx.showModal = options => {
      assert.match(options.content, /计时继续/); assert.match(options.content, /旧局会自动判负/);
      options.success({ confirm: false });
    };
    await page.leaveTable();
    assert.equal(stopped, 0); assert.equal(harness.calls.some(call => call.type === 'relaunch'), false);
    harness.wx.showModal = options => options.success({ confirm: true });
    await page.leaveTable();
    assert.equal(stopped, 1);
    assert.equal(harness.storage.get('gougeLastGame').gameId, 'game-1');
    assert.equal(JSON.stringify(page.data.game), authority);
    assert.ok(harness.calls.every(call => call.type !== 'http' || call.url.endsWith('/chat')));
    assert.ok(harness.calls.some(call => call.type === 'relaunch' && call.url === '/pages/index/index'));
    page.onUnload();
  }
});

test('waiting, finished, and spectator main leave release only the applicable table membership', async () => {
  for (const scenario of ['waiting', 'finished', 'spectator']) {
    const harness = clientHarness();
    const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'game-1' }); page.visible = true;
    const game = sampleGame({ mode: 'pvp', tableId: 2, status: scenario === 'spectator' ? 'active' : scenario,
      seats: scenario === 'spectator' ? { red: { id: 'other' }, black: { id: 'another' } } : sampleGame().seats });
    page.render(game);
    let stopped = 0; const stopChat = page.chatRoom.stop.bind(page.chatRoom);
    page.chatRoom.stop = () => { stopped++; stopChat(); };
    harness.wx.showModal = () => { assert.fail('Waiting, finished and spectator leave need no active-player warning'); };
    await page.leaveTable();
    assert.equal(stopped, 1);
    const leaves = harness.calls.filter(call => call.type === 'http' && call.url.endsWith('/api/tables/2/leave'));
    assert.equal(leaves.length, 1); assert.equal(leaves[0].data.gameId, game.id);
    assert.equal(harness.storage.has('gougeLastGame'), false);
    assert.ok(harness.calls.some(call => call.type === 'relaunch'));
    page.onUnload();
    assert.equal(harness.calls.filter(call => call.type === 'http' && call.url.endsWith('/api/tables/2/leave')).length, 1);
  }
});

test('failed membership leave keeps the current game and permits retry', async () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'game-1' }); page.visible = true;
  page.render(sampleGame({ mode: 'pvp', tableId: 1, status: 'waiting' }));
  harness.wx.request = options => options.fail({ errMsg: '暂时不能离桌' });
  await page.leaveTable();
  assert.match(page.data.error, /暂时不能离桌/);
  assert.equal(page.data.busy, false); assert.equal(page.data.game.id, 'game-1');
  assert.equal(harness.calls.some(call => call.type === 'relaunch'), false);
  page.onUnload();
});

test('settings leave matches main leave: active player keeps the seat; waiting and spectators release membership', async () => {
  for (const scenario of ['active', 'waiting', 'spectator']) {
    const harness = clientHarness();
    const settings = harness.page('pages/settings/index.js'); settings.gameId = 'game-1';
    settings.renderGame(sampleGame({ mode: 'pvp', tableId: 1, status: scenario === 'spectator' ? 'active' : scenario,
      seats: scenario === 'spectator' ? { red: { id: 'other' }, black: { id: 'another' } } : sampleGame().seats }));
    await settings.leaveTable();
    const requests = harness.calls.filter(call => call.type === 'http');
    assert.equal(requests.length, scenario === 'active' ? 0 : 1);
    if (requests.length) assert.equal(requests[0].data.gameId, 'game-1');
    assert.equal(harness.storage.has('gougeLastGame'), scenario === 'active');
    assert.ok(harness.calls.some(call => call.type === 'relaunch'));
    settings.onUnload();
  }
});

test('finished result seats preserve original player names without granting released-seat actions or affecting active display', async () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'game-1' }); page.visible = true;
  const resultSeats = { red: { id: 'me', name: '原红方' }, black: { id: 'old-black', name: '原黑方' } };
  const finished = sampleGame({ status: 'finished', seats: { red: null, black: null }, resultSeats });
  page.render(finished);
  assert.equal(page.data.bottomPlayer.name, '原红方'); assert.equal(page.data.topPlayer.name, '原黑方');
  assert.equal(page.data.myColor, ''); assert.equal(page.data.spectator, true);
  harness.wx.showModal = () => { assert.fail('Released-seat historical players cannot resign'); };
  await page.resign();
  const settings = harness.page('pages/settings/index.js'); settings.gameId = 'game-1'; settings.renderGame(finished);
  assert.equal(settings.data.historyPlayers.red.name, '原红方'); assert.equal(settings.data.historyPlayers.black.name, '原黑方');
  assert.equal(settings.data.myColor, ''); assert.equal(settings.data.spectator, true);
  const active = sampleGame({ version: 2, resultSeats });
  page.render(active); settings.renderGame(active);
  assert.equal(page.data.bottomPlayer.name, '家人'); assert.equal(page.data.topPlayer.name, '狗哥 AI');
  assert.equal(settings.data.historyPlayers.red.name, '家人'); assert.equal(page.data.myColor, 'red');
  settings.onUnload(); page.onUnload();
});

test('unloading an old finished game targets its exact ID rather than a newer game on the same table', () => {
  const harness = clientHarness();
  const page = harness.page('pages/game/index.js'); page.onLoad({ id: 'old-game' }); page.visible = true;
  page.render(sampleGame({ id: 'old-game', tableId: 3, mode: 'pvp', status: 'finished', seats: { red: null, black: null },
    resultSeats: { red: { id: 'me', name: '原红方' }, black: { id: 'other', name: '原黑方' } } }));
  page.onUnload();
  const leaves = harness.calls.filter(call => call.type === 'http' && call.url.endsWith('/api/tables/3/leave'));
  assert.equal(leaves.length, 1); assert.equal(leaves[0].data.gameId, 'old-game');
});
