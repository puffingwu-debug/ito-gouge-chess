import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedMove, paintMotion } from '../web/chess-motion.js';

test('动画只接收同一棋局的一手确认，旧回合重写或多手恢复直接显示权威棋盘', () => {
  const piece = { id: 'red-rook', color: 'red', type: 'R' };
  const victim = { id: 'black-pawn', color: 'black', type: 'P' };
  const previous = { id: 'one', board: Array(90).fill(null), history: [] };
  previous.board[81] = piece; previous.board[72] = victim;
  const next = { id: 'one', board: [...previous.board], history: [{ color: 'red', move: { from: 81, to: 72 }, at: 1, captured: victim }] };
  next.board[81] = null; next.board[72] = piece;
  const frame = confirmedMove(previous, next);
  assert.equal(frame.piece, piece); assert.equal(frame.captured, victim);
  assert.equal(confirmedMove(previous, { ...next, id: 'two' }), null);
  assert.equal(confirmedMove(next, next), null);
  assert.equal(confirmedMove(previous, { ...next, history: [...next.history, next.history[0]] }), null);
  assert.equal(confirmedMove(next, previous), null);
  const changed = [...next.board]; changed[0] = { id: 'extra', color: 'black', type: 'R' };
  assert.equal(confirmedMove(previous, { ...next, board: changed }), null);
});

test('无棋袋吃子动画只使用棋盘坐标，击飞淡出并在重绘时恢复已经过的时间', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  for (const destinationY of [120, 460]) {
    const calls = [], selectors = [];
    const animated = name => ({ style: {}, animate(frames, options) {
      const animation = { currentTime: 0 };
      calls.push({ name, frames, options, animation }); return animation;
    } });
    const hand = animated('hand'), actor = animated('actor'), victim = animated('victim');
    actor.querySelector = selector => { assert.equal(selector, 'img'); return hand; };
    const cell = (left, top) => ({ getBoundingClientRect: () => ({ left, top, width: 32, height: 32 }) });
    const stage = {
      getBoundingClientRect: () => ({ left: 30, top: 100, width: 320, height: 390 }),
      querySelector(selector) {
        selectors.push(selector);
        return { '[data-cell="70"]': cell(270, 410), '[data-cell="7"]': cell(270, destinationY), '.moving-actor': actor, '.flying-piece': victim }[selector];
      }
    };
    globalThis.document = { querySelector(selector) { assert.equal(selector, '.board-scene'); return stage; } };
    const frame = { move: { from: 70, to: 7 }, captured: { color: 'black', type: 'H' }, startedAt: performance.now() - 275 };
    const animations = paintMotion(frame);
    assert.equal(animations.length, 3);
    assert.ok(selectors.every(selector => !selector.includes('capture') && !selector.includes('bag')));
    assert.ok(animations.every(animation => animation.currentTime >= 275));
    const fly = calls.find(call => call.name === 'victim');
    assert.equal(fly.frames[0].opacity, 1);
    assert.equal(fly.frames.at(-1).opacity, 0);
    const endpoint = fly.frames.at(-1).transform.match(/translate\(([-.\d]+)px,([-.\d]+)px\)/);
    const centerY = Number(endpoint[2]) + 32 * .88 / 2;
    assert.ok(destinationY === 120 ? centerY < 0 : centerY > 390);
    assert.equal(fly.options.duration, 1150);
  }
});

test('红黑两种朝向的手始终从走棋一方伸出，重绘恢复时手指仍朝棋子', t => {
  const original = globalThis.document;
  t.after(() => { globalThis.document = original; });
  for (const perspective of ['red', 'black']) for (const color of ['red', 'black']) {
    const calls = [];
    const animated = name => ({ style: {}, animate(frames, options) { const animation = {}; calls.push({ name, frames, options }); return animation; } });
    const hand = animated('hand'), actor = animated('actor');
    actor.querySelector = () => hand;
    const cell = top => ({ getBoundingClientRect: () => ({ left: 80, top, width: 32, height: 32 }) });
    const stage = { getBoundingClientRect: () => ({ left: 30, top: 100, width: 320, height: 390 }),
      querySelector: selector => ({ '[data-cell="54"]': cell(perspective === color ? 410 : 140), '[data-cell="45"]': cell(270), '.moving-actor': actor }[selector]) };
    globalThis.document = { querySelector: () => stage };
    const result = paintMotion({ move: { from: 54, to: 45 }, piece: { color }, startedAt: performance.now() - 350 }, perspective);
    const frames = calls.find(call => call.name === 'hand').frames;
    for (const frame of frames) assert.match(frame.transform, new RegExp(`rotate\\(${perspective === color ? 180 : 0}deg\\)`));
    assert.ok(result.every(animation => animation.currentTime >= 350));
    assert.equal(calls.find(call => call.name === 'actor').options.duration, 800);
  }
});
