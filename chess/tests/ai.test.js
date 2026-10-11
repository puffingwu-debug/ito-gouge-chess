import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialBoard, getLegalMoves } from '../core/xiangqi.js';
import { chooseAiMove, DIFFICULTIES } from '../server/ai.js';

const board = () => createInitialBoard();
const search = async (position, color) => getLegalMoves(position, color).map((move, index) => ({ ...move, score: 100 - index }));
const success = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('DeepSeek 只接收合法候选，返回结果经过再校验', async () => {
  let requestBody;
  const result = await chooseAiMove({ board: board(), color: 'red', difficulty: 3, search,
    config: { apiKey: 'secret-test' }, fetchImpl: async (_, request) => {
      requestBody = JSON.parse(request.body);
      const payload = JSON.parse(requestBody.messages[1].content);
      return success(JSON.stringify({ moveId: payload.allowedMoves[1].moveId }));
    } });
  assert.equal(result.source, 'deepseek');
  assert.ok(getLegalMoves(board(), 'red').some(move => move.id === result.move.id));
  assert.equal(requestBody.response_format.type, 'json_object');
  assert.equal(JSON.parse(requestBody.messages[1].content).allowedMoves.length, 6);
  assert.ok(!JSON.stringify(requestBody).includes('secret-test'));
});

test('非法、空输出、限流、网络失败都使用合法本地走法', async () => {
  const fetches = [
    async () => success('{"moveId":"999-1"}'), async () => success(''),
    async () => ({ ok: false, status: 429 }), async () => { throw new Error('network'); },
  ];
  for (const fetchImpl of fetches) {
    const result = await chooseAiMove({ board: board(), color: 'red', difficulty: 4, search, config: { apiKey: 'test' }, fetchImpl });
    assert.equal(result.source, 'fallback'); assert.ok(getLegalMoves(board(), 'red').some(move => move.id === result.move.id));
  }
});

test('五档有不同搜索预算和候选范围，低档随机选着', async () => {
  const budgets = [], counts = [], choices = [];
  for (let difficulty = 1; difficulty <= 5; difficulty++) {
    const result = await chooseAiMove({ board: board(), color: 'red', difficulty, random: () => 0.9,
      search: async (position, color, level, options) => { assert.equal(level, difficulty); budgets.push(options.maxNodes); return search(position, color); },
      config: { apiKey: 'test' }, fetchImpl: async (_, request) => {
        counts.push(JSON.parse(JSON.parse(request.body).messages[1].content).allowedMoves.length); return success('');
      } });
    choices.push(result.move.id);
  }
  assert.deepEqual(budgets, DIFFICULTIES.map(item => item.maxNodes));
  assert.ok(counts[0] > counts[1]); assert.deepEqual(counts.slice(1), [12, 6, 3, 1]);
  assert.notEqual(choices[0], choices[4]);
});

test('API 请求超时或回合取消不能一直等待', async () => {
  let observedAbort = false;
  const result = await chooseAiMove({ board: board(), color: 'red', difficulty: 1, search, config: { apiKey: 'test', timeoutMs: 210 },
    fetchImpl: (_, request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); })) });
  assert.equal(observedAbort, true); assert.equal(result.source, 'fallback');
  const abort = new AbortController(); abort.abort(); let called = false;
  await chooseAiMove({ board: board(), color: 'red', difficulty: 1, search, signal: abort.signal, config: { apiKey: 'test' },
    fetchImpl: async () => { called = true; return success(''); } });
  assert.equal(called, false);
});

test('真实 worker 搜索能够给出合法走法', async () => {
  const result = await chooseAiMove({ board: board(), color: 'red', difficulty: 2 });
  assert.equal(result.source, 'fallback'); assert.ok(getLegalMoves(board(), 'red').some(move => move.id === result.move.id));
});

test('真实搜索 worker 可取消，避免旧回合继续消耗资源', async () => {
  const { searchInWorker } = await import('../server/ai.js');
  const abort = new AbortController();
  const searching = searchInWorker(board(), 'red', 5, { budgetMs: 300, maxNodes: 25000, signal: abort.signal });
  abort.abort(); await assert.rejects(searching, /取消/);
});
