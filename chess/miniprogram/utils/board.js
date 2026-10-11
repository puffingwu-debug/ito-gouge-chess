const labels = {
  red: { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' }
};
function boardCells(game, perspective, selected) {
  const destinations = new Set((game.legalMoves || []).filter(m => m.from === selected).map(m => m.to));
  return Array.from({ length: 90 }, (_, displayIndex) => {
    const index = perspective === 'black' ? 89 - displayIndex : displayIndex;
    const piece = game.board[index];
    return {
      index, x: displayIndex % 9, y: Math.floor(displayIndex / 9),
      left: (displayIndex % 9) * 12.5, top: Math.floor(displayIndex / 9) * 100 / 9,
      piece, label: piece ? labels[piece.color][piece.type] : '',
      selected: index === selected, destination: destinations.has(index),
      last: !!game.lastMove && (game.lastMove.from === index || game.lastMove.to === index)
    };
  });
}
module.exports = { boardCells, labels };
