import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import vm from 'node:vm';
import { createInitialBoard, createHistoryEntry, getLegalMoves } from '../core/xiangqi.js';

const standalone = resolve('miniprogram');
const integrated = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包', 'chess');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(root, userId = 'me', mode = 'pvp') {
  let now = 100000, definition, timerId = 0;
  const timers = new Map(), storage = new Map(), cache = new Map();
  const h = { rooms: [], sent: [], actions: [], voiceCalls: 0 };
  h.app = { globalData: { token: 'test-session', user: { id: userId }, config: { development: false } }, ensureLogin: async () => h.app.globalData.user };
  h.game = { id: 'chat-game', tableId: 1, mode, status: 'active', version: 1, turnId: 'first-turn', turn: 'red',
    board: createInitialBoard(), history: [], lastMove: null, legalMoves: getLegalMoves(createInitialBoard(), 'red'),
    ownerId: 'me', seats: { red: { id: 'me', name: '红方' }, black: { id: 'other', name: '黑方' } },
    spectators: [{ id: 'watcher', name: '观棋家人' }], ready: { red: true, black: true }, serverNow: now,
    timeControl: { mode: 'rapid', rapidSeconds: 15 },
    clock: { deadline: 115000, red: { usedMs: 0, phase: 'rapid', totalRemainingMs: null }, black: { usedMs: 0, phase: 'rapid', totalRemainingMs: null } } };
  class ChatRoom {
    constructor(id, options) { this.id = id; this.options = options; this.starts = 0; this.stops = 0; h.rooms.push(this); }
    start() { this.starts++; }
    stop() { this.stops++; }
    refresh() { return Promise.resolve(); }
    send(body) { h.sent.push(plain(body)); return h.sendError ? Promise.reject(new Error(h.sendError)) : Promise.resolve(); }
    state(patch) { this.options.onState(patch); }
    incoming(messages, fresh) { this.state({ messages, ready: true, busy: false, error: '' }); if (fresh) this.options.onNew(fresh); }
  }
  class GameSocket {
    constructor(options) { this.options = options; }
    start() { this.options.onStatus('实时连接中断，已改为定时刷新'); }
    stop() {}
  }
  const api = { userView: user => user, errorText: error => error.message,
    request: async (path, method, body) => { h.actions.push({ path, method, body }); return { game: h.game }; } };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 753, screenHeight: 844, safeArea: { bottom: 810 } }),
    navigateTo() {}, reLaunch() {}, showModal: options => options.success({ confirm: true }),
    authorize() { h.voiceCalls++; }, joinVoIPChat() { h.voiceCalls++; },
    updateVoIPChatMuteConfig() { h.voiceCalls++; }, exitVoIPChat() { h.voiceCalls++; }
  };
  function schedule(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; }
  function load(file) {
    file = resolve(file); if (!extname(file)) file += '.js';
    if (file === resolve(root, 'services/chat.js')) return ChatRoom;
    if (file === resolve(root, 'services/socket.js')) return GameSocket;
    if (file === resolve(root, 'services/api.js')) return api;
    if (file === resolve(root, 'session.js')) return { getChessApp: () => h.app };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, wx,
      require: name => load(resolve(dirname(file), name)), getApp: () => h.app, Page: page => { definition = page; },
      Date: class extends Date { static now() { return now; } },
      setTimeout: schedule, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, console }, { filename: file });
    return module.exports;
  }
  load(resolve(root, 'pages/game/index.js'));
  h.page = { ...definition, data: structuredClone(definition.data),
    setData(patch, callback) { Object.assign(this.data, patch); callback?.(); },
    createSelectorQuery() { const query = { select() { return { boundingClientRect: () => query }; },
      exec(callback) { callback([{ left: 10, top: 100, width: 351, height: 480 }, { left: 35, top: 190, width: 300, height: 337.5 }]); } }; return query; } };
  h.page.onLoad({ id: h.game.id }); h.page.onShow();
  h.advance = milliseconds => {
    const until = now + milliseconds;
    for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].callback(); }
    now = until;
  };
  return h;
}

const message = (seq, userId = 'other', text = '这一手下得好') => ({ id: 'message-' + seq, seq, userId, name: userId === 'me' ? '红方' : '家人', text, kind: 'text', at: 100000 + seq });

for (const root of [standalone, integrated]) {
  const label = root === standalone ? 'standalone' : 'integrated';
  const options = { skip: !existsSync(root) };
  test(`${label} player and spectator chat receives and sends without a connected websocket or microphone`, options, async () => {
    for (const userId of ['me', 'watcher']) {
      const h = harness(root, userId); await settle();
      assert.ok(h.rooms[0], 'game page creates a ChatRoom');
      const room = h.rooms[0]; assert.equal(room.starts, 1); assert.match(h.page.data.connection, /定时刷新/);
      room.incoming([message(1)]); assert.equal(h.page.data.chatMessages.length, 1); assert.equal(h.page.data.subtitle, null);
      room.incoming([message(1), message(2)], [message(2)]); assert.equal(h.page.data.chatUnread, 1);
      h.page.toggleChat(); assert.equal(h.page.data.chatOpen, true); assert.equal(h.page.data.chatUnread, 0);
      h.page.chatInput({ detail: { value: '和家人聊两句' } }); await h.page.sendChat();
      assert.deepEqual(h.sent, [{ text: '和家人聊两句' }]); assert.equal(h.page.data.chatDraft, '');
      h.page.render(h.game); assert.equal(room.starts, 1); assert.equal(h.voiceCalls, 0);
      h.page.onUnload();
    }
  });
  test(`${label} hidden, unloaded and replaced sessions reject late chat state and subtitles`, options, async () => {
    const h = harness(root); await settle(); const room = h.rooms[0]; assert.ok(room);
    room.incoming([message(1)]); room.incoming([message(1), message(2)], [message(2)]);
    h.page.onHide(); assert.equal(h.page.data.subtitle, null); assert.equal(h.page.data.chatOpen, false);
    const hidden = JSON.stringify(h.page.data.chatMessages);
    room.incoming([message(3)], [message(3)]); h.advance(30000);
    assert.equal(JSON.stringify(h.page.data.chatMessages), hidden); assert.equal(h.page.data.subtitle, null); assert.ok(room.stops);
    h.page.onShow(); await settle();
    h.app.globalData.token = 'replacement-test-session'; h.app.globalData.user = { id: 'watcher' };
    const oldIdentity = JSON.stringify(h.page.data.chatMessages); room.incoming([message(4)], [message(4)]);
    assert.equal(JSON.stringify(h.page.data.chatMessages), oldIdentity);
    h.page.onUnload(); room.incoming([message(5)], [message(5)]); assert.equal(h.page.data.subtitle, null);
  });
  test(`${label} chat preserves selected cells, own-side orientation, animation and authoritative time`, options, async () => {
    const h = harness(root); await settle(); const page = h.page, room = h.rooms[0]; assert.ok(room);
    await page.point({ currentTarget: { dataset: { index: 54 } } });
    const selected = JSON.stringify(page.data.cells), deadline = page.data.game.clock.deadline;
    room.incoming([message(1)]); room.incoming([message(1), message(2)], [message(2)]);
    assert.equal(page.data.selected, 54); assert.equal(JSON.stringify(page.data.cells), selected); assert.equal(page.data.perspective, 'red');
    const entry = createHistoryEntry(h.game.board, { from: 54, to: 45 }, 'red');
    h.game = { ...h.game, version: 2, board: entry.boardAfter, history: [{ move: entry.move, color: 'red', captured: null, at: 100000 }], lastMove: entry.move, turn: 'black' };
    page.render(h.game); const motion = JSON.stringify(page.data.motion), generation = page.motionGeneration;
    room.incoming([message(1), message(2), message(3)], [message(3)]);
    assert.equal(page.motionGeneration, generation); assert.equal(JSON.stringify(page.data.motion), motion); assert.equal(page.data.motion.handRotation, 170);
    assert.equal(page.data.game.clock.deadline, deadline); assert.equal(page.data.game.turnId, 'first-turn');
    h.advance(680); assert.equal(page.motionActive, false); assert.equal(page.data.cells.find(cell => cell.index === 45).piece.id, entry.boardAfter[45].id);
    page.onUnload();
  });
  test(`${label} all six reactions send chat and the white flag never resigns`, options, async () => {
    const h = harness(root); await settle(); assert.ok(h.rooms[0]);
    for (const reaction of ['handshake', 'thumbsup', 'badmove', 'cry', 'laugh', 'whiteflag']) {
      h.page.openReactions(); assert.equal(h.page.data.reactionOpen, true);
      await h.page.chooseReaction({ currentTarget: { dataset: { reaction } } }); assert.equal(h.page.data.reactionOpen, false);
    }
    assert.deepEqual(h.sent.map(value => value.reaction), ['handshake', 'thumbsup', 'badmove', 'cry', 'laugh', 'whiteflag']);
    assert.equal(h.actions.some(action => action.path.endsWith('/action')), false); assert.equal(h.page.data.game.status, 'active');
    assert.equal(h.voiceCalls, 0); h.page.onUnload();
  });
  test(`${label} subtitle history stays silent, full long text floats serially and the queue is bounded`, options, async () => {
    const h = harness(root); await settle(); const room = h.rooms[0]; assert.ok(room);
    room.incoming([message(1)]); assert.equal(h.page.data.subtitle, null);
    const long = message(2, 'other', '长'.repeat(200)); room.incoming([message(1), long], [long]);
    assert.equal(h.page.data.subtitle.text, long.text); assert.equal(h.page.data.subtitle.longText, true); assert.ok(h.page.data.subtitle.duration > 3600);
    room.incoming(Array.from({ length: 25 }, (_, i) => message(i + 3)), Array.from({ length: 25 }, (_, i) => message(i + 3)));
    assert.ok(h.page.subtitleQueue.length + (h.page.data.subtitle ? 1 : 0) <= 10);
    const duration = h.page.data.subtitle.duration; h.advance(duration + 20); assert.equal(h.page.data.subtitle.id, 'message-3');
    h.page.onHide(); h.advance(60000); assert.equal(h.page.data.subtitle, null); assert.equal(h.page.subtitleQueue.length, 0);
    h.page.onUnload();
  });
  test(`${label} AI and former table members never start or send chat`, options, async () => {
    for (const [userId, mode] of [['me', 'ai'], ['former-player', 'pvp']]) {
      const h = harness(root, userId, mode); await settle(); assert.ok(h.rooms[0]);
      assert.equal(h.rooms[0].starts, 0); assert.equal(h.page.data.chatEnabled, false);
      h.page.chatInput({ detail: { value: '不会发送' } }); await h.page.sendChat(); h.page.openReactions();
      assert.equal(h.sent.length, 0); assert.equal(h.page.data.reactionOpen, false); h.page.onUnload();
    }
    const template = readFileSync(resolve(root, 'pages/game/index.wxml'), 'utf8');
    assert.match(template, /maxlength="200"/); assert.doesNotMatch(template, /voice-input-btn|voice-output-btn|bindtap="voice/);
  });
}

for (const root of [standalone, integrated]) {
  const label = root === standalone ? 'standalone' : 'integrated';
  const options = { skip: !existsSync(root) };
  test(`${label} a 401 or replacement identity actively removes the visible old chat cache on the next tick`, options, async () => {
    for (const replace of [false, true]) {
      const h = harness(root); await settle(); const room = h.rooms[0];
      room.incoming([message(1)]); room.incoming([message(1), message(2)], [message(2)]);
      h.page.toggleChat(); h.page.chatInput({ detail: { value: '旧身份的草稿' } });
      room.state({ error: '旧提示' });
      h.app.globalData.token = replace ? 'different-session' : null;
      h.app.globalData.user = replace ? { id: 'watcher' } : null;
      h.page.tick();
      assert.equal(h.page.data.chatOpen, false); assert.equal(h.page.data.chatEnabled, false);
      assert.deepEqual(plain(h.page.data.chatMessages), []); assert.equal(h.page.data.chatDraft, '');
      assert.equal(h.page.data.chatUnread, 0); assert.equal(h.page.data.chatError, ''); assert.equal(h.page.data.subtitle, null);
      room.incoming([message(3)], [message(3)]); assert.equal(h.page.data.chatMessages.length, 0); h.page.onUnload();
    }
  });
  test(`${label} input bounds Unicode codepoints and full multiline subtitles scroll through a three-line window`, options, async () => {
    const h = harness(root); await settle(); const room = h.rooms[0];
    h.page.chatInput({ detail: { value: '🙂'.repeat(201) } });
    assert.equal(Array.from(h.page.data.chatDraft).length, 200); assert.equal(h.page.data.chatDraft, '🙂'.repeat(200));
    room.incoming([message(1)]);
    const long = message(2, 'other', '一\n'.repeat(99) + '一');
    room.incoming([message(1), long], [long]);
    assert.equal(h.page.data.subtitle.text, long.text); assert.equal(h.page.data.subtitle.longText, true);
    assert.ok(h.page.data.subtitle.duration >= 132000);
    const template = readFileSync(resolve(root, 'pages/game/index.wxml'), 'utf8');
    const style = readFileSync(resolve(root, 'pages/game/index.wxss'), 'utf8');
    assert.match(template, /subtitle-content/); assert.match(style, /long-subtitle[^}]*max-height:\s*92\.4px/);
    assert.match(style, /long-subtitle[^}]*overflow:\s*hidden/); h.page.onUnload();
  });
}
