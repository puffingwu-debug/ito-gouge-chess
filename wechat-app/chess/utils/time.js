const defaultControl = { mode: 'normal', perMoveSeconds: 60, totalSeconds: 600, overtimeSeconds: 20, rapidSeconds: 15 };
const phaseNames = { total: '总时长', overtime: '超时后每步', 'per-move': '每步限时', unlimited: '不限时', rapid: '快棋每步' };
function duration(ms) {
  if (ms === null || ms === undefined) return '不限时';
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
function controlText(t) {
  if (t.mode === 'rapid') return '快棋 · 每步 ' + t.rapidSeconds + ' 秒';
  return (t.totalSeconds ? '每人总 ' + t.totalSeconds / 60 + ' 分钟' : '总时长不限') +
    (t.perMoveSeconds ? ' · 每步 ' + t.perMoveSeconds + ' 秒' : '') + ' · 总时长用尽后每步 ' + t.overtimeSeconds + ' 秒';
}
function displayClock(game, offset) {
  const clock = game.clock || {};
  const now = Date.now() + offset;
  const elapsed = game.status === 'active' ? Math.max(0, now - game.serverNow) : 0;
  const result = {};
  ['red', 'black'].forEach(color => {
    const c = clock[color] || { usedMs: 0, totalRemainingMs: null, phase: 'unlimited' };
    const active = color === game.turn && game.status === 'active';
    const phase = active && c.phase === 'total' && c.totalRemainingMs !== null && c.totalRemainingMs <= elapsed ? 'overtime' : c.phase;
    result[color] = {
      used: duration(c.usedMs + (active ? elapsed : 0)),
      total: duration(c.totalRemainingMs === null ? null : Math.max(0, c.totalRemainingMs - (active ? elapsed : 0))),
      phase: phaseNames[phase] || phase,
      remaining: active ? duration(clock.deadline === null ? null : Math.max(0, clock.deadline - now)) : '—',
      active
    };
  });
  return result;
}
module.exports = { defaultControl, controlText, displayClock, duration };
