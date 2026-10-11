export const DEFAULT_TIME_CONTROL = Object.freeze({
  mode: 'normal', perMoveSeconds: 60, totalSeconds: 600,
  overtimeSeconds: 20, rapidSeconds: 15,
});

export function normalizeTimeControl(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('计时设置无效');
  const control = { ...DEFAULT_TIME_CONTROL, ...input };
  if (!['normal', 'rapid'].includes(control.mode)) throw new RangeError('计时模式无效');
  for (const key of ['perMoveSeconds', 'totalSeconds', 'overtimeSeconds', 'rapidSeconds']) {
    const value = control[key];
    if (value === null && ['perMoveSeconds', 'totalSeconds'].includes(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 86400) {
      throw new RangeError(`${key} 必须在 1 至 86400 秒之间`);
    }
  }
  return Object.fromEntries(Object.keys(DEFAULT_TIME_CONTROL).map(key => [key, control[key]]));
}

export function getDeadline(control, usedMs, turnStartedAt) {
  if (turnStartedAt === null || turnStartedAt === undefined) return null;
  const c = normalizeTimeControl(control);
  if (!Number.isFinite(turnStartedAt) || !Number.isFinite(usedMs) || usedMs < 0) throw new RangeError('时钟状态无效');
  if (c.mode === 'rapid') return turnStartedAt + c.rapidSeconds * 1000;
  const limits = [];
  if (c.perMoveSeconds !== null) limits.push(turnStartedAt + c.perMoveSeconds * 1000);
  if (c.totalSeconds !== null) {
    const totalRemaining = Math.max(0, c.totalSeconds * 1000 - usedMs);
    limits.push(turnStartedAt + totalRemaining + c.overtimeSeconds * 1000);
  }
  return limits.length ? Math.min(...limits) : null;
}

export function clockSnapshot(control, used, turn, turnStartedAt, now) {
  const c = normalizeTimeControl(control);
  const active = turnStartedAt !== null && turnStartedAt !== undefined;
  const elapsed = active ? Math.max(0, now - turnStartedAt) : 0;
  const deadline = active ? getDeadline(c, used[turn], turnStartedAt) : null;
  const snapshot = { deadline, remainingMs: deadline === null ? null : Math.max(0, deadline - now) };
  for (const color of ['red', 'black']) {
    const usedMs = used[color] + (active && color === turn ? elapsed : 0);
    const totalRemainingMs = c.mode === 'normal' && c.totalSeconds !== null
      ? Math.max(0, c.totalSeconds * 1000 - usedMs) : null;
    const phase = c.mode === 'rapid' ? 'rapid' : c.totalSeconds !== null
      ? (totalRemainingMs > 0 ? 'total' : 'overtime')
      : c.perMoveSeconds !== null ? 'per-move' : 'unlimited';
    snapshot[color] = { usedMs, totalRemainingMs, phase };
  }
  return snapshot;
}
