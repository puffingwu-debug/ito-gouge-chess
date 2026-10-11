import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createInitialBoard, applyMove, getLegalMoves } from '../core/xiangqi.js';

const source = readFileSync(new URL('../scripts/wechat-cloud-ai-smoke.fn.js', import.meta.url), 'utf8');
const target = { env: 'gouge-chess-d1gubfb4x25bc5571', service: 'gouge-chess' };
function fixture(options = {}) {
  const clock = { now: Date.now() }, requests = [], games = new Map(), sockets = [], calls = [];
  const user = { id: 'private-real-user-id', name: 'private-user-name' }, app = { globalData: { ito: ['unchanged'] } };
  let nextId = 0, firstResign = true;
  class TestDate extends Date { static now() { return clock.now; } }
  const response = (data, statusCode = 200) => ({ statusCode, data: structuredClone(data) });
  function finish(game, rule) {
    game.status = 'finished'; game.version++;
    game.resultSeats = structuredClone(game.seats);
    game.outcome = { winner: 'black', rule, reason: rule === '认输' ? '对方认输' : '重新开局自动离开',
      loserId: user.id, winnerId: game.seats.black.id };
  }
  function snapshot(game) {
    return { ...game, legalMoves: game.status === 'active' ? getLegalMoves(game.board, game.turn) : [], clock: { deadline: null } };
  }
  const wx = {
    getDeviceInfo: () => ({ platform: 'devtools' }),
    login(callbacks) { calls.push('wx.login'); callbacks.success({ code: 'private-wx-login-code' }); },
    setStorageSync() { throw new Error('QA cannot change client storage'); },
    cloud: {
      init(value) { calls.push({ init: value }); },
      async callContainer(request) {
        requests.push(structuredClone(request));
        const { path, data } = request;
        if (path === '/api/health') {
          if (options.expireDuringHealth) clock.now += 30000;
          return response({ ok: true, devMode: options.devMode || false, wechatConfigured: true, storage: { kind: 'cloudbase', healthy: true } });
        }
        if (path === '/api/login/wechat') return response({ token: 'private-session-token', user });
        if (path === '/api/me') return response({ user });
        if (path === '/api/ai') {
          for (const game of games.values()) if (game.status === 'active' && game.seats.red?.id === user.id) {
            finish(game, '自动退出'); game.seats.red = null;
          }
          const id = 'test-game-' + (++nextId);
          games.set(id, { id, mode: 'ai', difficulty: data.difficulty, ownerId: user.id, status: 'active',
            board: createInitialBoard(), history: [], outcome: null, resultSeats: null, turn: 'red', version: 1, turnId: 'turn-' + id,
            seats: { red: user, black: { id: 'ai-' + id, kind: 'ai', name: 'AI' } } });
          if (options.lostCreationReply) throw { errCode: 85088, errMsg: 'private-session-token private-wx-login-code' };
          if (options.foreignAppears) games.set('foreign-game', { id: 'foreign-game', status: 'active', seats: { red: { id: 'another-private-user' } } });
          return response({ gameId: id });
        }
        const match = /^\/api\/games\/([^/]+)(\/action)?$/.exec(path);
        assert.ok(match, 'Only the documented health, login, me, AI and tracked game endpoints are allowed');
        const game = games.get(match[1]); assert.ok(game);
        if (match[2]) {
          if (data.type === 'move' && options.failMove) return response({ code: 'MOVE_SERVICE_FAILED', error: 'private-user-name' }, 503);
          if (data.type === 'resign' && options.failCleanup) return response({ code: 'RESIGN_FAILED' }, 503);
          if (data.type === 'resign' && options.staleResign && firstResign) {
            firstResign = false; game.version++; return response({ code: 'STALE_STATE' }, 409);
          }
          assert.equal(data.version, game.version); assert.equal(data.turnId, game.turnId);
          if (data.type === 'move') {
            const move = getLegalMoves(game.board, 'red').find(candidate => candidate.id === data.moveId);
            assert.ok(move); game.board = applyMove(game.board, move);
            game.history.push({ source: 'human', color: 'red', move }); game.turn = 'black'; game.version++;
          } else { assert.equal(data.type, 'resign'); finish(game, '认输'); }
        } else if (game.status === 'active' && game.turn === 'black') {
          if (options.noAiReply) clock.now += 4000;
          else {
            const move = getLegalMoves(game.board, 'black')[0];
            game.board = applyMove(game.board, move); game.history.push({ source: 'ai', color: 'black', move });
            game.turn = 'red'; game.version++; game.aiSource = options.deepseek ? 'deepseek' : 'fallback';
          }
        }
        return response({ game: snapshot(game) });
      },
      async connectContainer(request) {
        let onMessage, onClose;
        const socket = { closed: false, request,
          onOpen(fn) { queueMicrotask(fn); }, onMessage(fn) { onMessage = fn; }, onClose(fn) { onClose = fn; }, onError() {},
          send(payload) {
            const value = JSON.parse(payload.data); assert.equal(value.type, 'subscribe');
            onMessage({ data: JSON.stringify({ type: 'game', game: snapshot(games.get(value.gameId)) }) });
          },
          close() { this.closed = true; if (onClose) onClose(); }
        };
        sockets.push(socket); return { socketTask: socket };
      }
    }
  };
  const proof = { ...target, checkedAt: clock.now, gameCount: 0, source: 'admin-readonly' };
  const context = vm.createContext({ wx, getApp: () => app, Date: TestDate,
    setTimeout: (fn, delay) => setTimeout(fn, delay === 150 ? 0 : delay), clearTimeout });
  vm.runInContext(source, context);
  const run = payload => { context.arg = payload; return vm.runInContext('cloudAiSmoke(arg)', context); };
  return { run, proof, requests, games, sockets, calls, clock, wx, context, app };
}
const payload = f => ({ ...target, emptyGameStoreProof: f.proof });
async function backgroundReport(f) {
  const deadline = Date.now() + 1000;
  while (f.context.__gougeCloudAiQa?.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.context.__gougeCloudAiQa.running, false);
  return f.context.__gougeCloudAiQa.report;
}

test('native AI QA exercises five difficulties, own moves, resignations, subscribed disconnect and restart forfeit without exposing identity', async () => {
  const f = fixture(), report = await f.run(payload(f));
  assert.equal(report.ok, true); assert.equal(report.difficultyCount, 5); assert.equal(report.createdCount, 6);
  assert.equal(report.externalEmptyGameStoreProof, true); assert.equal(report.nativeExistingGameCheck, false);
  assert.equal(report.disconnectChecked, true); assert.equal(report.socketDisconnectCheckOmitted, false);
  assert.equal(Object.values(report.checks).every(Boolean), true); assert.equal(report.cleanupComplete, true);
  assert.equal(report.hostAppUnchanged, true); assert.equal(report.physicalDevice, false);
  assert.equal(report.localReplyCount, 5); assert.equal(report.deepseekReplyCount, 0);
  assert.deepEqual(f.requests.filter(request => request.path === '/api/ai').map(request => request.data.difficulty), [1, 2, 3, 4, 5, 5]);
  for (const request of f.requests.filter(request => request.path === '/api/ai')) {
    assert.equal(request.data.timeControl.perMoveSeconds, null); assert.equal(request.data.timeControl.totalSeconds, null);
  }
  assert.equal(f.requests.find(request => request.path === '/api/login/wechat').data.code, 'private-wx-login-code');
  assert.equal(f.requests.find(request => request.path === '/api/me').header.Authorization, 'Bearer private-session-token');
  assert.equal(f.calls.filter(value => value === 'wx.login').length, 1);
  assert.equal(f.sockets[0].closed, true); assert.equal(f.sockets[0].request.path, '/ws?token=private-session-token');
  assert.equal([...f.games.values()].every(game => game.status === 'finished'), true);
  const actions = f.requests.filter(request => request.path.endsWith('/action'));
  assert.equal(actions.filter(request => request.data.type === 'move').length, 5);
  assert.equal(actions.filter(request => request.data.type === 'resign').length, 5);
  assert.equal(new Set(actions.map(request => request.data.operationId)).size, actions.length);
  assert.doesNotMatch(JSON.stringify(report), /private|test-game|Bearer|token|header|code|user-id/);
});

test('native AI QA stops before any SDK request for missing, nonempty, wrong-target, old, future or untrusted external proofs', async () => {
  for (const mutate of [() => undefined, proof => ({ ...proof, gameCount: 1 }), proof => ({ ...proof, env: 'wrong-env' }),
    proof => ({ ...proof, service: 'wrong-service' }), proof => ({ ...proof, checkedAt: proof.checkedAt - 30000 }),
    proof => ({ ...proof, checkedAt: proof.checkedAt + 1 }), proof => ({ ...proof, source: 'api-lobby' })]) {
    const f = fixture(), report = await f.run({ ...target, emptyGameStoreProof: mutate(f.proof) });
    assert.equal(report.ok, false); assert.match(report.errorCode, /^EMPTY_STORE_PROOF_/);
    assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.equal(report.createdCount, 0);
  }
});

test('native AI QA rechecks proof age after login before its first mutation', async () => {
  const f = fixture({ expireDuringHealth: true }), report = await f.run(payload(f));
  assert.equal(report.errorCode, 'EMPTY_STORE_PROOF_EXPIRED'); assert.equal(report.failedStage, 'empty-store-preflight');
  assert.equal(f.requests.some(request => request.path === '/api/ai'), false); assert.equal(report.createdCount, 0);
});

test('native AI QA reports a lost creation reply as uncertain and never guesses a game ID or retries creation', async () => {
  const f = fixture({ lostCreationReply: true }), report = await f.run(payload(f));
  assert.equal(report.ok, false); assert.equal(report.errCode, 85088); assert.equal(report.errorCode, 'SDK_FAILURE');
  assert.equal(report.untrackedCreationPossible, true); assert.equal(report.cleanupComplete, false);
  assert.equal(f.requests.filter(request => request.path === '/api/ai').length, 1);
  assert.equal(f.requests.some(request => request.path.startsWith('/api/games/')), false);
  assert.doesNotMatch(JSON.stringify(report), /private|errMsg|Authorization/);
});

test('native AI QA failure cleanup resigns only its acknowledged test game and preserves unrelated games', async () => {
  const f = fixture({ failMove: true, foreignAppears: true }), report = await f.run(payload(f));
  assert.equal(report.ok, false); assert.equal(report.errorCode, 'MOVE_SERVICE_FAILED'); assert.equal(report.cleanupComplete, true);
  assert.equal(f.games.get('test-game-1').status, 'finished'); assert.equal(f.games.get('foreign-game').status, 'active');
  assert.equal(f.requests.some(request => request.path.includes('foreign-game')), false);
  assert.equal(f.requests.filter(request => request.path === '/api/ai').length, 1);
});

test('native AI QA cleanup failure is explicit and AI timeout still cleans its own created game', async () => {
  const blocked = fixture({ failMove: true, failCleanup: true }), blockedReport = await blocked.run(payload(blocked));
  assert.equal(blockedReport.cleanupComplete, false); assert.equal(blockedReport.ok, false);
  const timeout = fixture({ noAiReply: true }), timeoutReport = await timeout.run(payload(timeout));
  assert.equal(timeoutReport.errorCode, 'AI_REPLY_NOT_APPLIED'); assert.equal(timeoutReport.cleanupComplete, true);
  assert.equal(timeout.games.get('test-game-1').status, 'finished');
});

test('native AI QA uses a fresh snapshot for a stale resignation and distinguishes actual DeepSeek reply sources', async () => {
  const f = fixture({ staleResign: true, deepseek: true }), report = await f.run(payload(f));
  assert.equal(report.ok, true); assert.equal(report.deepseekReplyCount, 5); assert.equal(report.localReplyCount, 0);
  const requests = f.requests.filter(request => request.path.endsWith('/action') && request.data.type === 'resign');
  assert.notEqual(requests[0].data.operationId, requests[1].data.operationId);
  assert.equal(requests[1].data.version, requests[0].data.version + 1);
});

test('HTTP-only AI QA explicitly omits WebSocket verification while retaining all five AI and restart checks', async () => {
  const f = fixture();
  f.wx.cloud.connectContainer = () => { throw new Error('Omitted WebSocket must never be called'); };
  const report = await f.run({ ...payload(f), omitSocketDisconnectCheck: true });
  assert.equal(report.ok, true); assert.equal(report.difficultyCount, 5); assert.equal(report.createdCount, 6);
  assert.equal(report.disconnectChecked, false); assert.equal(report.socketDisconnectCheckOmitted, true);
  assert.equal(report.checks.disconnectKeepsActive, false); assert.equal(report.checks.activeBeforeRestart, true);
  assert.equal(report.checks.restartForfeitsPrevious, true); assert.equal(report.checks.resignations, true);
  assert.equal(report.checks.humanMoves, true); assert.equal(report.checks.aiReplies, true); assert.equal(report.cleanupComplete, true);
  assert.equal(f.sockets.length, 0); assert.equal([...f.games.values()].every(game => game.status === 'finished'), true);
  const unsupported = fixture(); delete unsupported.wx.cloud.connectContainer;
  assert.equal((await unsupported.run({ ...payload(unsupported), omitSocketDisconnectCheck: true })).ok, true);
  const required = fixture(); delete required.wx.cloud.connectContainer;
  const defaultReport = await required.run(payload(required));
  assert.equal(defaultReport.errorCode, 'SDK_UNAVAILABLE'); assert.equal(defaultReport.ok, false);
  assert.equal(defaultReport.disconnectChecked, false); assert.equal(defaultReport.socketDisconnectCheckOmitted, false);
  assert.equal(required.requests.length, 0);
});

test('native AI QA accepts a fresh zero-unfinished proof while preserving all existing finished records', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.games.set('existing-finished-' + i, { id: 'existing-finished-' + i, status: 'finished',
    seats: { red: { id: 'private-real-user-id' } }, history: [{ preserved: true }], outcome: { preserved: true } });
  const before = [...f.games.values()].map(game => JSON.stringify(game));
  const report = await f.run({ ...payload(f), omitSocketDisconnectCheck: true,
    emptyGameStoreProof: { ...f.proof, gameCount: 6, unfinishedGameCount: 0 } });
  assert.equal(report.ok, true); assert.equal(report.externalNoUnfinishedGamesProof, true);
  assert.equal(report.externalEmptyGameStoreProof, false); assert.equal(report.nativeExistingGameCheck, false);
  assert.equal(report.createdCount, 6); assert.equal(report.cleanupComplete, true);
  assert.deepEqual([...f.games.values()].slice(0, 6).map(game => JSON.stringify(game)), before);
  assert.equal(f.requests.some(request => request.path.includes('existing-finished-')), false);
  for (const unfinishedGameCount of [1, '0', null, -1]) {
    const invalid = fixture(), result = await invalid.run({ ...payload(invalid),
      emptyGameStoreProof: { ...invalid.proof, unfinishedGameCount } });
    assert.equal(result.errorCode, 'EMPTY_STORE_PROOF_INVALID'); assert.equal(invalid.requests.length, 0);
  }
});

test('native AI QA starts in the background immediately, prevents duplicate work and stores only its safe report outside the host', async () => {
  const f = fixture(), original = f.wx.cloud.callContainer;
  let releaseHealth;
  f.wx.cloud.callContainer = request => request.path === '/api/health'
    ? new Promise(resolve => { releaseHealth = () => resolve(original(request)); }) : original(request);
  const input = { ...payload(f), omitSocketDisconnectCheck: true, runInBackground: true,
    emptyGameStoreProof: { ...f.proof, gameCount: 6, unfinishedGameCount: 0 } };
  const started = f.run(input);
  assert.equal(typeof started.then, 'undefined', 'The native background entry must return synchronously');
  assert.deepEqual(JSON.parse(JSON.stringify(started)), { started: true });
  assert.equal(f.context.__gougeCloudAiQa.running, true); assert.equal(f.context.__gougeCloudAiQa.report, null);
  assert.equal(f.requests.length, 0); assert.equal(typeof releaseHealth, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(f.run(input))), { started: false, busy: true });
  releaseHealth();
  const report = await backgroundReport(f);
  assert.equal(report.ok, true); assert.equal(report.difficultyCount, 5); assert.equal(report.createdCount, 6);
  assert.equal(report.disconnectChecked, false); assert.equal(report.cleanupComplete, true);
  assert.deepEqual(f.app.globalData, { ito: ['unchanged'] });
  assert.doesNotMatch(JSON.stringify(f.context.__gougeCloudAiQa), /private|test-game|Bearer|token|Authorization|user-id/);
  assert.equal(f.requests.filter(request => request.path === '/api/ai').length, 6);
});

test('background native AI QA preserves proof rejection and sanitizes an unexpected runtime failure', async () => {
  const invalid = fixture(), started = await invalid.run({ ...target, runInBackground: true });
  assert.equal(started.started, true);
  assert.equal((await backgroundReport(invalid)).errorCode, 'EMPTY_STORE_PROOF_REQUIRED');
  assert.equal(invalid.requests.length, 0);
  const broken = fixture();
  broken.context.getApp = () => { throw new Error('private-session-token private-real-user-id'); };
  assert.equal((await broken.run({ ...payload(broken), runInBackground: true })).started, true);
  const report = await backgroundReport(broken);
  assert.equal(report.ok, false); assert.equal(report.errorCode, 'SDK_FAILURE'); assert.equal(report.cleanupComplete, false);
  assert.doesNotMatch(JSON.stringify(broken.context.__gougeCloudAiQa), /private|token|user-id/);
});
