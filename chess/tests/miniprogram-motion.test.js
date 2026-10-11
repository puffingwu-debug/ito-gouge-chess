import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import vm from 'node:vm';
import { createInitialBoard, createHistoryEntry, getLegalMoves } from '../core/xiangqi.js';

const root = resolve('miniprogram');
const hostChess = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包', 'chess');
const rects = [
  { left: 10, top: 100, width: 351, height: 480 },
  { left: 35, top: 190, width: 300, height: 337.5 }
];

function snapshots() {
  const states = [];
  let board = createInitialBoard(), history = [];
  function snapshot() {
    const turn = history.length % 2 ? 'black' : 'red';
    return {
      id: 'motion-game', version: history.length + 1, turnId: 'turn-' + history.length,
      mode: 'pvp', tableId: 1, status: 'active', turn, board, history,
      seats: { red: { id: 'me', name: '红方' }, black: { id: 'other', name: '黑方' } },
      ownerId: 'me', ready: { red: true, black: true }, spectators: [], serverNow: 100000,
      timeControl: { mode: 'rapid', rapidSeconds: 15 },
      clock: { deadline: 115000, red: { usedMs: 200, totalRemainingMs: null, phase: 'rapid' }, black: { usedMs: 300, totalRemainingMs: null, phase: 'rapid' } },
      lastMove: history.at(-1)?.move || null, legalMoves: []
    };
  }
  states.push(snapshot());
  for (let index = 0; index < 4; index++) {
    const color = index % 2 ? 'black' : 'red';
    const move = index === 0 ? { from: 70, to: 7 } : index === 1 ? { from: 8, to: 7 } : getLegalMoves(board, color)[0];
    const entry = createHistoryEntry(board, move, color);
    history = history.concat({ move: entry.move, color, captured: entry.boardBefore[move.to] || null, source: 'human', at: 100000 + index });
    board = entry.boardAfter;
    states.push(snapshot());
  }
  return states;
}

function harness({ deferredQuery = false, queryRects = rects, userId = 'me', sourceRoot = root } = {}) {
  let now = 100000, nextTimer = 1, definition;
  const timers = new Map(), storage = new Map(), queries = [], pendingQueries = [];
  const app = { globalData: { token: 'token', user: { id: userId }, config: { development: true } } };
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    request: options => options.success({ statusCode: 200, data: { ok: true } }),
    onVoIPChatMembersChanged() {}, onVoIPChatInterrupted() {}, offVoIPChatMembersChanged() {}, offVoIPChatInterrupted() {},
    createSelectorQuery() { throw new Error('Page.createSelectorQuery must take precedence'); }
  };
  const cache = new Map();
  function timeout(callback, delay) { const id = nextTimer++; timers.set(id, { at: now + delay, callback }); return id; }
  function load(file) {
    file = resolve(file); if (!extname(file)) file += '.js';
    if (file === resolve(sourceRoot, 'config.js')) return { development: true, apiBase: 'http://127.0.0.1:8787' };
    if (file === resolve(sourceRoot, 'session.js')) return { getChessApp: () => app };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, exports: module.exports, require: name => load(resolve(dirname(file), name)),
      wx, getApp: () => app, Page: value => { definition = value; },
      Date: class extends Date { static now() { return now; } },
      setTimeout: timeout, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, console
    }, { filename: file });
    return module.exports;
  }
  load(resolve(sourceRoot, 'pages/game/index.js'));
  const page = {
    ...definition, data: structuredClone(definition.data),
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); },
    createSelectorQuery() {
      const selectors = [];
      const query = {
        select(selector) { selectors.push(selector); return { boundingClientRect(callback) { assert.equal(callback, undefined); return query; } }; },
        exec(callback) { queries.push(selectors); if (deferredQuery) pendingQueries.push(callback); else callback(queryRects); }
      };
      return query;
    }
  };
  page.onLoad({ id: 'motion-game' }); page.visible = true;
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = until;
  }
  function settings(game) {
    load(resolve(sourceRoot, 'pages/settings/index.js'));
    const instance = { ...definition, data: structuredClone(definition.data), gameId: game.id,
      setData(patch) { Object.assign(this.data, patch); } };
    instance.renderGame(game);
    return instance;
  }
  return { page, load, settings, advance, timers, storage, queries, flushQuery() { pendingQueries.splice(0).forEach(callback => callback(queryRects)); } };
}

function assertVisibleBoard(page, board) {
  for (let index = 0; index < 90; index++) assert.equal(page.data.cells.find(cell => cell.index === index).piece?.id || null, board[index]?.id || null);
}

for (const sourceRoot of [root, hostChess]) {
  test(`${sourceRoot === root ? 'standalone' : 'integrated'} red and black players stay below despite saved preferences, with matching tap and move coordinates`, { skip: !existsSync(sourceRoot) }, async () => {
    for (const color of ['black', 'red']) {
      const client = harness({ sourceRoot, userId: color === 'red' ? 'me' : 'other' });
      const game = { ...snapshots()[0], turn: color, legalMoves: [{ id: 'pawn-step', from: color === 'red' ? 54 : 27, to: color === 'red' ? 45 : 36 }] };
      client.storage.set('gougeBoardSide', 'red');
      client.storage.set('gougeGamePerspective', { gameId: game.id, userId: color === 'red' ? 'me' : 'other', perspective: color === 'red' ? 'black' : 'red' });
      client.page.render(game);
      assert.equal(client.page.data.perspective, color);
      assert.equal(client.page.data.bottomColor, color);
      assert.equal(client.page.data.topColor, color === 'red' ? 'black' : 'red');
      assert.equal(client.page.data.bottomPlayer.id, color === 'red' ? 'me' : 'other');
      const general = client.page.data.cells.find(cell => cell.index === (color === 'red' ? 85 : 4));
      assert.equal(general.x, 4); assert.equal(general.y, 9);
      const opponent = client.page.data.cells.find(cell => cell.index === (color === 'red' ? 4 : 85));
      assert.equal(opponent.y, 0);
      const from = game.legalMoves[0].from, to = game.legalMoves[0].to;
      const displayedPawn = client.page.data.cells.find(cell => cell.index === from);
      assert.equal(displayedPawn.y, 6);
      await client.page.point({ currentTarget: { dataset: { index: displayedPawn.index } } });
      assert.equal(client.page.data.selected, from);
      const destination = client.page.data.cells.find(cell => cell.index === to);
      assert.equal(destination.destination, true); assert.equal(destination.y, 5);
      const { displayPoint } = client.load(resolve(sourceRoot, 'utils/chess-motion.js'));
      const start = displayPoint(from, color, rects[1], rects[0]), end = displayPoint(to, color, rects[1], rects[0]);
      assert.equal(start.x, color === 'red' ? 25 : 325); assert.equal(start.y, 315);
      assert.equal(end.x, start.x); assert.equal(end.y, 277.5);
      const settings = client.settings(game); settings.flip();
      assert.equal(settings.data.perspective, color);
      client.page.render(game); assert.equal(client.page.data.perspective, color);
    }
  });
  test(`${sourceRoot === root ? 'standalone' : 'integrated'} hands approach from each mover's side and keep mirrored take/drop coordinates`, { skip: !existsSync(sourceRoot) }, () => {
    for (const perspective of ['red', 'black']) {
      const client = harness({ sourceRoot, userId: perspective === 'red' ? 'me' : 'other' });
      const states = snapshots(); client.page.render(states[0]);
      const { displayPoint } = client.load(resolve(sourceRoot, 'utils/chess-motion.js'));
      for (const after of states.slice(1, 3)) {
        const entry = after.history.at(-1); client.page.render(after);
        assert.equal(client.page.data.motion.handRotation, entry.color === perspective ? 170 : -10);
        assert.deepEqual(JSON.parse(JSON.stringify(client.page.data.motion.moverPoint)), JSON.parse(JSON.stringify(displayPoint(entry.move.from, perspective, rects[1], rects[0]))));
        client.advance(420);
        assert.equal(client.page.data.motion.phase, 'drop');
        assert.deepEqual(JSON.parse(JSON.stringify(client.page.data.motion.moverPoint)), JSON.parse(JSON.stringify(displayPoint(entry.move.to, perspective, rects[1], rects[0]))));
        assert.equal(client.page.data.motion.handRotation, entry.color === perspective ? 170 : -10);
        client.advance(620);
        assertVisibleBoard(client.page, after.board);
      }
    }
  });
}

test('a confirmed animation requires exactly one consistent new history move', () => {
  const { load } = harness(), states = snapshots();
  const { confirmedMove } = load(resolve(root, 'utils/chess-motion.js'));
  assert.equal(confirmedMove(states[0], states[1]).mover.label, '炮');
  assert.equal(confirmedMove(states[0], states[1]).captured.label, '马');
  assert.equal(confirmedMove(states[1], structuredClone(states[1])), null);
  assert.equal(confirmedMove(states[0], states[2]), null);
  assert.equal(confirmedMove(states[2], states[1]), null);
  const corrupt = structuredClone(states[1]); corrupt.board[0] = null;
  assert.equal(confirmedMove(states[0], corrupt), null);
  const wrongPrefix = structuredClone(states[2]); wrongPrefix.history[0].move.from = 71;
  assert.equal(confirmedMove(states[1], wrongPrefix), null);
});

test('selector geometry follows actual exec result ordering and black-side reversal', () => {
  const client = harness();
  const { queryGeometry, displayPoint, geometryFromRects } = client.load(resolve(root, 'utils/chess-motion.js'));
  let result; queryGeometry(client.page, geometry => { result = geometry; });
  assert.equal(client.queries[0].join(','), '.chess-stage,.board-grid');
  assert.equal(Object.keys(result).sort().join(','), 'board,stage');
  const red = displayPoint(70, 'red', result.board, result.stage);
  const black = displayPoint(70, 'black', result.board, result.stage);
  assert.equal(red.x, 287.5); assert.equal(red.y, 352.5);
  assert.equal(black.x, 62.5); assert.equal(black.y, 165);
  assert.equal(geometryFromRects([null, ...rects.slice(1)]), null);
});

test('one capture lifts, travels, strikes, flies away, and fades while game and clock stay authoritative', () => {
  const client = harness(), [before, after] = snapshots();
  client.page.render(before); client.page.render(after);
  const authority = JSON.stringify(client.page.data.game);
  assert.equal(client.page.data.motion.phase, 'take');
  assert.equal(client.page.data.cells.find(cell => cell.index === 70).piece, null);
  client.advance(150);
  assert.equal(client.page.data.motion.phase, 'travel');
  client.advance(380);
  assert.equal(client.page.data.motion.capturedVisible, true);
  assert.equal(client.page.data.cells.find(cell => cell.index === 7).piece.id, 'red-C-7');
  client.advance(16);
  assert.equal(client.page.data.motion.phase, 'strike');
  client.advance(114);
  assert.equal(client.page.data.motion.phase, 'fly-away');
  assert.ok(client.page.data.motion.flyPoint.x < 0 || client.page.data.motion.flyPoint.x > rects[0].width);
  client.advance(290);
  assert.equal(client.page.data.motion.phase, 'fade');
  assert.equal(client.page.data.motion.flyOpacity, 0);
  client.advance(90);
  assert.equal(client.page.data.motion, null);
  assertVisibleBoard(client.page, after.board);
  assert.equal(JSON.stringify(client.page.data.game), authority);
  client.page.tick();
  assert.equal(client.page.data.clock.black.used, '00:02');
  assert.equal(client.page.data.clock.black.remaining, '00:14');
  assert.equal(client.page.data.clock.red.used, '00:01');
  assert.equal(client.timers.size, 0);
  client.page.render(structuredClone(after));
  assert.equal(client.page.data.motion, null);
  assert.equal(client.timers.size, 0);
});

test('rapid AI confirmation queues up to three visuals without interrupting the human hand', () => {
  const client = harness(), states = snapshots();
  states.slice(0, 4).forEach(game => client.page.render(game));
  assert.equal(client.page.motionQueue.length, 2);
  assert.equal(client.page.currentMotion.color, 'red');
  assert.equal(client.page.data.game.history.length, 3);
  client.advance(1040);
  assert.equal(client.page.currentMotion.color, 'black');
  client.advance(1040);
  client.advance(680);
  assert.equal(client.page.motionActive, false);
  assert.equal(client.page.motionQueue.length, 0);
  assert.equal(client.page.data.cells.find(cell => cell.index === 7).piece.id, states[3].board[7].id);
  assertVisibleBoard(client.page, states[3].board);
  assert.equal(client.timers.size, 0);
});

test('queue overflow, multi-move recovery, and undo immediately catch up to authoritative snapshots', () => {
  const client = harness(), states = snapshots();
  states.forEach(game => client.page.render(game));
  assert.equal(client.page.motionActive, false);
  assert.equal(client.page.data.motion, null);
  assert.equal(client.page.motionQueue.length, 0);
  assert.equal(client.timers.size, 0);
  assertVisibleBoard(client.page, states[4].board);
  const undo = { ...states[1], version: 10 };
  client.page.render(undo);
  assertVisibleBoard(client.page, undo.board);
  const rematch = { ...states[0], version: 11 };
  client.page.render(rematch);
  assertVisibleBoard(client.page, rematch.board);
  client.page.render({ ...states[2], version: 12 });
  assert.equal(client.page.data.motion, null);
  assertVisibleBoard(client.page, states[2].board);
});

test('hide cancels delayed geometry and all animation callbacks, with no replay on re-entry', () => {
  const client = harness({ deferredQuery: true }), states = snapshots();
  client.page.render(states[0]); client.page.render(states[1]);
  const authority = JSON.stringify(client.page.data.game);
  client.page.onHide(); client.flushQuery(); client.advance(5000);
  assert.equal(client.page.data.motion, null);
  assert.equal(client.page.motionActive, false);
  assert.equal(client.timers.size, 0);
  assertVisibleBoard(client.page, states[1].board);
  assert.equal(JSON.stringify(client.page.data.game), authority);
  client.page.connect = () => client.page.render(states[2]);
  client.page.onShow(); client.flushQuery();
  assert.equal(client.page.data.motion, null);
  assertVisibleBoard(client.page, states[2].board);
  client.page.onUnload();
});

test('spectator flipping cancels old coordinates and keeps the authoritative board in the matching visual orientation', () => {
  const client = harness({ userId: 'observer' }), states = snapshots();
  client.page.render(states[0]); client.page.render(states[1]); client.page.render(states[2]);
  client.settings(states[2]).flip();
  client.page.render(states[2]); client.advance(5000);
  assert.equal(client.page.data.perspective, 'black');
  assertVisibleBoard(client.page, states[2].board);
  assert.equal(client.page.data.cells.find(cell => cell.index === 7).left, 12.5);
  assert.equal(client.page.data.cells.find(cell => cell.index === 7).top, 100);
  assert.equal(client.page.data.motion, null);
  assert.equal(client.timers.size, 0);
});

test('missing layout measurements do not invent animation coordinates or hide confirmed pieces', () => {
  const client = harness({ queryRects: [null, ...rects.slice(1)] }), states = snapshots();
  client.page.render(states[0]); client.page.render(states[1]);
  assert.equal(client.page.data.motion, null);
  assert.equal(client.page.motionActive, false);
  assert.equal(client.page.data.cells.find(cell => cell.index === 7).piece.id, 'red-C-7');
  assert.equal(client.timers.size, 0);
});

test('a timely player tap cancels queued visuals and selects from the current authoritative board', async () => {
  const client = harness(), states = snapshots();
  states.slice(0, 3).forEach(game => client.page.render(game));
  assert.equal(client.page.motionActive, true);
  assert.equal(client.page.data.game.turn, 'red');
  const rook = states[2].board.findIndex(piece => piece && piece.color === 'red' && piece.type === 'R');
  await client.page.point({ currentTarget: { dataset: { index: rook } } });
  assert.equal(client.page.motionActive, false);
  assert.equal(client.page.motionQueue.length, 0);
  assert.equal(client.page.data.selected, rook);
  assert.equal(client.page.data.cells.find(cell => cell.index === rook).selected, true);
  assert.equal(client.timers.size, 0);
});

test('terminal move confirmation still animates once while a later non-move finish cancels visuals', () => {
  const client = harness(), states = snapshots();
  client.page.render(states[0]);
  const terminal = { ...states[1], status: 'finished', outcome: { winner: 'red', reason: '将死', rule: '将死' } };
  client.page.render(terminal);
  const generation = client.page.motionGeneration;
  client.page.render(structuredClone(terminal));
  assert.equal(client.page.motionActive, true);
  assert.equal(client.page.motionGeneration, generation);
  client.advance(1040);
  assertVisibleBoard(client.page, terminal.board);
  const second = harness();
  second.page.render(states[0]); second.page.render(states[1]);
  second.page.render({ ...terminal, version: terminal.version + 1 });
  assert.equal(second.page.motionActive, false);
  assert.equal(second.page.data.motion, null);
  assert.equal(second.timers.size, 0);
});
