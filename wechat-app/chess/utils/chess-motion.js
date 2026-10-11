const { labels } = require('./board');

function capturedPiece(entry) {
  if (Object.prototype.hasOwnProperty.call(entry, 'captured')) return entry.captured;
  if (Array.isArray(entry.boardBefore) && Array.isArray(entry.boardAfter)) return entry.boardBefore[entry.move.to] || null;
  return undefined;
}
function samePiece(a, b) { return (!a && !b) || (!!a && !!b && a.id === b.id && a.color === b.color && a.type === b.type); }
function sameBoard(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((piece, index) => samePiece(piece, b[index])); }
function moveKey(entry) {
  const move = entry && entry.move;
  return move ? [move.from, move.to, entry.color, entry.at || ''].join(':') : '';
}
function confirmedMove(previous, next) {
  if (!previous || previous.id !== next.id || !Array.isArray(previous.history) || !Array.isArray(next.history) || next.history.length !== previous.history.length + 1) return null;
  if (!Array.isArray(previous.board) || !Array.isArray(next.board) || previous.board.length !== 90 || next.board.length !== 90) return null;
  if (!previous.history.every((entry, index) => moveKey(entry) === moveKey(next.history[index]))) return null;
  const entry = next.history[next.history.length - 1], move = entry.move;
  if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.from > 89 || move.to < 0 || move.to > 89 || move.from === move.to) return null;
  const mover = previous.board[move.from], captured = capturedPiece(entry);
  if (!mover || mover.color !== entry.color || captured === undefined || !samePiece(previous.board[move.to], captured) || !samePiece(next.board[move.to], mover) || next.board[move.from]) return null;
  if (!previous.board.every((piece, index) => index === move.from || index === move.to || samePiece(piece, next.board[index]))) return null;
  return {
    from: move.from, to: move.to, color: entry.color,
    mover: { color: mover.color, label: labels[mover.color][mover.type] },
    captured: captured ? { color: captured.color, label: labels[captured.color][captured.type] } : null,
    boardBefore: previous.board, boardAfter: next.board
  };
}
function displayPoint(index, perspective, rect, stage) {
  const position = perspective === 'black' ? 89 - index : index;
  return {
    x: rect.left - stage.left + (position % 9) * rect.width / 8,
    y: rect.top - stage.top + Math.floor(position / 9) * rect.height / 9
  };
}
function geometryFromRects(rects) {
  if (!Array.isArray(rects) || rects.length < 2 || rects.slice(0, 2).some(rect => !rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !(rect.width > 0) || !(rect.height > 0))) return null;
  return { stage: rects[0], board: rects[1] };
}
function queryGeometry(page, callback) {
  const query = typeof page.createSelectorQuery === 'function' ? page.createSelectorQuery() : (typeof wx.createSelectorQuery === 'function' ? wx.createSelectorQuery() : null);
  if (!query) { callback(null); return; }
  ['.chess-stage', '.board-grid'].forEach(selector => query.select(selector).boundingClientRect());
  query.exec(rects => callback(geometryFromRects(rects)));
}
module.exports = { confirmedMove, sameBoard, displayPoint, queryGeometry, geometryFromRects };
