const other = color => color === 'red' ? 'black' : 'red';
const xy = square => [square % 9, Math.floor(square / 9)];
const index = (x, y) => y * 9 + x;
const inside = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
const palace = (x, y, color) => x >= 3 && x <= 5 && (color === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2);
const crossed = (square, color) => color === 'red' ? square < 45 : square >= 45;
const moveOf = (from, to) => ({ id: `${from}-${to}`, from, to });
const VALUES = { K: 100000, R: 900, C: 450, H: 400, E: 200, A: 200, P: 100 };
const CHASE_VALUES = { K: 0, R: 800, C: 400, H: 400, E: 200, A: 200, P: 200 };

export const RULE_COVERAGE = Object.freeze({
  version: 'WXF 2018',
  source: 'https://www.wxf-xiangqi.org/images/wxf-rules/2018_World_Xiangqi_Rules_Chinese_2018.pdf',
  implemented: ['全部棋子走法及自陷被将限制', '将死与困毙', '长将、长捉及真假根分析', '自然限着及提和方超过十着的将军扣除', '仅剩将士象的死局'],
  limitations: ['自动循环裁决采用同一局面出现三次后的裁决；赛事裁判警告流程由家庭玩法替代', '全套官方棋例的逐图人工校对尚未完成', '复杂理论和棋残局需要协商和棋或自然限着'],
});

export function createInitialBoard() {
  const board = Array(90).fill(null);
  const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  for (const color of ['black', 'red']) {
    const y = color === 'black' ? 0 : 9;
    for (let x = 0; x < 9; x++) board[index(x, y)] = { id: `${color}-${back[x]}-${x}`, color, type: back[x] };
    for (const x of [1, 7]) board[index(x, color === 'black' ? 2 : 7)] = { id: `${color}-C-${x}`, color, type: 'C' };
    for (const x of [0, 2, 4, 6, 8]) board[index(x, color === 'black' ? 3 : 6)] = { id: `${color}-P-${x}`, color, type: 'P' };
  }
  return board;
}

function lineScreens(board, from, to) {
  const [x, y] = xy(from), [tx, ty] = xy(to);
  if (x !== tx && y !== ty) return -1;
  const step = x === tx ? (ty > y ? 9 : -9) : (tx > x ? 1 : -1);
  let count = 0;
  for (let at = from + step; at !== to; at += step) if (board[at]) count++;
  return count;
}

function canReach(board, from, to, capture = Boolean(board[to]), occupancy = board) {
  const piece = board[from];
  if (!piece || from === to || to < 0 || to >= 90) return false;
  const [x, y] = xy(from), [tx, ty] = xy(to);
  const dx = tx - x, dy = ty - y;
  switch (piece.type) {
    case 'K':
      if (board[to]?.type === 'K' && x === tx && lineScreens(occupancy, from, to) === 0) return true;
      return Math.abs(dx) + Math.abs(dy) === 1 && palace(tx, ty, piece.color);
    case 'A': return Math.abs(dx) === 1 && Math.abs(dy) === 1 && palace(tx, ty, piece.color);
    case 'E': return Math.abs(dx) === 2 && Math.abs(dy) === 2 &&
      (piece.color === 'red' ? ty >= 5 : ty <= 4) && !board[index(x + dx / 2, y + dy / 2)];
    case 'H': {
      if (Math.abs(dx) * Math.abs(dy) !== 2) return false;
      return !board[index(x + (Math.abs(dx) === 2 ? Math.sign(dx) : 0), y + (Math.abs(dy) === 2 ? Math.sign(dy) : 0))];
    }
    case 'R': return lineScreens(occupancy, from, to) === 0;
    case 'C': return lineScreens(occupancy, from, to) === (capture ? 1 : 0);
    case 'P': return (dx === 0 && dy === (piece.color === 'red' ? -1 : 1)) ||
      (crossed(from, piece.color) && dy === 0 && Math.abs(dx) === 1);
    default: return false;
  }
}

export function isInCheck(board, color) {
  const king = board.findIndex(piece => piece?.color === color && piece.type === 'K');
  if (king === -1) return true;
  for (let from = 0; from < 90; from++) {
    if (board[from]?.color === other(color) && canReach(board, from, king, true)) return true;
  }
  return false;
}

export function applyMove(board, move) {
  if (!Number.isInteger(move?.from) || !Number.isInteger(move?.to) || move.from < 0 || move.from >= 90 ||
    move.to < 0 || move.to >= 90 || !board[move.from] || move.from === move.to ||
    board[move.to]?.color === board[move.from].color) throw new RangeError('走法坐标或棋子无效');
  const next = board.slice();
  next[move.to] = next[move.from];
  next[move.from] = null;
  return next;
}

function destinations(board, from) {
  const piece = board[from], [x, y] = xy(from), moves = [];
  const add = (tx, ty) => {
    if (!inside(tx, ty)) return;
    const to = index(tx, ty);
    if (board[to]?.color !== piece.color && board[to]?.type !== 'K' && canReach(board, from, to)) moves.push(moveOf(from, to));
  };
  if (piece.type === 'R' || piece.type === 'C') {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let screen = false;
      for (let tx = x + dx, ty = y + dy; inside(tx, ty); tx += dx, ty += dy) {
        const target = board[index(tx, ty)];
        if (piece.type === 'R') {
          add(tx, ty);
          if (target) break;
        } else if (!screen) {
          if (target) screen = true;
          else add(tx, ty);
        } else if (target) {
          add(tx, ty);
          break;
        }
      }
    }
  } else {
    const offsets = piece.type === 'H' ? [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]]
      : piece.type === 'E' ? [[2, 2], [2, -2], [-2, 2], [-2, -2]]
      : piece.type === 'A' ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of offsets) add(x + dx, y + dy);
  }
  return moves;
}

export function getLegalMoves(board, color) {
  const legal = [];
  if (!board.some(piece => piece?.color === color && piece.type === 'K')) return legal;
  for (let from = 0; from < 90; from++) {
    if (board[from]?.color !== color) continue;
    for (const move of destinations(board, from)) if (!isInCheck(applyMove(board, move), color)) legal.push(move);
  }
  return legal;
}

export function positionKey(board, turn) {
  return `${turn}|${board.map(piece => piece ? `${piece.color[0]}${piece.type}` : '.').join('')}`;
}

export function createHistoryEntry(board, move, color) {
  const boardAfter = applyMove(board, move);
  return { boardBefore: board.slice(), boardAfter, move: { ...move }, color,
    check: isInCheck(boardAfter, other(color)), captured: board[move.to] || null,
    irreversible: Boolean(board[move.to]) || (board[move.from].type === 'P' && Math.floor(move.from / 9) !== Math.floor(move.to / 9)),
  };
}

// Root geometry is evaluated before the hypothetical capture; king safety after it.
// This distinguishes true protection from the blocked rook/cannon cases in WXF 39–41.
export function isProtected(board, move) {
  const attacker = board[move.from], victim = board[move.to];
  if (!attacker || (victim && CHASE_VALUES[victim.type] > CHASE_VALUES[attacker.type])) return false;
  const defendingColor = other(attacker.color);
  const after = applyMove(board, move);
  for (let from = 0; from < 90; from++) {
    const defender = after[from];
    if (defender?.color !== defendingColor) continue;
    if (!victim && ['R', 'C'].includes(defender.type)) continue;
    const occupancy = ['R', 'C'].includes(defender.type) ? board : after;
    if (canReach(after, from, move.to, true, occupancy) && !isInCheck(applyMove(after, moveOf(from, move.to)), defendingColor)) return true;
  }
  return false;
}

function chaseCandidates(board, color) {
  const candidates = [];
  for (const move of getLegalMoves(board, color)) {
    const attacker = board[move.from], victim = board[move.to];
    if (!victim || ['K', 'P'].includes(attacker.type) || (victim.type === 'P' && !crossed(move.to, victim.color))) continue;
    const exchange = attacker.type === victim.type && canReach(board, move.to, move.from, true) &&
      !isInCheck(applyMove(board, moveOf(move.to, move.from)), victim.color);
    if (!exchange && !isProtected(board, move)) candidates.push({ ...move, attackerId: attacker.id, victimId: victim.id });
  }
  return candidates;
}

function moveStatus(entry, response) {
  if (entry.check ?? isInCheck(entry.boardAfter, other(entry.color))) return { type: 2, victims: [] };
  const victims = [];
  if (response) for (const candidate of chaseCandidates(entry.boardAfter, entry.color)) {
    const from = response.boardAfter.findIndex(piece => piece?.id === candidate.attackerId);
    const to = response.boardAfter.findIndex(piece => piece?.id === candidate.victimId);
    if (from === -1 || to === -1) continue;
    const move = moveOf(from, to);
    if (!canReach(response.boardAfter, from, to, true) || isInCheck(applyMove(response.boardAfter, move), entry.color) ||
      isProtected(response.boardAfter, move)) victims.push(candidate.victimId);
  }
  return { type: victims.length ? 1 : 0, victims };
}

function repetitionOutcome(board, turn, history) {
  if (history.length < 4) return null;
  const keys = [positionKey(history[0].boardBefore, history[0].color), ...history.map(entry => positionKey(entry.boardAfter, other(entry.color)))];
  const current = positionKey(board, turn);
  const matches = [];
  for (let i = history.length; i >= 0; i--) {
    if (i < history.length && history[i].irreversible) break;
    if (keys[i] === current) matches.push(i);
    if (matches.length === 3) break;
  }
  if (matches.length < 3) return null;
  const start = matches[2], end = history.length;
  const levels = {};
  for (const color of ['red', 'black']) {
    const states = [];
    for (let i = start; i < end; i++) if (history[i].color === color) {
      // The final response lies across the closed cycle boundary.
      const response = history[i + 1] || history[start];
      states.push(moveStatus(history[i], response));
    }
    if (states.every(state => state.type === 2)) levels[color] = 2;
    else if (states.every(state => state.type === 1)) {
      const common = states.reduce((ids, state) => ids.filter(id => state.victims.includes(id)), states[0].victims);
      levels[color] = common.length ? 1 : 0;
    } else levels[color] = 0;
  }
  if (levels.red === levels.black) return { winner: null, reason: '重复局面，双方同等责任，和棋', rule: 'wxf-repetition-draw' };
  const offender = levels.red > levels.black ? 'red' : 'black';
  const check = levels[offender] === 2;
  return { winner: other(offender), reason: `${offender === 'red' ? '红方' : '黑方'}${check ? '长将' : '长捉'}犯例`, rule: check ? 'wxf-perpetual-check' : 'wxf-perpetual-chase' };
}

export function getOutcome(board, turn, history = []) {
  for (const color of ['red', 'black']) if (!board.some(piece => piece?.color === color && piece.type === 'K')) {
    return { winner: other(color), reason: `${color === 'red' ? '红方' : '黑方'}将帅缺失`, rule: 'missing-general' };
  }
  if (getLegalMoves(board, turn).length === 0) return { winner: other(turn),
    reason: isInCheck(board, turn) ? '将死' : '困毙', rule: isInCheck(board, turn) ? 'checkmate' : 'stalemate-loss' };
  const repetition = repetitionOutcome(board, turn, history);
  if (repetition) return repetition;
  if (naturalMoveCount(history).count >= 100) {
    return { winner: null, reason: '自然限着未吃子，和棋', rule: 'wxf-natural-movecount' };
  }
  const attackPieces = board.filter(piece => piece && !['K', 'A', 'E'].includes(piece.type));
  const bareCannon = attackPieces.length === 1 && attackPieces[0].type === 'C' &&
    board.filter(Boolean).length === 3;
  if (!attackPieces.length || bareCannon) {
    return { winner: null, reason: '双方无可形成取胜的进攻力量，和棋', rule: 'dead-position' };
  }
  return null;
}

export function naturalMoveCount(history, claimant = null) {
  let plies = 0;
  const checks = { red: 0, black: 0 };
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.captured || entry.boardBefore[entry.move.to]) break;
    plies++;
    if (entry.check ?? isInCheck(entry.boardAfter, other(entry.color))) checks[entry.color]++;
  }
  const excluded = claimant ? Math.max(0, checks[claimant] - 10)
    : Math.max(0, checks.red - 10) + Math.max(0, checks.black - 10);
  return { plies, checks, count: plies - excluded };
}

export function getDrawClaimOutcome(board, turn, history, claimant) {
  if (!['red', 'black'].includes(claimant)) throw new RangeError('提和方无效');
  const terminal = getOutcome(board, turn, history);
  if (terminal) return terminal;
  return naturalMoveCount(history, claimant).count >= 100
    ? { winner: null, reason: '自然限着提和成立', rule: 'wxf-natural-movecount-claim' } : null;
}

function evaluate(board, color) {
  let value = 0;
  for (let square = 0; square < 90; square++) {
    const piece = board[square];
    if (!piece) continue;
    const [x, y] = xy(square), advance = piece.color === 'red' ? 9 - y : y;
    let score = VALUES[piece.type];
    if (piece.type === 'P') score += advance * 8 + (crossed(square, piece.color) ? 75 + (4 - Math.abs(x - 4)) * 5 : 0);
    if (piece.type === 'H') score += (4 - Math.abs(x - 4)) * 8 + Math.min(advance, 7) * 4;
    if (piece.type === 'R' || piece.type === 'C') score += (4 - Math.abs(x - 4)) * 3 + Math.min(advance, 7) * 2;
    value += piece.color === color ? score : -score;
  }
  return value;
}

export const DIFFICULTY_PROFILES = Object.freeze([
  { depth: 1, maxNodes: 100, budgetMs: 15, noise: 450, candidates: 12 },
  { depth: 1, maxNodes: 250, budgetMs: 25, noise: 100, candidates: 8 },
  { depth: 2, maxNodes: 1800, budgetMs: 55, noise: 20, candidates: 5 },
  { depth: 3, maxNodes: 6500, budgetMs: 95, noise: 0, candidates: 3 },
  { depth: 4, maxNodes: 18000, budgetMs: 150, noise: 0, candidates: 1 },
]);

export function rankMoves(board, color, difficulty = 3, options = {}) {
  const profile = DIFFICULTY_PROFILES[Math.max(1, Math.min(5, Math.trunc(difficulty) || 3)) - 1];
  const maxNodes = Math.max(0, Math.min(50000, Math.trunc(Number.isFinite(options.maxNodes) ? options.maxNodes : profile.maxNodes)));
  const budgetMs = Math.max(0, Math.min(300, Number.isFinite(options.budgetMs) ? options.budgetMs : profile.budgetMs));
  const now = options.now || (() => performance.now());
  const started = now();
  let nodes = 0, completedDepth = 0;
  const stopped = () => nodes >= maxNodes || now() - started >= budgetMs;
  const ABORT = Symbol('search-abort');
  const ordered = (position, side) => getLegalMoves(position, side).sort((a, b) =>
    (VALUES[position[b.to]?.type] || 0) * 10 - VALUES[position[b.from].type] -
    ((VALUES[position[a.to]?.type] || 0) * 10 - VALUES[position[a.from].type]) || a.from - b.from || a.to - b.to);
  const negamax = (position, side, depth, alpha, beta, ply) => {
    if (stopped()) throw ABORT;
    nodes++;
    const moves = ordered(position, side);
    if (!moves.length) return -1000000 + ply;
    if (depth === 0) return evaluate(position, side);
    let best = -Infinity;
    for (const move of moves) {
      const score = -negamax(applyMove(position, move), other(side), depth - 1, -beta, -alpha, ply + 1);
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return best;
  };
  let ranked = ordered(board, color).map(move => ({ ...move, score: evaluate(applyMove(board, move), color) }));
  for (let depth = 1; depth <= profile.depth && !stopped(); depth++) {
    const iteration = [];
    try {
      for (const move of ranked) iteration.push({ ...move,
        score: -negamax(applyMove(board, move), other(color), depth - 1, -Infinity, Infinity, 1) });
    } catch (error) {
      if (error !== ABORT) throw error;
      break;
    }
    ranked = iteration.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
    completedDepth = depth;
  }
  // Seeded tactical imperfections make the first three levels easier without waiting.
  if (profile.noise) {
    const seed = board.reduce((n, piece, i) => (n + (piece ? (i + 1) * VALUES[piece.type] : 0)) >>> 0, 17);
    for (const move of ranked) {
      const hash = Math.imul((seed ^ (move.from * 97 + move.to * 37)) >>> 0, 2654435761) >>> 0;
      move.score += ((hash / 4294967296) * 2 - 1) * profile.noise;
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
  Object.defineProperty(ranked, 'search', { value: { nodes, completedDepth, elapsedMs: now() - started, maxNodes, budgetMs } });
  return ranked;
}

export function chooseAutoMove(board, color) {
  return rankMoves(board, color, 3, { budgetMs: 8, maxNodes: 120 })[0] || null;
}
