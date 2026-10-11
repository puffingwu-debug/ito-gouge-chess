import { Worker } from 'node:worker_threads';
import { getLegalMoves } from '../core/xiangqi.js';

export const DIFFICULTIES = [
  { name: '新手', budgetMs: 30, maxNodes: 250, candidates: Infinity },
  { name: '初级', budgetMs: 70, maxNodes: 1200, candidates: 12 },
  { name: '中级', budgetMs: 140, maxNodes: 4000, candidates: 6 },
  { name: '高级', budgetMs: 260, maxNodes: 10000, candidates: 3 },
  { name: '挑战', budgetMs: 450, maxNodes: 25000, candidates: 1 },
];

export function searchInWorker(board, color, difficulty, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...searchOptions } = options;
    if (signal?.aborted) { reject(new Error('搜索已取消')); return; }
    const worker = new Worker(new URL('./search-worker.js', import.meta.url), {
      workerData: { board, color, difficulty, options: searchOptions },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(new Error('搜索已取消'));
    const timer = setTimeout(() => finish(new Error('搜索超时')), searchOptions.budgetMs + 2000);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', value => finish(null, value));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`搜索进程退出（${code}）`)); });
  });
}

export async function chooseAiMove({ board, color, difficulty, history = [], config = {}, fetchImpl = fetch,
  remainingMs = Infinity, signal, search = searchInWorker, random = Math.random }) {
  const legal = getLegalMoves(board, color);
  if (!legal.length) return { move: null, source: 'fallback', detail: '没有合法走法' };
  const settings = DIFFICULTIES[difficulty - 1];
  if (!settings) throw new Error('难度必须为 1 至 5');
  let ranked;
  try {
    ranked = await search(board, color, difficulty, {
      budgetMs: Math.max(5, Math.min(settings.budgetMs, remainingMs / 3)), maxNodes: settings.maxNodes, signal,
    });
  } catch { ranked = legal.map(move => ({ ...move, score: 0 })); }
  // The candidate set, search budget, and local choice all change with difficulty.
  const byId = new Map(legal.map(move => [move.id, move]));
  ranked = ranked.filter(move => byId.has(move.id));
  if (!ranked.length) ranked = legal;
  const candidates = ranked.slice(0, settings.candidates);
  const fallback = difficulty === 1 ? candidates[Math.floor(random() * candidates.length)] : candidates[0];
  const local = detail => ({ move: byId.get(fallback.id), source: 'fallback', detail });
  if (!config.apiKey) return local('未配置 DeepSeek，使用本地棋力引擎');
  if (signal?.aborted) return local('回合已变化');
  const timeoutMs = Math.floor(Math.min(config.timeoutMs || 6000, remainingMs - settings.budgetMs - 100));
  if (timeoutMs < 200) return local('剩余时间不足，使用本地引擎');
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl || 'https://api.deepseek.com'}/chat/completions`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model || 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是中国象棋选着模块。只能从 allowedMoves 选择 moveId。只输出 JSON 对象 {"moveId":"合法候选标识"}，不得输出解释或思考过程。' },
          { role: 'user', content: JSON.stringify({ color, difficulty, difficultyName: settings.name,
            coordinateSystem: '索引 y*9+x，x=0..8、y=0..9；黑方在上。K将帅,A士,E象,H马,R车,C炮,P兵卒。',
            board, recentMoves: history.slice(-12).map(item => ({ move: item.move, color: item.color })),
            allowedMoves: candidates.map(({ id, from, to }) => ({ moveId: id, from, to })) }) },
        ], max_tokens: 128, temperature: difficulty === 1 ? 1 : 0.1 }),
    });
    if (!response.ok) return local(`DeepSeek 请求失败（HTTP ${response.status}），使用本地引擎`);
    const body = await response.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content || 'null');
    if (!parsed || !candidates.some(move => move.id === parsed.moveId)) return local('DeepSeek 返回无效走法，使用本地引擎');
    return { move: byId.get(parsed.moveId), source: 'deepseek', detail: 'DeepSeek 已返回合法候选走法' };
  } catch { return local('DeepSeek 超时或连接失败，使用本地引擎'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
