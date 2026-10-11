export function confirmedMove(previous, next) {
  if (!previous || previous.id !== next.id || next.history.length !== previous.history.length + 1) return null;
  if (!previous.history.every((entry, i) => entry.move.from === next.history[i].move.from && entry.move.to === next.history[i].move.to && entry.color === next.history[i].color && entry.at === next.history[i].at)) return null;
  const entry = next.history.at(-1), piece = previous.board[entry.move.from];
  if (!piece || piece.color !== entry.color || next.board[entry.move.from] || next.board[entry.move.to]?.id !== piece.id) return null;
  if (!previous.board.every((old, i) => i === entry.move.from || i === entry.move.to || (old?.id ?? null) === (next.board[i]?.id ?? null))) return null;
  return { before: previous.board, history: next.history, move: entry.move, piece, captured: entry.captured || previous.board[entry.move.to], ply: next.history.length };
}

export function paintMotion(frame, perspective = 'red') {
  const stage = document.querySelector('.board-scene');
  if (!stage) return [];
  const base = stage.getBoundingClientRect();
  const center = element => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2 - base.left, y: r.top + r.height / 2 - base.top, width: r.width }; };
  const from = center(stage.querySelector(`[data-cell="${frame.move.from}"]`));
  const to = center(stage.querySelector(`[data-cell="${frame.move.to}"]`));
  const actor = stage.querySelector('.moving-actor'), hand = actor.querySelector('img');
  const size = from.width * .88, duration = frame.captured ? 1150 : 800;
  const handRotation = frame.piece?.color === perspective ? 180 : 0;
  const handPosition = y => `translate(-62%, -90%) rotate(${handRotation}deg) translateY(${y}px)`;
  actor.style.width = actor.style.height = `${size}px`;
  const position = (x, y, scale = 1, rotate = 0) => `translate(${x - size / 2}px,${y - size / 2}px) scale(${scale}) rotate(${rotate}deg)`;
  const animations = [actor.animate([
    { transform: position(from.x, from.y), offset: 0 },
    { transform: position(from.x, from.y - 8, 1.12), offset: .13 },
    { transform: position(to.x, to.y - 8, 1.12), offset: .59 },
    { transform: position(to.x, to.y), offset: .69 },
    { transform: position(to.x, to.y), offset: 1 }
  ], { duration, fill: 'both', easing: 'cubic-bezier(.3,.1,.2,1)' }), hand.animate([
    { opacity: 0, transform: handPosition(-18), offset: 0 },
    { opacity: 1, transform: handPosition(0), offset: .09 },
    { opacity: 1, transform: handPosition(0), offset: .67 },
    { opacity: 0, transform: handPosition(-24), offset: .84 },
    { opacity: 0, transform: handPosition(-24), offset: 1 }
  ], { duration, fill: 'both' })];
  if (frame.captured) {
    const victim = stage.querySelector('.flying-piece');
    const direction = to.y < base.height / 2 ? -1 : 1;
    const target = { x: to.x + (to.x < base.width / 2 ? -64 : 64), y: direction < 0 ? -size : base.height + size };
    victim.style.width = victim.style.height = `${size}px`;
    animations.push(victim.animate([
      { transform: position(to.x, to.y), opacity: 1, offset: 0 },
      { transform: position(to.x, to.y), opacity: 1, offset: .59 },
      { transform: position(to.x + 24, to.y - 42, 1.1, 120), opacity: 1, offset: .72 },
      { transform: position((to.x + target.x) / 2, (to.y + target.y) / 2, .9, direction * 300), opacity: .7, offset: .86 },
      { transform: position(target.x, target.y, .55, direction * 540), opacity: 0, offset: 1 }
    ], { duration, fill: 'both', easing: 'linear' }));
  }
  const elapsed = Math.max(0, performance.now() - frame.startedAt);
  for (const animation of animations) animation.currentTime = elapsed;
  return animations;
}
