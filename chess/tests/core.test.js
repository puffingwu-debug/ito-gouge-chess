import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialBoard, getLegalMoves, applyMove, isInCheck, createHistoryEntry, getOutcome,
  rankMoves, chooseAutoMove, positionKey, isProtected, DIFFICULTY_PROFILES, naturalMoveCount, getDrawClaimOutcome } from '../core/xiangqi.js';
import { normalizeTimeControl, getDeadline, clockSnapshot } from '../core/clock.js';

const flip = color => color === 'red' ? 'black' : 'red';
const at = (x, y) => y * 9 + x;
const move = (from, to) => ({ id: `${from}-${to}`, from, to });
function boardOf(placements) {
  const board = Array(90).fill(null);
  for (const [color, type, x, y] of placements) board[at(x, y)] = { id: `${color}-${type}-${x}-${y}`, color, type };
  return board;
}
function fromFen(fen) {
  const [position, side] = fen.split(' ');
  const board = Array(90).fill(null);
  let square = 0;
  for (const char of position) {
    if (char === '/') continue;
    if (/\d/.test(char)) { square += Number(char); continue; }
    const raw = char.toUpperCase(), type = raw === 'N' ? 'H' : raw === 'B' ? 'E' : raw;
    board[square] = { id: `fen-${square}`, color: char === char.toUpperCase() ? 'red' : 'black', type };
    square++;
  }
  assert.equal(square, 90);
  return { board, turn: side === 'b' ? 'black' : 'red' };
}
function ucciMove(text) {
  const coord = text => at(text.charCodeAt(0) - 97, 9 - Number(text[1]));
  return move(coord(text.slice(0, 2)), coord(text.slice(2)));
}
function perft(board, turn, depth) {
  if (!depth) return 1;
  return getLegalMoves(board, turn).reduce((sum, m) => sum + perft(applyMove(board, m), flip(turn), depth - 1), 0);
}
const has = (board, color, from, to) => getLegalMoves(board, color).some(m => m.from === from && m.to === to);
const base = extras => boardOf([['black', 'K', 4, 0], ['red', 'K', 4, 9], ['red', 'P', 4, 5], ...extras]);

test('initial position: 32 stable IDs, no mutation, reference perft 44 / 1920 / 79666', () => {
  const board = createInitialBoard();
  assert.equal(board.filter(Boolean).length, 32);
  assert.equal(new Set(board.filter(Boolean).map(p => p.id)).size, 32);
  assert.deepEqual([1, 2, 3].map(depth => perft(board, 'red', depth)), [44, 1920, 79666]);
  const original = structuredClone(board), m = getLegalMoves(board, 'red')[0];
  const next = applyMove(board, m);
  assert.deepEqual(board, original);
  assert.equal(next[m.to].id, board[m.from].id);
  assert.equal(next[m.from], null);
  assert.throws(() => applyMove(board, { from: 90, to: 1 }));
});

test('horse leg blocks only its two corresponding destinations', () => {
  const board = base([['red', 'H', 2, 7], ['red', 'P', 3, 7]]);
  assert.equal(has(board, 'red', at(2, 7), at(4, 6)), false);
  assert.equal(has(board, 'red', at(2, 7), at(4, 8)), false);
  assert.equal(has(board, 'red', at(2, 7), at(3, 5)), true);
});
test('elephant eye and river; advisor and general remain in palace', () => {
  const board = base([['red', 'E', 2, 7], ['red', 'P', 3, 6], ['red', 'A', 3, 9]]);
  assert.equal(has(board, 'red', at(2, 7), at(4, 5)), false);
  assert.equal(has(board, 'red', at(2, 7), at(0, 5)), true);
  assert.equal(has(board, 'red', at(3, 9), at(2, 8)), false);
  assert.equal(has(board, 'red', at(3, 9), at(4, 8)), true);
  const river = base([['red', 'E', 2, 5]]);
  assert.equal(has(river, 'red', at(2, 5), at(0, 3)), false);
  const palace = boardOf([['black', 'K', 4, 0], ['red', 'K', 3, 8]]);
  assert.equal(has(palace, 'red', at(3, 8), at(2, 8)), false);
});
test('cannon needs exactly one screen to capture and none for a quiet move', () => {
  let board = base([['red', 'C', 0, 7], ['black', 'R', 0, 2]]);
  assert.equal(has(board, 'red', at(0, 7), at(0, 2)), false);
  assert.equal(has(board, 'red', at(0, 7), at(0, 4)), true);
  board[at(0, 5)] = { id: 'screen', color: 'red', type: 'P' };
  assert.equal(has(board, 'red', at(0, 7), at(0, 2)), true);
  assert.equal(has(board, 'red', at(0, 7), at(0, 4)), false);
  board[at(0, 3)] = { id: 'screen2', color: 'black', type: 'P' };
  assert.equal(has(board, 'red', at(0, 7), at(0, 2)), false);
});
test('soldiers only move forward before river, sideways after, never backward', () => {
  const before = base([['red', 'P', 2, 6], ['black', 'P', 6, 3]]);
  assert.equal(has(before, 'red', at(2, 6), at(3, 6)), false);
  assert.equal(has(before, 'black', at(6, 3), at(6, 4)), true);
  const after = base([['red', 'P', 2, 4], ['black', 'P', 6, 5]]);
  assert.equal(has(after, 'red', at(2, 4), at(3, 4)), true);
  assert.equal(has(after, 'red', at(2, 4), at(2, 5)), false);
  assert.equal(has(after, 'black', at(6, 5), at(5, 5)), true);
});
test('facing generals and pinned blocking piece cannot move aside', () => {
  const board = boardOf([['black', 'K', 4, 0], ['red', 'K', 4, 9], ['red', 'R', 4, 5]]);
  assert.equal(isInCheck(board, 'red'), false);
  assert.equal(has(board, 'red', at(4, 5), at(3, 5)), false);
  assert.equal(has(board, 'red', at(4, 5), at(4, 4)), true);
  board[at(4, 5)] = null;
  assert.equal(isInCheck(board, 'red'), true);
  assert.equal(isInCheck(board, 'black'), true);
});
test('checkmate wins; stalemate is also a loss, and terminal position has no auto move', () => {
  const placements = [['black', 'K', 4, 0], ['red', 'K', 4, 9], ['red', 'P', 4, 5], ['red', 'R', 3, 1], ['red', 'R', 5, 1]];
  const stale = boardOf(placements);
  assert.equal(isInCheck(stale, 'black'), false);
  assert.equal(getOutcome(stale, 'black').rule, 'stalemate-loss');
  const mate = boardOf([...placements, ['red', 'R', 4, 2]]);
  assert.equal(isInCheck(mate, 'black'), true);
  assert.equal(getOutcome(mate, 'black').rule, 'checkmate');
  assert.equal(chooseAutoMove(mate, 'black'), null);
});
test('history preserves capture and check; bare defensive material draws', () => {
  const board = base([['red', 'R', 0, 7], ['black', 'C', 0, 2]]);
  const history = createHistoryEntry(board, move(at(0, 7), at(0, 2)), 'red');
  assert.equal(history.captured.type, 'C');
  assert.equal(history.irreversible, true);
  assert.equal(history.boardBefore[at(0, 7)].type, 'R');
  const dead = boardOf([['red', 'K', 3, 9], ['black', 'K', 4, 0], ['red', 'A', 4, 8]]);
  assert.equal(getOutcome(dead, 'red').rule, 'dead-position');
  const bareCannon = boardOf([['red', 'K', 3, 9], ['black', 'K', 4, 0], ['red', 'C', 0, 5]]);
  assert.equal(getOutcome(bareCannon, 'red').rule, 'dead-position');
});

test('all normal control combinations, including mid-turn total exhaustion', () => {
  const start = 100000, used = 570000;
  const c = normalizeTimeControl({ perMoveSeconds: 60, totalSeconds: 600, overtimeSeconds: 20 });
  assert.equal(getDeadline(c, used, start), start + 50000);
  assert.equal(getDeadline({ ...c, perMoveSeconds: 40 }, used, start), start + 40000);
  assert.equal(getDeadline({ ...c, perMoveSeconds: null }, used, start), start + 50000);
  assert.equal(getDeadline(c, 600000, start), start + 20000);
  assert.equal(getDeadline(c, 800000, start), start + 20000);
  assert.equal(getDeadline({ ...c, totalSeconds: null }, used, start), start + 60000);
  assert.equal(getDeadline({ ...c, totalSeconds: null, perMoveSeconds: null }, used, start), null);
  assert.equal(getDeadline(c, used, null), null);
});
test('rapid ignores normal limits; clocks are independent and never reset overtime', () => {
  const c = normalizeTimeControl({ mode: 'rapid', rapidSeconds: 15, perMoveSeconds: 2, totalSeconds: 1 });
  assert.equal(getDeadline(c, 900000, 1000), 16000);
  const snap = clockSnapshot(c, { red: 900000, black: 5000 }, 'red', 1000, 6000);
  assert.equal(snap.red.usedMs, 905000);
  assert.equal(snap.black.usedMs, 5000);
  assert.equal(snap.red.phase, 'rapid');
  assert.equal(snap.red.totalRemainingMs, null);
  const normal = normalizeTimeControl({ perMoveSeconds: 60, totalSeconds: 600, overtimeSeconds: 20 });
  const total = clockSnapshot(normal, { red: 570000, black: 1000 }, 'red', 1000, 30000);
  assert.equal(total.red.phase, 'total');
  assert.equal(total.red.totalRemainingMs, 1000);
  const overtime = clockSnapshot(normal, { red: 570000, black: 1000 }, 'red', 1000, 31000);
  assert.equal(overtime.red.phase, 'overtime');
  assert.equal(overtime.remainingMs, 20000);
  assert.equal(overtime.black.usedMs, 1000);
});
test('time settings preserve explicit nulls and reject invalid/zero/negative values', () => {
  assert.equal(normalizeTimeControl({ totalSeconds: null }).totalSeconds, null);
  for (const value of [0, -1, Infinity, NaN, '15']) assert.throws(() => normalizeTimeControl({ rapidSeconds: value }));
  assert.throws(() => normalizeTimeControl({ mode: 'unknown' }));
});
test('five search profiles differ, legal candidates always sorted, strict node cap and deterministic easy choices', () => {
  assert.deepEqual(DIFFICULTY_PROFILES.map(p => p.depth), [1, 1, 2, 3, 4]);
  const board = createInitialBoard(), legal = new Set(getLegalMoves(board, 'red').map(m => m.id));
  const rankings = [];
  for (let difficulty = 1; difficulty <= 5; difficulty++) {
    const result = rankMoves(board, 'red', difficulty, { budgetMs: 300, maxNodes: 200 });
    assert.equal(result.length, legal.size);
    assert.ok(result.every(m => legal.has(m.id)));
    assert.ok(result.every((m, i) => !i || result[i - 1].score >= m.score));
    assert.ok(result.search.nodes <= 200);
    rankings.push(result[0].id);
  }
  assert.ok(new Set(rankings).size >= 2);
  assert.deepEqual(rankMoves(board, 'red', 1, { maxNodes: 0 }), rankMoves(board, 'red', 1, { maxNodes: 0 }));
  const auto = chooseAutoMove(board, 'red');
  assert.ok(legal.has(auto.id));
});
test('budget cutoff returns every legal candidate without committing half-finished search', () => {
  let tick = 0;
  const result = rankMoves(createInitialBoard(), 'red', 5, { budgetMs: 1, maxNodes: 10000, now: () => tick++ });
  assert.equal(result.length, 44);
  assert.equal(result.search.completedDepth, 0);
  assert.equal(result.search.nodes, 0);
});

test('search difficulty is visible on a tactic: deeper levels avoid a poisoned cannon', () => {
  const board = base([['red', 'R', 0, 8], ['black', 'C', 0, 3], ['black', 'R', 0, 0]]);
  const poisoned = move(at(0, 8), at(0, 3)).id;
  assert.equal(rankMoves(board, 'red', 1, { budgetMs: 300, maxNodes: 50000 })[0].id, poisoned);
  for (const difficulty of [3, 4, 5]) {
    const result = rankMoves(board, 'red', difficulty, { budgetMs: 300, maxNodes: 50000 });
    assert.notEqual(result[0].id, poisoned);
    assert.ok(result.search.completedDepth >= 2);
  }
});

test('natural movecount subtracts only claimant checks above ten and resets on capture, not soldier move', () => {
  const board = createInitialBoard();
  const moves = getLegalMoves(board, 'red');
  const quiet = moves.find(m => !board[m.to]);
  const entry = createHistoryEntry(board, quiet, 'red');
  const history = Array.from({ length: 100 }, (_, i) => ({ ...entry, color: i % 2 ? 'black' : 'red', check: i < 30 && i % 2 === 0 }));
  assert.deepEqual(naturalMoveCount(history, 'red'), { plies: 100, checks: { red: 15, black: 0 }, count: 95 });
  assert.equal(naturalMoveCount(history, 'black').count, 100);
  assert.equal(naturalMoveCount(history).count, 95);
  // The current board differs from every post-move snapshot, so no cycle is formed.
  assert.equal(getDrawClaimOutcome(board, 'red', history, 'black').rule, 'wxf-natural-movecount-claim');
  assert.equal(getDrawClaimOutcome(board, 'red', history, 'red'), null);
  const captured = { ...entry, captured: { type: 'P' } };
  assert.equal(naturalMoveCount([...history, captured, { ...entry, check: false }]).count, 1);
  const pawn = moves.find(m => board[m.from].type === 'P');
  const pawnEntry = createHistoryEntry(board, pawn, 'red');
  assert.equal(naturalMoveCount([pawnEntry]).count, 1);
});

const PERFT_FIXTURES = [
  ['r1ea1a3/4kh3/2h1e4/pHp1p1p1p/4c4/6P2/P1P2R2P/1CcC5/9/2EAKAE2 w', [38, 1128, 43929]],
  ['1ceak4/9/h2a5/2p1p3p/5cp2/2h2H3/6PCP/3AE4/2C6/3A1K1H1 w', [7, 281, 8620]],
  ['5a3/3k5/3aR4/9/5r3/5h3/9/3A1A3/5K3/2EC2E2 w', [25, 424, 9850]],
  ['CRH1k1e2/3ca4/4ea3/9/2hr5/9/9/4E4/4A4/4KA3 w', [28, 516, 14808]],
  ['R1H1k1e2/9/3aea3/9/2hr5/2E6/9/4E4/4A4/4KA3 w', [21, 364, 7626]],
  ['C1hHk4/9/9/9/9/9/h1pp5/E3C4/9/3A1K3 w', [28, 222, 6241]],
  ['4ka3/4a4/9/9/4H4/p8/9/4C3c/7h1/2EK5 w', [23, 345, 8124]],
  ['2e1ka3/9/e3H4/4h4/9/9/9/4C4/2p6/2EK5 w', [21, 195, 3883]],
  ['1C2ka3/9/C1Hae1h2/p3p3p/6p2/9/P3P3P/3AE4/3p2c2/c1EAK4 w', [30, 830, 22787]],
  ['ChH1k1e2/c3a4/4ea3/9/2hr5/9/9/4C4/4A4/4KA3 w', [19, 583, 11714]],
];
for (const [fen, expected] of PERFT_FIXTURES) test(`异形棋局 perft 1–3: ${fen}`, () => {
  const { board, turn } = fromFen(fen);
  assert.deepEqual([1, 2, 3].map(depth => perft(board, turn, depth)), expected);
});

// FEN positions and rulings are factual regression data from the author's WXF validation suite.
// The implementation is independent JavaScript, based on the algorithm in arXiv:2412.17334.
// Extend each existing closed cycle to three occurrences, the app's adjudication threshold.
function runRepetitionFixture(fixture) {
  let { board, turn } = fromFen(fixture.fen);
  const history = [], positions = [positionKey(board, turn)];
  const push = m => {
    assert.ok(getLegalMoves(board, turn).some(legal => legal.id === m.id), `非法测例着法 ${m.id}`);
    const entry = createHistoryEntry(board, m, turn);
    history.push(entry); board = entry.boardAfter; turn = flip(turn);
    positions.push(positionKey(board, turn));
  };
  for (const text of fixture.moves) push(ucciMove(text));
  const expectedWinner = fixture.expected === 'Draw' ? null : fixture.expected === 'Win' ? turn : flip(turn);
  if (fixture.moves.length) {
    // A source variation may finish one move after the repeated position (WXF 81).
    // Adjudication is performed when the closed position is reached, before further play.
    while (positions.lastIndexOf(positions.at(-1), positions.length - 2) < 0 && history.length) {
      history.pop(); positions.pop();
      const entry = history.at(-1);
      board = entry.boardAfter; turn = flip(entry.color);
    }
    const key = positions.at(-1), previous = positions.lastIndexOf(key, positions.length - 2);
    assert.ok(previous >= 0, `测试数据尚未闭合循环，源行 ${fixture.line}`);
    const cycle = history.slice(previous).map(entry => entry.move);
    while (positions.filter(p => p === key).length < 3) for (const m of cycle) push(m);
  }
  const outcome = getOutcome(board, turn, history);
  if (fixture.expected === 'Undecided') assert.equal(outcome, null);
  else { assert.ok(outcome, `未裁决，源行 ${fixture.line}`); assert.equal(outcome.winner, expectedWinner, `源行 ${fixture.line}，${outcome.reason}`); }
}

const WXF_REPETITION_FIXTURES = [
  {"line":309,"fen":"4ka3/4a4/4b4/p7p/9/4C4/4P4/4B4/3K5/3Ac1B2 w - - 0 1","expected":"Undecided","moves":[]},
  {"line":311,"fen":"c2a1k3/2c1a2R1/b6P1/8p/9/9/9/9/4K4/9 w - - 0 1","expected":"Loss","moves":["h8h9","f9f8","h9h8","f8f9","h8h9","f9f8"]},
  {"line":312,"fen":"c2a1k3/2c1a2R1/b6P1/8p/9/9/9/9/4K4/9 w - - 0 1","expected":"Win","moves":["h8h9","f9f8","h9h8","f8f9","h8h9","f9f8","h9h8"]},
  {"line":313,"fen":"9/4k4/9/9/9/9/9/9/2p6/3K1RBc1 w - - 0 1","expected":"Win","moves":["f0e0","e8f8","e0f0","f8e8","f0e0","e8f8","e0f0"]},
  {"line":314,"fen":"9/4k4/9/9/9/9/9/9/2p6/3K1RBc1 w - - 0 1","expected":"Loss","moves":["f0e0","e8f8","e0f0","f8e8","f0e0","e8f8"]},
  {"line":315,"fen":"4R4/3k5/5R3/9/9/2B6/n8/3pB4/4p4/3K5 w - - 0 1","expected":"Loss","moves":["e9d9","d8e8","d9e9","e8d8","e9d9","d8e8"]},
  {"line":316,"fen":"4R4/3k5/5R3/9/9/2B6/n8/3pB4/4p4/3K5 w - - 0 1","expected":"Win","moves":["e9d9","d8e8","d9e9","e8d8","e9d9","d8e8","d9e9"]},
  {"line":317,"fen":"4R4/3k5/5R3/9/9/2B6/n8/3pB4/4p4/3K5 w","expected":"Win","moves":["f7f8","d8d7","f8f7","d7d8","f7f8","d8d7","f8f7"]},
  {"line":318,"fen":"4R4/3k5/5R3/9/9/2B6/n8/3pB4/4p4/3K5 w","expected":"Loss","moves":["f7f8","d8d7","f8f7","d7d8","f7f8","d8d7","f8f7","d7d8"]},
  {"line":319,"fen":"3akr3/5c3/1P2b4/4R4/9/9/9/9/9/4CK3 w - - 0 1","expected":"Draw","moves":["e6e7","f8e8","e7f7","e8f8","f7e7","f8e8","e7f7"]},
  {"line":320,"fen":"3akr3/5c3/1P2b4/4R4/9/9/9/9/9/4CK3 w - - 0 1","expected":"Draw","moves":["e6e7","f8e8","e7f7","e8f8","f7e7","f8e8","e7f7","e8f8"]},
  {"line":322,"fen":"5c3/8R/4k2P1/3P5/5P3/6P2/5pN2/5A3/4CK3/6rn1 w","expected":"Win","moves":["f5e5","f3e3","e5f5","e3f3","f5e5","f3e3","e5f5","e3f3","f5e5"]},
  {"line":323,"fen":"5c3/8R/4k2P1/3P5/5P3/6P2/5pN2/5A3/4CK3/6rn1 w","expected":"Loss","moves":["f5e5","f3e3","e5f5","e3f3","f5e5","f3e3"]},
  {"line":326,"fen":"3ak1b2/4a4/4b4/r3C2R1/p8/9/P8/4p4/4p4/5K3 w","expected":"Draw","moves":["h6g6","g9i7","g6h6","i7g9","h6g6","g9i7"]},
  {"line":327,"fen":"2b2k3/9/4b2P1/3N5/1R6p/6P2/5p2r/8n/4p4/5K3 w","expected":"Draw","moves":["d6c8","f9f8","c8d6","f8f9","d6c8","f9f8","c8d6"]},
  {"line":328,"fen":"3aka3/4n4/4b4/4C4/p3p3p/9/2c6/2C6/4K4/9 w","expected":"Draw","moves":["c2g2","c3g3","g2c2","g3c3","c2g2","c3g3"]},
  {"line":329,"fen":"2bNka3/1N2aPP2/n3b4/p8/5c3/2C6/9/4B4/4A4/r1BK1A1n1 w","expected":"Draw","moves":["c4h4","f5h5","h4e4","h5e5","e4h4","e5h5","h4e4","h5e5"]},
  {"line":330,"fen":"5k3/2CPP4/9/9/9/9/9/B3p4/r8/4K4 w","expected":"Draw","moves":["e8f8","f9e9","e0f0","e2f2","f8e8","e9f9","f0e0","f2e2","e8f8","f9e9"]},
  {"line":331,"fen":"2bak4/4a4/4b4/8p/5R3/8P/n8/1r2C4/9/1cBAKAB2 w","expected":"Draw","moves":["f5h5","e9f9","h5f5","f9e9","f5h5","e9f9","h5f5","f9e9","f5h5"]},
  {"line":332,"fen":"2ba1k3/4a4/b8/7R1/9/9/1r2p4/9/4A4/2B1KAB1c w","expected":"Draw","moves":["h6h9","f9f8","h9h0","i0i1","h0h8","f8f9","h8h1","i1i0","h1h9","f9f8","h9h0"]},
  {"line":333,"fen":"2bak3r/2R1a2C1/2Rcb4/2N2P3/5C2p/9/9/4p4/4p2p1/5K3 w","expected":"Draw","moves":["f5e5","e9f9","e5f5","f9e9","f5e5","e9f9"]},
  {"line":335,"fen":"4ka3/2R1a4/C8/p7p/1P5n1/9/4n4/4B4/9/4K1B2 w","expected":"Draw","moves":["c8c9","e8d9","c9c8","d9e8","c8c9","e8d9"]},
  {"line":336,"fen":"1R1C1abr1/4k4/4b4/p7p/2p6/9/r1P3P2/B8/9/2B1KA3 w","expected":"Draw","moves":["b9b8","e8e9","b8b9","e9e8","b9b8","e8e9"]},
  {"line":337,"fen":"N1ra1a3/3nk4/4b4/p1p6/6b1p/2P6/P2R4P/4B4/4A4/2B1KA3 w","expected":"Draw","moves":["d3h3","e8e9","h3d3","e9e8","d3h3","e8e9"]},
  {"line":338,"fen":"3k1a3/4a1P2/8r/9/2R6/9/2P6/1p7/4An2n/3CKA3 w","expected":"Draw","moves":["c5c9","d9d8","c9c5","d8d9","c5c9","d9d8"]},
  {"line":340,"fen":"2c1kab2/4a4/4b4/9/9/9/P1p5P/2r1N1cC1/4A4/3ACK3 w","expected":"Win","moves":["e2d4","c2c1","h2h1","g2g1","e1d2","g1g0","d2e1","g0g1","e1d2","g1g0","d2e1"]},
  {"line":341,"fen":"2c1kab2/4a4/4b4/9/9/9/P1p5P/2r1N1cC1/4A4/3ACK3 w","expected":"Loss","moves":["e2d4","c2c1","h2h1","g2g1","e1d2","g1g0","d2e1","g0g1","e1d2","g1g0","d2e1","g0g1"]},
  {"line":343,"fen":"2ba1k3/4a4/b8/7R1/9/9/1r2p4/9/4A4/2B1KAB1c w","expected":"Win","moves":["h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6","h0i0","h6i6"]},
  {"line":344,"fen":"2ba1k3/4a4/b8/7R1/9/9/1r2p4/9/4A4/2B1KAB1c w","expected":"Loss","moves":["h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6","h0i0","h6i6","i0h0"]},
  {"line":345,"fen":"2bakab2/3r5/2n1c2c1/p1R1p1p2/7np/2P2CP2/P2rP3P/2N1C1N2/4A4/2B1KAB1R w","expected":"Win","moves":["f4f3","d3d7","f3f7","d7d3","f7f3","d3d7","f3f7"]},
  {"line":346,"fen":"2bakab2/3r5/2n1c2c1/p1R1p1p2/7np/2P2CP2/P2rP3P/2N1C1N2/4A4/2B1KAB1R w","expected":"Loss","moves":["f4f3","d3d7","f3f7","d7d3","f7f3","d3d7","f3f7","d7d3"]},
  {"line":347,"fen":"2bak4/4a4/4b4/2p5p/6p2/2Pp5/4P4/2N4C1/2CrA4/3AK4 w - - 0 1","expected":"Win","moves":["h2h1","d1d3","h1h3","d3d1","h3h1","d1d3","h1h3"]},
  {"line":348,"fen":"2bak4/4a4/4b4/8p/2p3p2/9/N2rP4/6NC1/C3A4/4K1B2 w - - 0 1","expected":"Win","moves":["h2h3","d3d1","h3h1","d1d3","h1h3","d3d1","h3h1"]},
  {"line":349,"fen":"2c1kab2/4a4/4b4/9/9/9/P1p5P/2r1N1cC1/4A4/3ACK3 w - - 0 1","expected":"Win","moves":["e2d4","g2g1","d4e2","g1g2","e2d4","g2g1","d4e2"]},
  {"line":350,"fen":"1r2kab2/4a4/4b4/p1p1p3p/5R3/2P2N3/PC2P3P/4Cr3/1R3c3/2B1KA3 w","expected":"Win","moves":["b3b2","f2f3","b2b3","f3f2","b3b2","f2f3","b2b3"]},
  {"line":351,"fen":"4kab2/4a4/4b4/c3C1p1R/8P/2B6/9/3AB1p2/1pr1A4/4K4 w","expected":"Win","moves":["e6c6","c1d1","c6d6","d1c1","d6c6","c1d1","c6d6"]},
  {"line":352,"fen":"2bak3r/4a4/4b1n2/P2rp3p/2p1c1p2/4R4/N3P3R/4BC1C1/N3A4/4KAB2 w","expected":"Win","moves":["f2f6","d6d4","f6f4","d4d6","f4f6","d6d4","f6f4"]},
  {"line":355,"fen":"2bak3r/4a4/4b1n2/P2rp3p/2p1c1p2/4R4/N3P3R/4BC1C1/N3A4/4KAB2 w","expected":"Win","moves":["h2h6","d6d3","f2f3","d3d1","h6h1","d1d6","f3f6","d6d3","h1h3","d3d1","f6f1","d1d6","h3h6","d6d3","f1f3","d3d1","h6h1"]},
  {"line":357,"fen":"2bck3r/4a4/3ab4/P2rp3p/2p1c4/4R4/N3P3P/4BC1C1/N3A4/4KAB2 w","expected":"Win","moves":["h2h6","d6d3","f2f3","d3d1","h6h1","d1d6","f3f6","d6d3","h1h3","d3d1","f6f1","d1d6","h3h6","d6d3","f1f3","d3d1","h6h1"]},
  {"line":360,"fen":"4k4/9/9/9/C8/9/pp5pp/4B4/9/r1BAKA2r w","expected":"Draw","moves":["a5i5","i0h0","i5a5","a0b0","a5h5","h0i0","h5b5","b0a0","b5i5","i0h0","i5a5"]},
  {"line":363,"fen":"2b1ka3/4a4/4b4/p2rp4/4n4/4R4/Pr2P2p1/4BC3/4A4/R3KAB2 w","expected":"Draw","moves":["f2f3","b3b1","f3f6","d6d3","f6f1","b1b6","f1f3","d3d1","f3f6","b6b3","f6f1","d1d6","f1f3","b3b1","f3f6"]},
  {"line":365,"fen":"2bak4/4a4/4b3n/p3p4/4n3p/4R4/Pr2P4/4BC1C1/3rA4/R3KAB2 w","expected":"Draw","moves":["f2f3","b3b6","h2h1","d1d5","f3f6","b6b2","h1h5","d5d3","f6f2","b2b1","h5h3","d3d5","f2f1","b1b6","f1f6","b6b1","h3h5","d5d3","f6f1","b1b6","h5h3","d3d5","f1f6","b6b1"]},
  {"line":368,"fen":"2b1ka3/4a4/4b4/9/9/9/9/4B3R/4A1rc1/4KA3 w","expected":"Draw","moves":["i2h2","h1i1","h2i2","i1h1","i2h2","h1i1"]},
  {"line":371,"fen":"2bak4/4a4/4b4/9/6c2/5R3/4c4/4C4/4N4/3AKA3 w","expected":"Draw","moves":["f4g4","g5c5","g4c4","c5g5","c4g4","g5c5","g4c4"]},
  {"line":373,"fen":"3k1a3/4a4/9/p1N3n2/4p1b1c/4c2R1/P8/4C4/4A4/2B1K1p2 w","expected":"Draw","moves":["h4i4","i5h5","i4h4","h5i5","h4i4","i5h5"]},
  {"line":376,"fen":"2bk1a3/4a4/4b4/9/c8/1R7/3r5/4B4/4A4/4KAB2 w","expected":"Win","moves":["b4a4","a5e5","a4e4","e5a5","e4a4","a5e5","a4e4"]},
  {"line":377,"fen":"2bk1a3/4a4/4b4/9/c8/1R7/3r5/4B4/4A4/4KAB2 w","expected":"Loss","moves":["b4a4","a5e5","a4e4","e5a5","e4a4","a5e5","a4e4","e5a5"]},
  {"line":379,"fen":"4kab2/4a4/4b4/3rC2R1/9/9/4n4/4B4/4A4/4KAB1c w","expected":"Win","moves":["h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6"]},
  {"line":380,"fen":"4kab2/4a4/4b4/3rC2R1/9/9/4n4/4B4/4A4/4KAB1c w","expected":"Loss","moves":["h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6","h0i0"]},
  {"line":383,"fen":"3aka3/7R1/7c1/9/9/9/9/9/4A4/3AK1p2 b","expected":"Win","moves":["h7c7","h8c8","c7h7","c8h8","h7c7","h8c8"]},
  {"line":385,"fen":"4k4/4a4/4b4/6c2/9/3R5/4c4/4C4/4N4/3AKA3 w","expected":"Win","moves":["d4g4","g6c6","g4c4","c6g6","c4g4","g6c6","g4c4"]},
  {"line":388,"fen":"1rbakab2/9/2c5n/4p3p/p8/7R1/P1P1P1P1P/2N3N2/4A4/2BAK1B2 w","expected":"Win","moves":["h4c4","c7g7","c4g4","g7c7","g4c4","c7g7","c4g4"]},
  {"line":389,"fen":"1rbakab2/9/2c5n/4p3p/p8/7R1/P1P1P1P1P/2N3N2/4A4/2BAK1B2 w","expected":"Loss","moves":["h4c4","c7g7","c4g4","g7c7","g4c4","c7g7","c4g4","g7c7"]},
  {"line":391,"fen":"3ak4/4a4/4b4/p8/2p3n2/9/P1P3r2/3AB4/c3N3N/1RB1KA3 w","expected":"Win","moves":["b0b1","a1a0","b1b0","a0a1","b0b1","a1a0","b1b0"]},
  {"line":394,"fen":"2bakar2/9/2c6/8R/p3p1p2/9/P1P1P1P1P/B1N6/1r2A4/2B1KA3 w","expected":"Win","moves":["i6c6","c7h7","c6h6","h7c7","h6c6","c7h7","c6h6"]},
  {"line":397,"fen":"2bak4/RC2arN2/4b1n2/2p5p/6p2/2P6/4p1P1c/4B4/4A4/4KAB2 b","expected":"Win","moves":["e8f9","b8b9","f9e8","b9b8","e8f9","b8b9"]},
  {"line":398,"fen":"2baka3/C4rN2/4b1n2/1Rp5p/6p2/2P6/4c1P1c/4B3C/4A4/4KAB2 w","expected":"Win","moves":["b6b8","f9e8","b8b6","e8f9","b6b8","f9e8","b8b6"]},
  {"line":399,"fen":"2baka3/C4rN2/4b1n2/1Rp5p/6p2/2P6/4c1P1c/4B3C/4A4/4KAB2 w","expected":"Loss","moves":["b6b8","f9e8","b8b6","e8f9","b6b8","f9e8"]},
  {"line":400,"fen":"3aka3/C4rN2/4b1n2/N7p/2p3p2/8P/2P3P2/9/4A4/4KA3 w","expected":"Win","moves":["a6b8","f9e8","b8a6","e8f9","a6b8","f9e8","b8a6"]},
  {"line":401,"fen":"3aka3/C4rN2/4b1n2/N7p/2p3p2/8P/2P3P2/9/4A4/4KA3 w","expected":"Loss","moves":["a6b8","f9e8","b8a6","e8f9","a6b8","f9e8"]},
  {"line":403,"fen":"1rb1kabr1/4a1c2/1cn3n2/p1C1p1R1p/9/9/P1P1P1P1P/2N1C1N2/9/R1BAKAB2 w","expected":"Win","moves":["g6f6","g7h5","f6g6","h5g7","g6f6","g7h5"]},
  {"line":406,"fen":"1rb1kabr1/4a1c2/1cn6/pRp1pR2p/7n1/2P2p3/P3P1P1P/C1N1C1N2/4A4/3AK1B2 w","expected":"Win","moves":["f6g6","h5g7","g6f6","g7h5","f6g6","h5g7"]},
  {"line":409,"fen":"r1b1kabr1/4a1c2/1cn6/p1p1pR2p/3NP2n1/9/P1P3p1P/1C2C4/4A4/RNBAK1B2 w","expected":"Win","moves":["f6g6","h5g7","g6f6","g7h5","f6g6","h5g7"]},
  {"line":412,"fen":"4ka3/1CP1a4/4b4/2p6/1cb1r4/4CN3/4Pp2P/4B4/4A4/2BAK4 w","expected":"Win","moves":["f4g6","e5e6","g6f4","e6e5","f4g6","e5e6","g6f4"]},
  {"line":413,"fen":"4ka3/1CP1a4/4b4/2p6/1cb1r4/4CN3/4Pp2P/4B4/4A4/2BAK4 w","expected":"Loss","moves":["f4g6","e5e6","g6f4","e6e5","f4g6","e5e6"]},
  {"line":416,"fen":"3ak1br1/4a4/4b4/p8/6p2/9/P7P/n7B/4A4/2R1KA3 w","expected":"Win","moves":["c0c2","a2b0","c2c1","b0a2","c1c2","a2b0","c2c1","b0a2"]},
  {"line":417,"fen":"3ak1br1/4a4/4b4/p8/6p2/9/P7P/n7B/4A4/2R1KA3 w","expected":"Loss","moves":["c0c2","a2b0","c2c1","b0a2","c1c2","a2b0","c2c1"]},
  {"line":421,"fen":"4kab2/4a4/8b/p1p5p/4c1n2/6R2/P1P1P1P1P/4BC3/8N/2B1KA1r1 w","expected":"Win","moves":["i1g2","h0g0","g2i1","g0h0","i1g2","h0g0","g2i1"]},
  {"line":424,"fen":"3akc3/4a4/9/9/3n5/1R7/9/9/4A4/4KAB2 w","expected":"Draw","moves":["b4b5","d5c3","b5c5","c3e4","c5c4","e4d6","c4d4","d6f5","d4d5","f5e3","d5e5","e3c4","e5e4","c4d6","e4d4","d6f5","d4d5"]},
  {"line":427,"fen":"4ka3/4a4/3Pb4/2p1r3p/2b6/2R6/1n7/4B4/4A4/4KAB2 w","expected":"Win","moves":["c4c3","b3a1","c3c1","a1b3","c1c3","b3a1","c3c1"]},
  {"line":428,"fen":"4ka3/4a4/3Pb4/2p1r3p/2b6/2R6/1n7/4B4/4A4/4KAB2 w","expected":"Loss","moves":["c4c3","b3a1","c3c1","a1b3","c1c3","b3a1","c3c1","a1b3"]},
  {"line":431,"fen":"3akr3/n3a4/4b4/9/P1b6/9/1n7/4B4/3RA4/2BAK4 w","expected":"Win","moves":["d1d3","b3c1","d3d1","c1b3","d1d3","b3c1","d3d1"]},
  {"line":432,"fen":"3akr3/n3a4/4b4/9/P1b6/9/1n7/4B4/3RA4/2BAK4 w","expected":"Loss","moves":["d1d3","b3c1","d3d1","c1b3","d1d3","b3c1"]},
  {"line":436,"fen":"2bak3r/4a4/4b4/p3C1R2/9/P8/5R3/9/4r4/5K3 w","expected":"Draw","moves":["g6i6","i9g9","i6g6","g9i9","g6i6","i9g9"]},
  {"line":438,"fen":"2b1ka3/4a4/4b4/p3r3p/9/1R7/P7P/2p1CpC2/4A1n2/2BK1AB1c w","expected":"Draw","moves":["b4b6","e6e3","b6b3","e3e6","b3b6","e6e3","b6b3"]},
  {"line":439,"fen":"2b1ka3/4a4/4b4/p3r3p/9/1R7/P7P/2p1CpC2/4A1n2/2BK1AB1c w","expected":"Draw","moves":["b4b6","e6e3","b6b3","e3e6","b3b6","e6e3","b6b3","e3e6"]},
  {"line":442,"fen":"Cc1ak4/4a1P2/9/2p6/1P7/6C2/9/B2p5/2p2p3/4K4 w","expected":"Win","moves":["g4b4","b9c9","b4c4","c9b9","c4b4","b9c9","b4c4"]},
  {"line":445,"fen":"3k1a1cC/4a4/4b4/9/6PP1/2C6/2p1p4/4B4/4A4/4KAB2 w","expected":"Draw","moves":["c4h4","h9g9","h4g4","g9h9","g4h4","h9g9","h4g4"]},
  {"line":448,"fen":"5ab2/4k2P1/5an1b/p1p3p2/8p/2P4N1/6P1P/B8/5p2c/3KC4 w","expected":"Win","moves":["h4f5","g7i6","f5h4","i6g7","h4f5","g7i6","f5h4"]},
  {"line":450,"fen":"4ka1nC/3Pa4/9/8p/8P/4c4/9/7C1/3p1p3/4K4 w","expected":"Win","moves":["i5h5","e4h4","h5g5","h4g4","g5h5","g4h4","h5g5","h4g4","g5h5"]},
  {"line":451,"fen":"4ka1nC/3Pa4/9/8p/8P/4c4/9/7C1/3p1p3/4K4 w","expected":"Loss","moves":["i5h5","e4h4","h5g5","h4g4","g5h5","g4h4","h5g5","h4g4"]},
  {"line":454,"fen":"4k1b2/4n4/3aba3/4p4/9/8P/P2nP4/2N1BA3/8c/2BK2C2 w","expected":"Win","moves":["g0f0","i1f1","f2e1","f1h1","e1f2","h1f1","f2e1","f1h1","e1f2"]},
  {"line":455,"fen":"4k1b2/4n4/3aba3/4p4/9/8P/P2nP4/2N1BA3/8c/2BK2C2 w","expected":"Loss","moves":["g0f0","i1f1","f2e1","f1h1","e1f2","h1f1","f2e1","f1h1"]},
  {"line":457,"fen":"2bakab2/9/4c3n/p1prp3R/9/2P6/P3P1c1P/2N1BC2B/4A4/3AK4 w","expected":"Win","moves":["f2g2","g3f3","i2g4","f3g3","g4i2","g3f3","i2g4"]},
  {"line":460,"fen":"3akabC1/9/4b4/7P1/2n6/8p/3p5/9/4A1c2/2BAK1B1C w","expected":"Win","moves":["g0i2","g1i1","i2g0","i1g1","g0i2","g1i1","i2g0"]},
  {"line":462,"fen":"3akabC1/9/4b4/7P1/2n5p/9/3p5/9/4A1c2/2BAK1B1C w","expected":"Draw","moves":["g0i2","g1i1","i2g0","i1g1","g0i2","g1i1","i2g0"]},
  {"line":464,"fen":"3akabC1/9/4b4/r3p4/p1p6/4P4/P1P5n/NCr1B4/4A4/R2AK1B2 w","expected":"Win","moves":["h9h2","i3g2","e2g4","g2h4","g4e2","h4g2","e2g4","g2h4","g4e2"]},
  {"line":465,"fen":"3akabC1/9/4b4/r3p4/p1p6/4P4/P1P5n/NCr1B4/4A4/R2AK1B2 w","expected":"Loss","moves":["h9h2","i3g2","e2g4","g2h4","g4e2","h4g2","e2g4","g2h4"]},
  {"line":467,"fen":"4kab2/4a4/4b3n/2r3p1p/2p2N3/9/1RP3P1P/4B3C/2r1A4/2N1KABc1 w","expected":"Win","moves":["i2i1","c1c2","i1i2","c2c1","i2i1","c1c2","i1i2"]},
  {"line":468,"fen":"4kab2/4a4/4b3n/2r3p1p/2p2N3/9/1RP3P1P/4B3C/2r1A4/2N1KABc1 w","expected":"Loss","moves":["i2i1","c1c2","i1i2","c2c1","i2i1","c1c2"]},
  {"line":469,"fen":"4kab2/4a4/4b3n/2r3p1p/2p2N3/9/1RP3P1P/4B3C/2r1A4/2N1KABc1 w","expected":"Win","moves":["i2i1","h0h1","e1d0","h1h0","d0e1","h0h1","e1d0"]},
  {"line":470,"fen":"4kab2/4a4/4b3n/2r3p1p/2p2N3/9/1RP3P1P/4B3C/2r1A4/2N1KABc1 w","expected":"Loss","moves":["i2i1","h0h1","e1d0","h1h0","d0e1","h0h1","e1d0","h1h0"]},
  {"line":472,"fen":"4ka3/4a4/9/4r4/9/9/9/1C2C4/p3A4/3K1AB1n w","expected":"Draw","moves":["b2b6","e6e5","b6b5","e5e6","b5b6","e6e5","b6b5"]},
  {"line":474,"fen":"3aka3/4c4/4r4/9/9/9/PR7/2p1CA3/7p1/2B2K3 w","expected":"Win","moves":["b3b7","e7e3","b7b3","e3e4","b3b4","e4e3","b4b3","e3e4","b3b4"]},
  {"line":475,"fen":"3aka3/4c4/4r4/9/9/9/PR7/2p1CA3/7p1/2B2K3 w","expected":"Loss","moves":["b3b7","e7e3","b7b3","e3e4","b3b4","e4e3","b4b3","e3e4","b3b4","e4e3"]},
  {"line":477,"fen":"5kb2/4a4/4ba3/5r3/9/P6R1/3cpCpc1/4BA3/4A4/2BK5 w","expected":"Win","moves":["h4h6","f6f5","h6h5","f5f6","h5h6","f6f5","h6h5"]},
  {"line":478,"fen":"5kb2/4a4/4ba3/5r3/9/P6R1/3cpCpc1/4BA3/4A4/2BK5 w","expected":"Loss","moves":["h4h6","f6f5","h6h5","f5f6","h5h6","f6f5","h6h5","f5f6"]},
  {"line":480,"fen":"2bk1a1rC/4a1R2/4b4/9/9/4cp3/9/4B4/N3Ap3/2BAK4 w","expected":"Draw","moves":["g8h8","h9g9","h8g8","g9h9","g8h8","h9g9","h8g8","g9h9","g8h8"]},
  {"line":483,"fen":"4ka3/4a4/4b4/p7p/9/4C4/4P4/4B4/3K5/3Ac1B2 w","expected":"Draw","moves":["d1e1","e0f0","e1f1","f0e0","f1e1","e0f0","e1f1"]},
  {"line":484,"fen":"3k2b1r/4a4/5a2b/3PP4/7P1/9/9/B4N2B/5K3/4p4 w","expected":"Draw","moves":["f1e1","e0d0","e1d1","d0e0","d1e1","e0d0","e1d1"]},
  {"line":485,"fen":"4k1b1c/7P1/3a5/9/9/9/9/9/3K5/9 w","expected":"Draw","moves":["h8i8","i9h9","i8h8","h9i9","h8i8","i9h9","i8h8"]},
  {"line":486,"fen":"4kab2/4a4/4b1n2/4p2P1/2p5P/9/9/7C1/4A4/4K4 w","expected":"Draw","moves":["h6g6","g7h9","g6h6","h9g7","h6g6","g7h9"]},
  {"line":489,"fen":"3a2b1r/4ak3/8p/7P1/9/9/9/B2NN3B/3K5/4p4 w","expected":"Win","moves":["d1e1","e0d0","e1d1","d0e0","d1e1","e0d0","e1d1"]},
  {"line":490,"fen":"1c1ak4/N1PNa4/9/9/5P3/9/9/4Bp3/9/3p1K1p1 w","expected":"Win","moves":["c8b8","b9c9","b8c8","c9b9","c8b8","b9c9","b8c8"]},
  {"line":491,"fen":"1Pbak2r1/4a4/4b4/2p6/9/3R5/2P6/4p2p1/3CC2N1/5K3 w","expected":"Win","moves":["d4e4","e2d2","e4d4","d2e2","d4e4","e2d2","e4d4","d2e2","d4e4"]},
  {"line":492,"fen":"1Pbak2r1/4a4/4b4/2p6/9/3R5/2P6/4p2p1/3CC2N1/5K3 w","expected":"Loss","moves":["d4e4","e2d2","e4d4","d2e2","d4e4","e2d2","e4d4","d2e2"]},
  {"line":493,"fen":"3akab2/c2R1R2c/4b4/9/9/9/9/4B4/4K4/2B6 w","expected":"Draw","moves":["d8d6","d9e8","d6d8","e8d9","f8f6","f9e8","f6f8","e8f9","d8d6","d9e8"]},
  {"line":494,"fen":"2bak4/4a4/4b4/1rp6/P2R5/4pp3/9/CC7/4p4/5K3 w","expected":"Win","moves":["a5b5","b6a6","b5a5","a6b6","a5b5","b6a6","b5a5"]},
  {"line":495,"fen":"2bak4/4a4/4b4/1rp6/P2R5/4pp3/9/CC7/4p4/5K3 w","expected":"Loss","moves":["a5b5","b6a6","b5a5","a6b6","a5b5","b6a6","b5a5","a6b6"]},
  {"line":496,"fen":"3rk1b2/4a4/3ab2r1/5R1N1/9/4p4/9/4B4/4A4/3AK1B2 w","expected":"Win","moves":["f6e6","e4f4","e6f6","f4e4","f6e6","e4f4","e6f6"]},
  {"line":497,"fen":"3rk1b2/4a4/3ab2r1/5R1N1/9/4p4/9/4B4/4A4/3AK1B2 w","expected":"Loss","moves":["f6e6","e4f4","e6f6","f4e4","f6e6","e4f4"]},
  {"line":498,"fen":"1Pbak2r1/4a4/4b4/2p6/9/3R5/2P6/4p2p1/3CC2N1/5K3 w","expected":"Win","moves":["d4e4","e2d2","e4d4","d2e2","d4e4","e2d2","e4d4"]},
  {"line":499,"fen":"1Pbak2r1/4a4/4b4/2p6/9/3R5/2P6/4p2p1/3CC2N1/5K3 w","expected":"Loss","moves":["d4e4","e2d2","e4d4","d2e2","d4e4","e2d2"]},
  {"line":502,"fen":"4kab2/4a4/3rb4/9/9/9/8R/1p5p1/4A4/3AK1B2 w","expected":"Win","moves":["i3h3","h2g2","h3g3","g2h2","g3h3","h2g2","h3g3"]},
  {"line":504,"fen":"2rakab2/9/8b/2NPP1p2/9/2P1c1P2/7R1/2n1B1p2/4A4/3AK1B2 w","expected":"Draw","moves":["h3c3","c2a1","c3e3","e4f4","e3f3","f4e4","f3g3","g2h2","g3a3","a1c0","a3c3","c0a1","c3e3","e4f4","e3f3","f4e4","f3h3","h2g2","h3a3","a1c0","a3c3","c0a1","c3e3","e4f4"]},
  {"line":505,"fen":"2rakab2/9/8b/2NPP1p2/9/2P1c1P2/7R1/2n1B1p2/4A4/3AK1B2 w","expected":"Win","moves":["h3c3","c2a1","c3a3","a1c2","a3c3","c2a1","c3a3"]},
  {"line":507,"fen":"3aka3/9/4b4/p8/2b6/2N3B2/4P3p/2C1B4/3rA1p2/3AK4 w","expected":"Win","moves":["c2c3","d1d3","c3c1","d3d1","c1c3","d1d3","c3c1","d3d1"]},
  {"line":509,"fen":"3rkabc1/4a3R/4b4/9/9/9/9/B8/1R2A4/c1BAK4 w","expected":"Draw","moves":["i8h8","h9i9","b1a1","a0b0","h8i8","i9h9","i8h8","h9i9","a1b1","b0a0","b1a1","a0b0"]},
  {"line":510,"fen":"3rkabc1/4a3R/4b4/9/9/9/9/B8/1R2A4/c1BAK4 w","expected":"Win","moves":["b1a1","a0b0","a1b1","b0a0","b1a1","a0b0","a1b1"]},
  {"line":512,"fen":"2b1ka1P1/4a4/b8/p5R2/8c/7R1/P1p3p2/3rBn3/N2C2n1C/3K1NB2 w","expected":"Win","moves":["h4h5","i5i7","g6g7","i7i6","h5h6","i6i5","g7g5","i5i7","h6h7","i7i6","g5g6","i6i5","h7h5","i5i7","h5h7"]},
  {"line":515,"fen":"4k4/9/9/9/3P5/4C4/2N6/6ppc/4p4/5K3 w","expected":"Win","moves":["c3e2","e1d1","e2c3","d1e1","c3e2","e1d1","e2c3"]},
  {"line":516,"fen":"4k4/9/9/9/3P5/4C4/2N6/6ppc/4p4/5K3 w","expected":"Loss","moves":["c3e2","e1d1","e2c3","d1e1","c3e2","e1d1"]},
  {"line":519,"fen":"2baka3/9/4b4/9/6c2/3R5/4c4/4C4/4N4/3AKA3 w","expected":"Win","moves":["d4g4","g5d5","g4d4","d5g5","d4g4","g5d5","g4d4"]},
  {"line":520,"fen":"2baka3/9/4b4/9/6c2/3R5/4c4/4C4/4N4/3AKA3 w","expected":"Loss","moves":["d4g4","g5d5","g4d4","d5g5","d4g4","g5d5","g4d4","d5g5"]},
  {"line":522,"fen":"1r2knb1C/4a4/5ac1b/7R1/p8/9/9/9/4A4/3AK4 w","expected":"Win","moves":["h6g6","g7h7","g6h6","h7g7","h6g6","g7h7","g6h6"]},
  {"line":523,"fen":"1r2knb1C/4a4/5ac1b/7R1/p8/9/9/9/4A4/3AK4 w","expected":"Loss","moves":["h6g6","g7h7","g6h6","h7g7","h6g6","g7h7"]},
  {"line":526,"fen":"2bakab2/r4rN2/6P2/p3P3p/9/P5R2/5c2P/4B4/4A4/3AK1B2 w","expected":"Win","moves":["g4g3","f3f6","g3g6","f6f3","g6g3","f3f6","g3g6"]},
  {"line":529,"fen":"3akab2/9/4b3r/8c/p8/7R1/P8/9/4A4/r1BAK3R w","expected":"Draw","moves":["h4h6","i6i3","h6h3","i3i6","h3h6","i6i3","h6h3"]},
  {"line":532,"fen":"1r2kab2/4a4/4b4/4R3p/5P3/2R6/4c4/4r4/4A4/2B1KA3 w","expected":"Draw","moves":["c4c3","e3e4","c3c4","e4e3","c4c3","e3e4"]},
  {"line":534,"fen":"2b1ka2c/4a4/4b3r/8c/p8/9/P4R3/8R/4A4/r1BAK3C w","expected":"Draw","moves":["f3f6","i6i5","f6f5","i5i4","f5f4","i4i6","f4f6","i6i5","f6f5"]},
  {"line":537,"fen":"4kab2/4a3c/2n1bc3/2R6/8p/C8/8P/3CB4/4A4/4KAB2 w","expected":"Draw","moves":["d2c2","c7a8","c6a6","a8c7","a6c6","c7a8","c6a6"]},
  {"line":539,"fen":"2bak1r2/4a4/1C2b4/9/6p2/9/9/9/7R1/c1BAK4 w","expected":"Win","moves":["h1a1","a0b0","a1b1","b0a0","b1a1","a0b0","a1b1"]},
  {"line":540,"fen":"2bak1r2/4a4/1C2b4/9/6p2/9/9/9/7R1/c1BAK4 w","expected":"Loss","moves":["h1a1","a0b0","a1b1","b0a0","b1a1","a0b0","a1b1","b0a0"]},
  {"line":541,"fen":"2bak4/4a4/4b4/CC7/3r5/1R7/5r3/4B4/4A4/c3KAB2 w","expected":"Win","moves":["b4a4","a0b0","a4b4","b0a0","b4a4","a0b0","a4b4"]},
  {"line":542,"fen":"2bak4/4a4/4b4/CC7/3r5/1R7/5r3/4B4/4A4/c3KAB2 w","expected":"Loss","moves":["b4a4","a0b0","a4b4","b0a0","b4a4","a0b0"]},
  {"line":544,"fen":"2bak4/4a4/4b1n2/4p3p/9/1p1r5/c3RR3/B2CC3B/4p4/2p2K3 w","expected":"Win","moves":["e3d3","d4e4","d3e3","e4d4","e3d3","d4e4","d3e3"]},
  {"line":545,"fen":"2bak4/4a4/4b1n2/4p3p/9/1p1r5/c3RR3/B2CC3B/4p4/2p2K3 w","expected":"Loss","moves":["e3d3","d4e4","d3e3","e4d4","e3d3","d4e4","d3e3","e4d4"]},
  {"line":547,"fen":"1r1ak1b2/N1RNC4/4b4/9/9/9/4P4/9/4p4/5K3 w","expected":"Win","moves":["c8b8","b9c9","b8c8","c9b9","c8b8","b9c9","b8c8"]},
  {"line":548,"fen":"5k3/4P4/9/9/9/9/9/5N3/9/3KRr1c1 w","expected":"Win","moves":["f2h1","f0g0","h1f2","g0f0","f2h1","f0g0","h1f2"]},
  {"line":549,"fen":"4k4/9/4c4/6PC1/9/9/9/4BN3/4A4/3AKR1rc w","expected":"Win","moves":["f2h1","h0g0","h1f2","g0h0","f2h1","h0g0","h1f2"]},
  {"line":551,"fen":"C4k3/3P5/9/5c3/1P7/2B6/2P2r3/3p1R3/5K3/9 w","expected":"Win","moves":["a9a3","f3f5","a3a5","f5f3","a5a3","f3f5","a3a5"]},
  {"line":554,"fen":"C1Na5/3Rak3/4bc3/2p6/n5b2/9/1p6r/4B4/4A4/2B1KA3 w","expected":"Draw","moves":["a9a8","f8f9","a8a9","f9f8","a9a8","f8f9"]},
  {"line":555,"fen":"5k3/1n7/9/3P5/P1r5c/2B5R/6P2/4B4/4A4/3AK4 w","expected":"Draw","moves":["i4h4","i5h5","h4g4","h5g5","g4i4","g5i5","i4h4","i5h5"]},
  {"line":557,"fen":"4k4/3P2P1P/9/9/6b1c/5p1C1/9/9/4A4/3AK1p2 w","expected":"Draw","moves":["h4i4","i5h5","i4h4","h5i5","h4i4","i5h5"]},
  {"line":558,"fen":"4k1b2/3P5/c3b2c1/7R1/9/9/9/9/4K4/9 w","expected":"Draw","moves":["h6f6","h7f7","f6i6","f7i7","i6b6","a7b7","b6g6","i7g7","g6f6","g7f7","f6h6","f7h7","h6b6","b7a7","b6h6","h7f7","h6f6","f7h7","f6h6","h7f7","h6f6"]},
  {"line":560,"fen":"4k4/3P2P1P/9/9/6b1c/5p1C1/9/9/4A4/3AK1p2 w","expected":"Draw","moves":["h4i4","i5h5","i4h4","h5i5","h4i4","i5h5","i4h4"]},
  {"line":561,"fen":"4k4/3P2P1P/9/9/6b1c/5p1C1/9/9/4A4/3AK1p2 w","expected":"Draw","moves":["h4i4","i5h5","i4h4","h5i5","h4i4","i5h5"]},
  {"line":562,"fen":"2bak4/4a4/4b4/9/2p2r3/r8/1R7/4B4/9/1R2K1B2 w","expected":"Draw","moves":["b3b4","a4a1","b4b1","a1a3","b1b3","a3a6","b3b6","a6a8","b6b8","a8a1","b8b1","a1a3","b1b3"]},
  {"line":563,"fen":"3r1k3/4P4/9/c1p2r3/9/2R6/9/4B4/4A4/4K1B2 w","expected":"Draw","moves":["c4g4","f6g6","g4h4","g6h6","h4f4","h6f6","f4i4","f6i6","i4h4","i6h6","h4g4","h6g6","g4h4","g6h6"]},
  {"line":564,"fen":"2bk5/3c5/4bN3/1R2p4/9/9/3r5/3R1p3/3K5/9 w","expected":"Draw","moves":["b6b3","d3d4","b3b4","d4d6","b4b6","d6d3","b6b3","d3d4"]},
  {"line":565,"fen":"2bk5/3c5/4bN3/1R2p4/9/9/3r5/3R1p3/3K5/9 w","expected":"Draw","moves":["b6b3","d3d4","b3b4","d4d3","b4b3","d3d4","b3b4"]},
  {"line":566,"fen":"1r1ak4/4aP3/b1P1b4/4C4/9/3R5/9/9/4p4/3K5 w","expected":"Draw","moves":["c7b7","b9c9","b7c7","c9b9","c7b7","b9c9"]},
  {"line":570,"fen":"2ca1k3/4a4/b3b4/2P5P/6p2/1c7/9/B7N/2nR5/2BAK4 w","expected":"Win","moves":["c6b6","e7c5","b6c6","c5e7","c6b6","e7c5","b6c6"]},
  {"line":573,"fen":"3k2b2/4P4/4b4/9/8p/6Bc1/6P1P/3AB4/4pp3/1p1K3R1 w","expected":"Draw","moves":["h0h1","h4h3","h1h0","h3h4","h0h1","h4h3"]},
  {"line":574,"fen":"3k2b2/4P4/4b4/9/8p/6Bc1/6P1P/3AB4/4pp3/1p1K3R1 w","expected":"Draw","moves":["h0h1","h4h3","h1h0","h3h4","h0h1","h4h3","h1h0"]},
  {"line":576,"fen":"3akab2/c2R1R2c/4b4/9/9/9/9/4B4/4K4/2B6 w","expected":"Draw","moves":["d8d6","d9e8","d6d8","e8d9","f8f6","f9e8","f6f8","e8f9","d8d6","d9e8"]},
  {"line":578,"fen":"3ak1b2/4a4/4b4/9/2c6/2R6/9/4C4/4A4/2BAK1B2 b","expected":"Win","moves":["c5g5","c4g4","g5c5","g4c4","c5g5","c4g4"]},
  {"line":579,"fen":"3ak1b2/4a4/4b4/9/2c6/2R6/9/4C4/4A4/2BAK1B2 b","expected":"Loss","moves":["c5g5","c4g4","g5c5","g4c4","c5g5","c4g4","g5c5"]},
  {"line":580,"fen":"3aka3/r4rN2/6P2/p3P3p/9/6R2/P4c2P/4B4/4A4/3AK1B2 w","expected":"Win","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4","g3g4"]},
  {"line":581,"fen":"3aka3/r4rN2/6P2/p3P3p/9/6R2/P4c2P/4B4/4A4/3AK1B2 w","expected":"Loss","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4"]},
  {"line":582,"fen":"4ka3/1r3cN2/5aP2/p3P3p/9/6R2/P4c2P/4B4/4A4/3AK1B2 w","expected":"Win","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4","g3g4"]},
  {"line":583,"fen":"4ka3/1r3cN2/5aP2/p3P3p/9/6R2/P4c2P/4B4/4A4/3AK1B2 w","expected":"Loss","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4"]},
  {"line":584,"fen":"4ka3/2r2cN2/5aP2/p3P3p/9/6R2/P4c2P/9/4A4/2BAK1B2 w","expected":"Win","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4","g3g4"]},
  {"line":585,"fen":"4ka3/2r2cN2/5aP2/p3P3p/9/6R2/P4c2P/9/4A4/2BAK1B2 w","expected":"Loss","moves":["g4g3","f3f4","g3g4","f4f3","g4g3","f3f4"]},
  {"line":587,"fen":"4kab2/4a4/4b4/3rC2R1/9/9/4n4/4B4/4A4/4KAB1c w","expected":"Win","moves":["h6i6","i0h0","i6h6","h0i0","h6i6","i0h0","i6h6"]},
  {"line":590,"fen":"1cbak4/R3a4/4b4/7P1/9/2P6/3pp4/8r/9/3AKA3 w","expected":"Win","moves":["a8b8","b9a9","b8a8","a9b9","a8b8","b9a9","b8a8"]},
  {"line":591,"fen":"1cbak4/R3a4/4b2C1/7P1/9/2P6/3pp4/8r/9/3AKA3 w","expected":"Win","moves":["a8b8","b9a9","b8a8","a9b9","a8b8","b9a9","b8a8","a9b9","a8b8"]},
  {"line":593,"fen":"1cbak4/R3a4/9/9/7r1/9/9/4B4/4A4/3AKCB2 w - - 0 1","expected":"Undecided","moves":[]},
  {"line":594,"fen":"1cbak4/R3a4/4b2C1/7P1/9/2P6/3pp4/8r/9/3AKA3 w","expected":"Loss","moves":["a8b8","b9a9","b8a8","a9b9","a8b8","b9a9","b8a8","a9b9"]},
  {"line":596,"fen":"2b1k1r2/9/4b4/9/9/2P3P2/1R7/2n1B4/4A4/4KABC1 w","expected":"Win","moves":["b3c3","c2b0","c3b3","b0c2","b3c3","c2b0","c3b3"]},
  {"line":597,"fen":"2bak4/4a4/4b4/9/2p2r3/r8/1R7/4B4/9/1R2K1B2 w","expected":"Draw","moves":["b3b4","a4a3","b4b3","a3a4","b3b4","a4a3"]},
  {"line":599,"fen":"2bakab2/6c2/2C3c2/p1N1p3p/1R1P5/5r3/P2CP1n1P/4B1p2/4A4/4KAB2 w","expected":"Win","moves":["b5b8","f9e8","c7c8","e8f9","c8c7","f9e8","c7c8","e8f9","c8c7","f9e8"]},
  {"line":600,"fen":"2bakab2/6c2/2C3c2/p1N1p3p/1R1P5/5r3/P2CP1n1P/4B1p2/4A4/4KAB2 w","expected":"Loss","moves":["b5b8","f9e8","c7c8","e8f9","c8c7","f9e8","c7c8","e8f9","c8c7"]}
];
for (const fixture of WXF_REPETITION_FIXTURES) test(`WXF 循环棋例：来源行 ${fixture.line} ${fixture.expected}`, () => runRepetitionFixture(fixture));

const WXF_PROTECTION_FIXTURES = [
  {"line":150,"fen":"2eak1er1/4a4/2h1c2ch/p1p1p1p2/8R/1R7/P1P1PrP2/2H1CCH2/4A4/2EAK1E2 b","move":"f3g3","expected":false},
  {"line":151,"fen":"4kae2/4a4/4e1hC1/2H1p1p2/8p/P4HP2/4h4/4C4/4A4/2E1KAE1c b","move":"i5i4","expected":false},
  {"line":152,"fen":"4kae2/4a4/4e1hC1/2H1p1p2/8p/P4HP2/4h4/4C4/4A4/2E1KAE1c b","move":"g6g5","expected":true},
  {"line":153,"fen":"4k4/6n2/4b4/9/7P1/6P2/9/9/6R2/4K4 b - - 0 1","move":"g8h6","expected":true},
  {"line":154,"fen":"4k4/9/4b4/9/7P1/6P2/9/9/6R2/4K4 w - - 0 1","move":"g4g5","expected":false},
  {"line":155,"fen":"4k4/9/4b4/9/7P1/6P2/9/9/6R2/4K4 w - - 0 1","move":"h5g5","expected":false},
  {"line":156,"fen":"9/3ka2H1/4h4/5C3/5C3/9/9/9/4A4/4K4 w","move":"h8f9","expected":true},
  {"line":157,"fen":"9/3ka2H1/4ha3/5C3/5C3/9/9/9/4A4/4K4 w","move":"h8f9","expected":true},
  {"line":158,"fen":"C1nNk4/9/9/9/9/9/n1p6/B3C4/3pA4/4K4 w","move":"e0d0","expected":true},
  {"line":159,"fen":"r2akae1r/3h5/2c1e1hc1/p1p1p1p1p/9/1HP6/P3P1P1P/1C2E1HC1/9/R2AKAE1R b","move":"g6g5","expected":false},
  {"line":160,"fen":"4kae2/4a4/4e1hC1/2H1p1H2/9/P5P1p/4h4/4C4/4A4/2E1KAE1c b","move":"i4i3","expected":false},
  {"line":161,"fen":"5k3/4a4/3a5/9/1P2H4/9/7p1/3KC2h1/4A3c/2E2A3 b","move":"h3g3","expected":false},
  {"line":162,"fen":"2eakaer1/9/h3cc3/p8/9/4R1P2/P3pr2P/H2CE1H2/4A4/2EAK1C2 b","move":"e3e2","expected":true},
  {"line":163,"fen":"R4a3/3ka4/9/6p2/9/8r/P1h1P4/3C1R2C/2c2K3/3A2r2 b","move":"g0g1","expected":false},
  {"line":164,"fen":"1r2ka1R1/4a4/4H4/ph3R2p/6p2/4c4/P7P/4C1r2/4A4/2EAK1E2 w","move":"h9f9","expected":true},
  {"line":165,"fen":"r1e1ka3/1R2a4/h2ce4/2p1C1p2/p7r/2P3P2/P3P3P/9/9/2EAKAER1 w","move":"b8e8","expected":true},
  {"line":166,"fen":"2Rak1e2/4ah3/4c4/p7p/5r3/4h1P2/P1P1r3P/4C1H2/9/1REAKAE2 b","move":"e3e2","expected":true},
  {"line":167,"fen":"2e1kae2/4a4/2h6/3R2p1p/p1H6/1c3hP2/2P1r4/4C4/4A4/2E1KAR2 w","move":"c5d7","expected":false},
  {"line":168,"fen":"1R3ae2/3kaR3/4ec2h/p1p1r1p2/3H4p/6P2/2Pr4P/3C5/4A4/2E1KAE2 w","move":"d5c7","expected":false},
  {"line":169,"fen":"C1eak4/2R1a4/4Rc3/3r3rp/6p2/pp1h5/h3P3P/C3E1H2/4A4/3AK1E2 w","move":"c8e8","expected":false},
  {"line":170,"fen":"C4a3/3ka1c2/eHR1e4/8p/3rC1p2/4h4/P5P1P/4E4/4A4/1cEAK4 w","move":"c7c5","expected":false},
  {"line":171,"fen":"3akae2/rr7/1h2e4/2p1p1H1H/9/3R2P1P/p2R5/3CE2C1/9/3AKAE2 w","move":"d4d9","expected":false},
  {"line":172,"fen":"3a5/3Hak3/4e4/4p3p/9/2P1P4/4h3P/5rhR1/4K1C2/2EA2E2 b","move":"f2f1","expected":false},
  {"line":173,"fen":"3a5/3Hak3/4e4/4p3p/9/2P1P4/8P/5rhR1/4K1C2/2EA2E2 b","move":"f2f1","expected":false},
  {"line":174,"fen":"1C2k4/3PaR3/e8/p5h1p/9/4P4/P5P1P/3Ac1H2/9/1H1A1K3 w","move":"d8e8","expected":true},
  {"line":175,"fen":"4k1e2/3R1R3/4e1r2/p3p3p/9/7r1/P7P/H3E4/4A4/2E1Kc3 w","move":"f8e8","expected":false},
  {"line":176,"fen":"2ek5/4R4/9/8p/2e6/9/3hCr2P/4EH3/3p1K3/9 b","move":"d1e1","expected":false},
  {"line":177,"fen":"9/1H1ka2H1/5a3/3P5/2e6/c8/1p7/8E/9/2EAKA3 w","move":"d6d7","expected":true},
  {"line":178,"fen":"2eakc3/3Ra2R1/h3e4/p3C3p/2p1P4/9/P5r1P/5A3/3K4c/5r3 w","move":"h8e8","expected":true},
  {"line":179,"fen":"2ea1k3/4a4/4e4/3R4p/p1P3p2/3h1C2P/9/c1hr2H2/1c2K4/2E2AE2 b","move":"d2e2","expected":false},
  {"line":180,"fen":"1Ccak1e2/3RaR3/5c3/p3r4/2e3p2/2P6/P3r4/4E3H/9/3AKAE2 w","move":"f8e8","expected":true},
  {"line":181,"fen":"2ek5/4a4/9/6HRp/3rH4/9/4P3P/4E4/9/1cEAK4 b","move":"d5d0","expected":false},
  {"line":182,"fen":"2ek5/4a4/9/6HRp/3rH4/9/4P3P/4E4/9/2EAK4 b","move":"d5d0","expected":false},
  {"line":183,"fen":"2ek5/4a4/9/6HRp/4H4/9/4P3P/4E4/9/1cEAK4 b","move":"b0d0","expected":false},
  {"line":184,"fen":"4ka3/4a4/9/4p4/p1p3e2/4r4/c1P6/8R/4Ap3/4K4 b","move":"f1e1","expected":false},
  {"line":185,"fen":"3ck4/1R2aH3/e8/p3R4/9/9/P8/4p4/4Ap3/4KA1r1 w","move":"b8e8","expected":false},
  {"line":186,"fen":"3c1k3/4RH3/e8/p3R4/9/9/P8/4p4/4Ap3/4KA1r1 w","move":"e8e9","expected":false},
  {"line":187,"fen":"4k1e2/5c3/3a1a3/p8/2e6/4H4/9/9/4K2h1/9 b","move":"h1f2","expected":false},
  {"line":188,"fen":"2ea3r1/5k3/4eaR2/5H2p/p4C3/4P4/h7P/4E4/4A4/2EAK4 w","move":"g7f7","expected":false},
  {"line":189,"fen":"5kC2/3R5/4c1h2/p5p1p/2P1H4/P5P1P/9/4p4/4A4/2EAKh2r b","move":"e2e1","expected":true},
  {"line":190,"fen":"4k1e2/3PaR3/9/9/2e6/9/9/8p/5K3/4r4 w","move":"d8e8","expected":true},
  {"line":191,"fen":"3R5/1C3k3/3P5/9/9/8P/5p3/4E4/4K4/2Er4c w","move":"d7d8","expected":false},
  {"line":192,"fen":"3akae2/9/4e4/p8/9/9/3R5/4rA3/r3A4/3RK4 w","move":"d3d9","expected":false},
  {"line":193,"fen":"3aka3/4r4/4R4/p7p/2p3p2/4C4/P3R1P2/4E4/4A4/4KAE2 w","move":"e4e8","expected":false},
  {"line":194,"fen":"4k4/9/9/4p4/9/9/9/9/3pA4/2pAK4 b - - 0 1","move":"c0d0","expected":true},
  {"line":195,"fen":"2eak1e2/4a4/2R6/p3p4/6r1p/9/P4h2P/H3E4/3C1C3/1RE1KA1r1 b","move":"h0f0","expected":true}
];
for (const fixture of WXF_PROTECTION_FIXTURES) test(`WXF 根分析：来源行 ${fixture.line}`, () => {
  const { board } = fromFen(fixture.fen);
  assert.equal(isProtected(board, ucciMove(fixture.move)), fixture.expected);
});
