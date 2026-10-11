import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp, voiceSignature } from '../server/app.js';
import { applyMove, getLegalMoves } from '../core/xiangqi.js';

async function fixture(t, extra = {}) {
  let time = 1900000000000;
  const directory = mkdtempSync(join(tmpdir(), 'gouge-test-'));
  const app = createApp({ env: { DEV_MODE: 'true', ...extra.env }, dataDir: directory,
    now: () => time, autoTimers: false, ...extra, aiOptions: { search: async () => [], ...(extra.aiOptions || {}) } });
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (path, token, body, method) => {
    const response = await fetch(`${base}${path}`, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const login = async name => api('/api/login/dev', null, { name });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, base, api, login, directory, advance: amount => { time += amount; }, now: () => time };
}
async function pair(f, control = { mode: 'normal', perMoveSeconds: null, totalSeconds: null }, tableId = 1) {
  const red = await f.login('红方'), black = await f.login('黑方');
  const joined = await f.api(`/api/tables/${tableId}/join`, red.token, { color: 'red' });
  await f.api(`/api/tables/${tableId}/join`, black.token, { color: 'black' });
  await f.api(`/api/games/${joined.gameId}/ready`, red.token, { timeControl: control });
  const ready = await f.api(`/api/games/${joined.gameId}/ready`, black.token, {});
  return { red, black, game: ready.game };
}
function operation(game, type, rest = {}) {
  return { type, version: game.version, turnId: game.turnId, operationId: crypto.randomUUID(), ...rest };
}

test('六桌、并发抢座、旁观权限和重复操作', async t => {
  const f = await fixture(t), a = await f.login('A'), b = await f.login('B');
  assert.equal((await f.api('/api/lobby', a.token)).tables.length, 6);
  const results = await Promise.all([a, b].map(person => f.api('/api/tables/2/join', person.token, { color: 'red' })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const { red, black, game } = await pair(f);
  const watcher = await f.login('旁观者');
  await f.api('/api/tables/1/watch', watcher.token, {});
  assert.equal((await f.api(`/api/games/${game.id}/action`, watcher.token, operation(game, 'move', { moveId: game.legalMoves[0].id }))).status, 403);
  const body = operation(game, 'move', { moveId: game.legalMoves[0].id });
  const first = await f.api(`/api/games/${game.id}/action`, red.token, body);
  const duplicate = await f.api(`/api/games/${game.id}/action`, red.token, body);
  assert.equal(first.status, 200); assert.equal(duplicate.game.history.length, 1);
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, { ...body, moveId: 'bad' })).status, 409);
  assert.equal((await f.api('/api/tables/1/leave', black.token, {})).status, 200);
  assert.equal((await f.api('/api/tables/1/join', black.token, {})).gameId, game.id);
});

test('服务端截止先于人工操作，超时只走一次且不依赖前端', async t => {
  const f = await fixture(t), { red, game } = await pair(f, { mode: 'rapid', rapidSeconds: 1 });
  f.advance(1000);
  const late = await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }));
  assert.equal(late.status, 409);
  const current = (await f.api(`/api/games/${game.id}`, red.token)).game;
  assert.equal(current.history.length, 1); assert.equal(current.history[0].source, 'auto');
  assert.equal(current.turn, 'black'); assert.equal(current.clock.red.usedMs, 1000);
  f.app.tick(); assert.equal(f.app.state.games[game.id].history.length, 1);
});

test('双方同意回滚两手，继续计时且不退还已用时间', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  const initialBoard = structuredClone(game.board);
  f.advance(100);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }))).game;
  f.advance(200);
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'move', { moveId: current.legalMoves[0].id }))).game;
  f.advance(300);
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  assert.ok(current.undo); assert.equal(current.undo.targetPly, 0);
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-respond', { requestId: current.undo.id, accept: true }))).status, 403);
  f.advance(400);
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'undo-respond', { requestId: current.undo.id, accept: true }))).game;
  assert.deepEqual(current.board, initialBoard); assert.equal(current.turn, 'red'); assert.equal(current.history.length, 0);
  assert.equal(current.clock.red.usedMs, 800); assert.equal(current.clock.black.usedMs, 200);
});

test('悔棋拒绝、15秒失效和新落子失效', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'undo-respond', { requestId: current.undo.id, accept: false }))).game;
  assert.equal(current.undo, null); assert.equal(current.history.length, 1);
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  const expiredRequest = current.undo.id; f.advance(15000);
  assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'undo-respond', { requestId: expiredRequest, accept: true }))).code, 'UNDO_EXPIRED');
  current = (await f.api(`/api/games/${game.id}`, red.token)).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'move', { moveId: current.legalMoves[0].id }))).game;
  assert.equal(current.undo, null); assert.equal(current.history.length, 2);
});

test('持久化保存隐私、重启恢复到期回合', async t => {
  const f = await fixture(t), { red, game } = await pair(f, { mode: 'rapid', rapidSeconds: 1 });
  const stored = readFileSync(join(f.directory, 'state.json'), 'utf8');
  assert.ok(!stored.includes(red.token)); assert.equal(statSync(join(f.directory, 'state.json')).mode & 0o777, 0o600);
  await f.app.close(); f.advance(2500);
  const resumed = createApp({ env: { DEV_MODE: 'true' }, dataDir: f.directory, now: f.now, autoTimers: false });
  
  const current = resumed.snapshot(resumed.state.games[game.id]);
  assert.equal(current.history.length, 2); assert.equal(current.clock.red.usedMs, 1500); assert.equal(current.clock.black.usedMs, 1000);
  await resumed.close();
});

test('微信登录复用账号，真实签名与语音观众上限', async t => {
  let loginNumber = 0;
  const f = await fixture(t, { env: { DEV_MODE: 'true', WECHAT_APP_ID: 'wx-test', WECHAT_APP_SECRET: 'private', WECHAT_VOICE_ENABLED: 'true' },
    fetch: async url => ({ ok: true, json: async () => ({ openid: new URL(url).searchParams.get('js_code'), session_key: 'session-private' }) }) });
  const loginWx = code => f.api('/api/login/wechat', null, { code });
  const first = await loginWx('wx-player'), again = await loginWx('wx-player');
  assert.equal(first.user.id, again.user.id); assert.ok(!('openid' in first.user)); assert.ok(!('sessionKey' in first.user));
  const { gameId } = await f.api('/api/tables/1/join', first.token, {});
  for (let index = 0; index < 8; index++) {
    const person = await loginWx(`observer-${++loginNumber}`); await f.api('/api/tables/1/watch', person.token, {});
    assert.equal((await f.api('/api/voice/sign', person.token, { gameId })).status, 200);
  }
  const extra = await loginWx('extra'); await f.api('/api/tables/1/watch', extra.token, {});
  assert.equal((await f.api('/api/voice/sign', extra.token, { gameId })).code, 'VOICE_FULL');
  const signature = await f.api('/api/voice/sign', first.token, { gameId });
  assert.equal(signature.status, 200);
  assert.equal(signature.signature, voiceSignature('wx-test', signature.groupId, signature.nonceStr, signature.timeStamp, 'session-private'));
  assert.equal(voiceSignature('wx20afc706a711eefc', '1559129713_672975982', '8AP6DT9ybtniUJfb', 1559129714, 'gDyVgzwa0mFz9uUP7M6GQQ=='),
    'b002b824688dd8593a6079e11d8c5e8734fbcb39a6d5906eb347bfbcad79c617');
  const dev = await f.login('本地'); await f.api('/api/tables/1/watch', dev.token, {});
  assert.equal((await f.api('/api/voice/sign', dev.token, { gameId })).code, 'WECHAT_LOGIN_REQUIRED');
});

test('WebSocket 身份验证、初始大厅和订阅棋局', async t => {
  const f = await fixture(t), { red, game } = await pair(f);
  const ws = new WebSocket(`${f.base.replace('http', 'ws')}/ws?token=${red.token}`);
  t.after(() => ws.terminate());
  const initial = await new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data))));
  assert.equal(initial.type, 'lobby'); assert.equal(initial.tables.length, 6);
  const snapshotPromise = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data))));
  ws.send(JSON.stringify({ type: 'subscribe', gameId: game.id }));
  const result = await snapshotPromise; assert.equal(result.type, 'game'); assert.equal(result.game.id, game.id);
  assert.ok(!JSON.stringify(result).includes('sessionKey'));
});

test('HTTP语音心跳只续本人已加入未到期的合法席位，不能占座或替别人续期', async t => {
  const f = await fixture(t, { env: { DEV_MODE: 'true', WECHAT_APP_ID: 'wx-test', WECHAT_APP_SECRET: 'test-only-secret', WECHAT_VOICE_ENABLED: 'true' },
    fetch: async url => ({ ok: true, json: async () => ({ openid: new URL(url).searchParams.get('js_code'), session_key: 'test-only-session' }) }) });
  const red = await f.api('/api/login/wechat', null, { code: 'voice-red' });
  const black = await f.api('/api/login/wechat', null, { code: 'voice-black' });
  const watcher = await f.api('/api/login/wechat', null, { code: 'voice-watcher' });
  const { gameId } = await f.api('/api/tables/1/join', red.token, {});
  await f.api('/api/tables/1/join', black.token, {}); await f.api('/api/tables/1/watch', watcher.token, {});
  assert.equal((await f.api('/api/voice/heartbeat', null, { gameId })).status, 401);
  assert.equal((await f.api('/api/voice/heartbeat', black.token, { gameId, userId: red.user.id })).code, 'VOICE_NOT_JOINED');
  await f.api('/api/voice/sign', red.token, { gameId }); f.advance(20000);
  const renewal = await f.api('/api/voice/heartbeat', red.token, { gameId });
  assert.equal(renewal.status, 200); assert.equal(renewal.expiresAt, f.now() + 45000);
  assert.equal(renewal.serverNow, f.now()); assert.equal(renewal.leaseSeconds, 45);
  assert.equal(f.app.state.games[gameId].voice[black.user.id], undefined);
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws?token=' + red.token);
  await new Promise(resolve => ws.once('message', resolve));
  const subscribed = new Promise(resolve => ws.once('message', resolve));
  ws.send(JSON.stringify({ type: 'subscribe', gameId })); await subscribed;
  const disconnected = new Promise(resolve => ws.once('close', resolve)); ws.close(); await disconnected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.state.games[gameId].voice[red.user.id], renewal.expiresAt);
  assert.equal((await f.api('/api/voice/heartbeat', red.token, { gameId })).status, 200);
  await f.api('/api/voice/sign', watcher.token, { gameId });
  assert.equal((await f.api('/api/voice/heartbeat', watcher.token, { gameId })).status, 200);
  await f.api('/api/tables/1/leave', watcher.token, { gameId });
  assert.equal((await f.api('/api/voice/heartbeat', watcher.token, { gameId })).status, 403);
  f.advance(45000);
  f.app.tick(); assert.equal(Object.keys(f.app.state.games[gameId].voice).length, 0);
  assert.equal((await f.api('/api/voice/heartbeat', red.token, { gameId })).code, 'VOICE_NOT_JOINED');
  assert.equal(f.app.state.games[gameId].voice[red.user.id], undefined);
  const ai = await f.api('/api/ai', red.token, { difficulty: 1, humanColor: 'red' });
  assert.equal((await f.api('/api/voice/sign', red.token, { gameId: ai.gameId })).code, 'VOICE_PVP_ONLY');
});

test('未启用语音的提示说明服务器配置，不伪称微信权限未开通', async t => {
  const f = await fixture(t, { env: { DEV_MODE: 'true', WECHAT_APP_ID: 'wx-test', WECHAT_APP_SECRET: 'test-only-secret' },
    fetch: async () => ({ ok: true, json: async () => ({ openid: 'voice-config-user', session_key: 'test-only-session' }) }) });
  const person = await f.api('/api/login/wechat', null, { code: 'voice-config-code' });
  const { gameId } = await f.api('/api/tables/1/join', person.token, {});
  const result = await f.api('/api/voice/sign', person.token, { gameId });
  assert.equal(result.code, 'VOICE_UNCONFIGURED'); assert.match(result.error, /服务器尚未启用/);
});

test('开发模式不能暴露公网；正式模式要求显式真实配置', () => {
  assert.throws(() => createApp({ env: { DEV_MODE: 'true', HOST: '0.0.0.0' } }), /本机地址/);
  assert.throws(() => createApp({ env: { DEV_MODE: 'false' } }), /须配置/);
});

test('等待阶段时钟为空，另一棋手确认后计时规则锁定', async t => {
  const f = await fixture(t), red = await f.login('桌主'), black = await f.login('确认方');
  const { gameId } = await f.api('/api/tables/1/join', red.token, {});
  const waiting = (await f.api(`/api/games/${gameId}`, red.token)).game;
  assert.equal(waiting.clock.deadline, null); assert.equal(waiting.clock.red.usedMs, 0);
  await f.api('/api/tables/1/join', black.token, {});
  await f.api(`/api/games/${gameId}/ready`, red.token, { timeControl: { mode: 'rapid', rapidSeconds: 5 } });
  assert.equal((await f.api(`/api/games/${gameId}/ready`, black.token, { timeControl: { mode: 'rapid', rapidSeconds: 20 } })).code, 'OWNER_ONLY');
  const active = (await f.api(`/api/games/${gameId}/ready`, black.token, {})).game;
  assert.equal(active.status, 'active'); assert.equal(active.timeControl.rapidSeconds, 5);
  assert.equal((await f.api(`/api/games/${gameId}/ready`, red.token, { timeControl: { rapidSeconds: 20 } })).code, 'RULES_LOCKED');
});

test('迟到的 DeepSeek 回答不能覆盖超时代走后的棋局', async t => {
  let release, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, { env: { DEV_MODE: 'true', DEEPSEEK_API_KEY: 'fake-for-test' },
    aiOptions: { search: async (board, color) => (await import('../core/xiangqi.js')).getLegalMoves(board, color) },
    fetch: async (_, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      requestStarted();
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ moveId: payload.allowedMoves[0].moveId }) } }] }) }); });
    } });
  const human = await f.login('人类');
  const { gameId } = await f.api('/api/ai', human.token, { difficulty: 2, humanColor: 'black', timeControl: { mode: 'rapid', rapidSeconds: 1 } });
  await started; f.advance(1000);
  const afterTimeout = (await f.api(`/api/games/${gameId}`, human.token)).game;
  assert.equal(afterTimeout.history.length, 1); assert.equal(afterTimeout.history[0].source, 'auto');
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  const afterResponse = (await f.api(`/api/games/${gameId}`, human.token)).game;
  assert.equal(afterResponse.version, afterTimeout.version); assert.equal(afterResponse.history.length, 1);
});

test('可信局域网开发必须显式开启开关', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gouge-lan-'));
  const app = createApp({ env: { DEV_MODE: 'true', HOST: '0.0.0.0', ALLOW_LAN_DEV: 'true' }, dataDir: directory, autoTimers: false });
  assert.equal(app.config.host, '0.0.0.0'); await app.close(); rmSync(directory, { recursive: true, force: true });
});

test('非法 AI 计时在变更状态前拒绝，不留下占座棋局', async t => {
  const f = await fixture(t), person = await f.login('家人');
  for (const timeControl of [{ mode: 'rapid', rapidSeconds: 0 }, 'bad-control']) {
    const bad = await f.api('/api/ai', person.token, { difficulty: 2, humanColor: 'red', timeControl });
    assert.equal(bad.status, 400); assert.equal(Object.keys(f.app.state.games).length, 0);
  }
  const good = await f.api('/api/ai', person.token, { difficulty: 2, humanColor: 'red', timeControl: { mode: 'rapid', rapidSeconds: 10 } });
  assert.equal(good.status, 200); assert.ok(good.gameId);
});

test('修改资料先验证整体，非法头像不能部分改名', async t => {
  const f = await fixture(t), person = await f.login('原昵称');
  const bad = await f.api('/api/me', person.token, { name: '新昵称', avatar: 'invalid-avatar' }, 'PATCH');
  assert.equal(bad.status, 400);
  assert.equal((await f.api('/api/me', person.token)).user.name, '原昵称');
  const good = await f.api('/api/me', person.token, { name: '新昵称' }, 'PATCH');
  assert.equal(good.user.name, '新昵称');
});

test('等待棋手关闭页面保留席位，可以从大厅找回原桌', async t => {
  const f = await fixture(t), person = await f.login('等待棋手');
  const { gameId } = await f.api('/api/tables/4/join', person.token, { color: 'black' });
  const ws = new WebSocket(`${f.base.replace('http', 'ws')}/ws?token=${person.token}`);
  await new Promise(resolve => ws.once('message', resolve));
  const subscribed = new Promise(resolve => ws.once('message', resolve));
  ws.send(JSON.stringify({ type: 'subscribe', gameId })); await subscribed;
  const disconnected = new Promise(resolve => ws.once('close', resolve)); ws.close(); await disconnected;
  const lobby = await f.api('/api/lobby', person.token);
  assert.equal(lobby.tables[3].seats.black.id, person.user.id); assert.equal(lobby.tables[3].gameId, gameId);
  const recovered = await f.api('/api/tables/4/join', person.token, {});
  assert.equal(recovered.status, 200); assert.equal(recovered.gameId, gameId);
  assert.equal((await f.api(`/api/games/${gameId}`, person.token)).game.seats.black.id, person.user.id);
  const switched = await f.api('/api/tables/5/join', person.token, {});
  assert.equal(switched.status, 200);
  assert.equal(f.app.state.games[gameId].seats.black, null);
  assert.equal(f.app.state.games[gameId].status, 'waiting');
});

test('双方同意和棋需对方批准，继续计时并正确结束', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  const watcher = await f.login('观众'); await f.api('/api/tables/1/watch', watcher.token, {});
  assert.equal((await f.api(`/api/games/${game.id}/action`, watcher.token, operation(game, 'draw-request'))).status, 403);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'draw-request'))).game;
  assert.ok(current.draw); assert.equal(current.draw.expiresAt - f.now(), 15000);
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'draw-respond', { requestId: current.draw.id, accept: true }))).status, 403);
  f.advance(450);
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'draw-respond', { requestId: current.draw.id, accept: true }))).game;
  assert.equal(current.status, 'finished'); assert.equal(current.outcome.winner, null);
  assert.equal(current.outcome.rule, 'wxf-agreement'); assert.equal(current.clock.red.usedMs, 450); assert.equal(current.draw, null);
});

test('和棋拒绝、过期、新落子和重赛使旧回应失效', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'draw-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'draw-respond', { requestId: current.draw.id, accept: false }))).game;
  assert.equal(current.draw, null); assert.equal(current.status, 'active');
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'draw-request'))).game;
  const expired = operation(current, 'draw-respond', { requestId: current.draw.id, accept: true });
  f.advance(15000); assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, expired)).code, 'DRAW_EXPIRED');
  current = (await f.api(`/api/games/${game.id}`, red.token)).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'draw-request'))).game;
  const oldResponse = operation(current, 'draw-respond', { requestId: current.draw.id, accept: true });
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'move', { moveId: current.legalMoves[0].id }))).game;
  assert.equal(current.draw, null);
  assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, oldResponse)).code, 'STALE_STATE');
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'resign'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'rematch'))).game;
  await f.api(`/api/games/${game.id}/ready`, red.token, {});
  current = (await f.api(`/api/games/${game.id}/ready`, black.token, {})).game;
  assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, oldResponse)).code, 'STALE_STATE');
  assert.equal((await f.api(`/api/games/${game.id}`, red.token)).game.status, 'active');
});

test('接受悔棋取消和棋申请；AI 按家庭策略明确同意协商和棋', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'draw-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'undo-respond', { requestId: current.undo.id, accept: true }))).game;
  assert.equal(current.draw, null); assert.equal(current.history.length, 0);
  const person = await f.login('AI 棋手');
  const { gameId } = await f.api('/api/ai', person.token, { difficulty: 1, humanColor: 'red' });
  const aiGame = (await f.api(`/api/games/${gameId}`, person.token)).game;
  const ended = (await f.api(`/api/games/${gameId}/action`, person.token, operation(aiGame, 'draw-request'))).game;
  assert.equal(ended.status, 'finished'); assert.equal(ended.outcome.winner, null);
  assert.equal(ended.outcome.reason, '双方同意和棋（AI 按家庭策略同意）');
});

test('自然限着提和验证提和方计数，不满足时明确拒绝', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'draw-claim'))).code, 'DRAW_NOT_AVAILABLE');
  const stored = f.app.state.games[game.id];
  // Historical fixtures isolate claimant counting; core tests verify position legality.
  const types = ['A', 'E', 'H', 'R', 'C', 'P'];
  stored.history = Array.from({ length: 100 }, (_, index) => {
    const color = index % 2 ? 'black' : 'red';
    const boardAfter = structuredClone(game.board);
    for (let digit = 0; digit < 3; digit++) boardAfter[36 + digit] = { id: `history-${digit}`, color, type: types[Math.floor(index / 6 ** digit) % 6] };
    return { boardBefore: game.board, boardAfter, color, move: { id: '64-55', from: 64, to: 55 }, captured: null,
      check: color === 'black' && index < 40, source: 'human', at: f.now() };
  });
  assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, operation(game, 'draw-claim'))).code, 'DRAW_NOT_AVAILABLE');
  const ended = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'draw-claim'))).game;
  assert.equal(ended.status, 'finished'); assert.equal(ended.outcome.rule, 'wxf-natural-movecount-claim');
});

test('公开棋谱仅附被吃棋子，吃子和双方同意悔棋后棋袋可重建', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  const capture = game.legalMoves.find(candidate => game.board[candidate.to]);
  assert.ok(capture);
  const captured = structuredClone(game.board[capture.to]);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: capture.id }))).game;
  assert.deepEqual(current.history[0].captured, captured);
  assert.ok(!('boardBefore' in current.history[0])); assert.ok(!('boardAfter' in current.history[0]));
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, black.token, operation(current, 'undo-respond', { requestId: current.undo.id, accept: true }))).game;
  assert.equal(current.history.length, 0); assert.deepEqual(current.board[capture.to], captured);
});

test('公开吃子信息兼容已持久化 boardBefore 或 captured 历史条目', async t => {
  const f = await fixture(t), { red, game } = await pair(f);
  const capture = game.legalMoves.find(candidate => game.board[candidate.to]);
  await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: capture.id }));
  const entry = f.app.state.games[game.id].history[0], captured = game.board[capture.to];
  delete entry.captured;
  assert.deepEqual((await f.api(`/api/games/${game.id}`, red.token)).game.history[0].captured, captured);
  entry.captured = captured; delete entry.boardBefore;
  assert.deepEqual((await f.api(`/api/games/${game.id}`, red.token)).game.history[0].captured, captured);
});

test('成功新开AI才自动判旧局负，双方收到结局且原棋手保留只读历史', { timeout: 5000 }, async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  f.advance(100);
  let current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'undo-request'))).game;
  current = (await f.api(`/api/games/${game.id}/action`, red.token, operation(current, 'draw-request'))).game;
  f.app.state.games[game.id].voice[red.user.id] = f.now() + 45000;
  const frame = ws => new Promise(resolve => {
    const receive = bytes => { const message = JSON.parse(bytes); if (message.type === 'game' && message.game.id === game.id) { ws.off('message', receive); resolve(message.game); } };
    ws.on('message', receive);
  });
  const sockets = await Promise.all([red, black].map(async person => {
    const ws = new WebSocket(`${f.base.replace('http', 'ws')}/ws?token=${person.token}`);
    t.after(() => ws.terminate()); await new Promise(resolve => ws.once('message', resolve));
    const subscribed = frame(ws); ws.send(JSON.stringify({ type: 'subscribe', gameId: game.id })); await subscribed; return ws;
  }));
  const terminalFrames = sockets.map(frame);
  f.advance(450);
  const created = await f.api('/api/ai', red.token, { difficulty: 2, humanColor: 'red' });
  assert.equal(created.status, 200);
  for (const ended of await Promise.all(terminalFrames)) {
    assert.equal(ended.status, 'finished'); assert.equal(ended.outcome.winner, 'black');
    assert.equal(ended.outcome.winnerId, black.user.id); assert.equal(ended.outcome.loserId, red.user.id);
    assert.equal(ended.outcome.reason, '重新开局自动离开'); assert.equal(ended.seats.red, null);
    assert.equal(ended.resultSeats.red.id, red.user.id); assert.equal(ended.resultSeats.black.id, black.user.id);
  }
  const ended = (await f.api(`/api/games/${game.id}`, red.token)).game;
  assert.equal(ended.history.length, 1); assert.equal(ended.clock.red.usedMs, 100); assert.equal(ended.clock.black.usedMs, 450);
  assert.equal(ended.undo, null); assert.equal(ended.draw, null); assert.equal(ended.aiThinking, false);
  assert.equal(ended.voiceMembers.some(person => person.id === red.user.id), false);
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, operation(ended, 'rematch'))).code, 'NOT_PLAYER');
  assert.equal((await f.api('/api/voice/sign', red.token, { gameId: game.id })).code, 'NOT_MEMBER');
  const historical = frame(sockets[0]); sockets[0].send(JSON.stringify({ type: 'subscribe', gameId: game.id }));
  assert.equal((await historical).status, 'finished');
  await f.api('/api/tables/1/watch', red.token, {});
  assert.ok(f.app.state.games[game.id].spectators.includes(red.user.id));
});

test('非法AI、满桌或非法座位不会损失旧局；同桌重进、返回大厅、单纯观棋不判负', async t => {
  const f = await fixture(t), { red, game } = await pair(f);
  await pair(f, undefined, 2);
  for (const name of ['占位甲', '占位乙']) await f.api('/api/tables/3/join', (await f.login(name)).token, {});
  const before = structuredClone(f.app.state.games[game.id]);
  for (const data of [{ difficulty: 0, humanColor: 'red' }, { difficulty: 2, humanColor: 'bad' },
    { difficulty: 2, humanColor: 'red', timeControl: { rapidSeconds: 0 } }, { difficulty: 2, humanColor: 'red', timeControl: false }]) {
    assert.equal((await f.api('/api/ai', red.token, data)).status, 400);
  }
  assert.equal((await f.api('/api/tables/2/join', red.token, {})).code, 'GAME_STARTED');
  assert.equal((await f.api('/api/tables/3/join', red.token, {})).code, 'SEAT_TAKEN');
  assert.equal((await f.api('/api/tables/4/join', red.token, { color: 'bad' })).code, 'BAD_COLOR');
  assert.equal((await f.api('/api/tables/1/leave', red.token, {})).status, 200);
  assert.equal((await f.api('/api/tables/1/join', red.token, {})).gameId, game.id);
  assert.equal((await f.api('/api/tables/2/watch', red.token, {})).status, 200);
  const after = f.app.state.games[game.id];
  assert.equal(after.status, 'active'); assert.equal(after.outcome, null); assert.equal(after.version, before.version);
  assert.deepEqual(after.seats, before.seats); assert.deepEqual(after.board, before.board);
});

test('切换另一棋桌释放旧waiting席位、重置准备和桌主，不判负', async t => {
  const f = await fixture(t), red = await f.login('桌主'), black = await f.login('家人');
  const { gameId } = await f.api('/api/tables/1/join', red.token, {});
  await f.api('/api/tables/1/join', black.token, {});
  await f.api(`/api/games/${gameId}/ready`, red.token, {});
  const joined = await f.api('/api/tables/2/join', red.token, {});
  assert.equal(joined.status, 200);
  const old = f.app.state.games[gameId];
  assert.equal(old.status, 'waiting'); assert.equal(old.outcome, null); assert.equal(old.seats.red, null);
  assert.equal(old.ownerId, black.user.id); assert.deepEqual(old.ready, { red: false, black: false });
  assert.equal((await f.api(`/api/games/${joined.gameId}`, red.token)).game.seats.red.id, red.user.id);
});

test('换桌后的旧结局不可重赛覆盖，新棋手加入使用新棋局且不篡改历史身份', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  const switched = await f.api('/api/tables/2/join', red.token, {});
  assert.equal(switched.status, 200);
  let ended = (await f.api(`/api/games/${game.id}`, black.token)).game;
  assert.equal(ended.outcome.winnerId, black.user.id);
  assert.equal((await f.api(`/api/games/${game.id}/action`, black.token, operation(ended, 'rematch'))).code, 'REMATCH_UNAVAILABLE');
  const newcomer = await f.login('新家人'), joined = await f.api('/api/tables/1/join', newcomer.token, { color: 'red' });
  assert.equal(joined.status, 200); assert.notEqual(joined.gameId, game.id);
  const next = (await f.api(`/api/games/${joined.gameId}`, newcomer.token)).game;
  assert.equal(next.status, 'waiting'); assert.equal(next.seats.red.id, newcomer.user.id); assert.equal(next.seats.black, null);
  for (const person of [red, black]) {
    ended = (await f.api(`/api/games/${game.id}`, person.token)).game;
    assert.equal(ended.status, 'finished'); assert.equal(ended.outcome.winnerId, black.user.id);
    assert.equal(ended.resultSeats.red.id, red.user.id); assert.equal(ended.resultSeats.black.id, black.user.id);
    assert.deepEqual(ended.seats, { red: null, black: null });
  }
  assert.equal((await f.api(`/api/games/${game.id}`, newcomer.token)).status, 403);
});

test('遗留完成局重赛不能强迫忙碌对方判负，发起人自己重赛才退出其其他未完局', async t => {
  const f = await fixture(t), { red, black, game } = await pair(f);
  let ended = (await f.api(`/api/games/${game.id}/action`, black.token, operation(game, 'resign'))).game;
  const { gameId: aiId } = await f.api('/api/ai', black.token, { difficulty: 1, humanColor: 'red' });
  // Model old persisted versions that retained a completed seat after opening another game.
  f.app.state.games[game.id].seats.black = black.user.id;
  ended = (await f.api(`/api/games/${game.id}`, red.token)).game;
  assert.equal((await f.api(`/api/games/${game.id}/action`, red.token, operation(ended, 'rematch'))).code, 'OPPONENT_BUSY');
  assert.equal((await f.api(`/api/games/${aiId}`, black.token)).game.status, 'active');
  assert.equal((await f.api(`/api/games/${game.id}`, red.token)).game.status, 'finished');
  const replay = await f.api(`/api/games/${game.id}/action`, black.token, operation(ended, 'rematch'));
  assert.equal(replay.status, 200); assert.equal(replay.game.status, 'waiting');
  assert.equal((await f.api(`/api/games/${aiId}`, black.token)).game.outcome.reason, '重新开局自动离开');
  await f.api(`/api/games/${game.id}/ready`, red.token, {});
  assert.equal((await f.api(`/api/games/${game.id}/ready`, black.token, {})).game.status, 'active');
  assert.equal(Object.values(f.app.state.games).filter(value => value.status === 'active' && Object.values(value.seats).includes(black.user.id)).length, 1);
});

test('重新开局取消旧pendingAI，迟到回答不能改写自动退出结局', async t => {
  let release, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, { env: { DEEPSEEK_API_KEY: 'fake-for-test' },
    aiOptions: { search: async (board, color) => (await import('../core/xiangqi.js')).getLegalMoves(board, color) },
    fetch: async (_, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content); requestStarted();
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ moveId: payload.allowedMoves[0].moveId }) } }] }) }); });
    } });
  const person = await f.login('人类');
  const { gameId } = await f.api('/api/ai', person.token, { difficulty: 2, humanColor: 'black' });
  await started; f.advance(100);
  assert.equal((await f.api('/api/ai', person.token, { difficulty: 2, humanColor: 'red' })).status, 200);
  const ended = (await f.api(`/api/games/${gameId}`, person.token)).game;
  assert.equal(ended.status, 'finished'); assert.equal(ended.aiThinking, false); assert.equal(ended.outcome.winner, 'red');
  assert.equal(ended.outcome.winnerId, ended.resultSeats.red.id);
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  const after = (await f.api(`/api/games/${gameId}`, person.token)).game;
  assert.equal(after.version, ended.version); assert.equal(after.history.length, 0);
});

test('绑定gameId的离桌仅操作指定历史局，不能误退同桌新局；错桌号或无权限不改状态', async t => {
  const f = await fixture(t), { red, game } = await pair(f);
  await f.api('/api/tables/2/join', red.token, {});
  const joined = await f.api('/api/tables/1/join', red.token, { color: 'red' });
  assert.equal(joined.status, 200); assert.notEqual(joined.gameId, game.id);
  const current = structuredClone(f.app.state.games[joined.gameId]);
  const oldPage = await f.api('/api/tables/1/leave', red.token, { gameId: game.id });
  assert.equal(oldPage.status, 200); assert.equal(oldPage.gameId, game.id);
  assert.deepEqual(f.app.state.games[joined.gameId], current);
  assert.equal((await f.api(`/api/games/${game.id}`, red.token)).game.status, 'finished');
  assert.equal((await f.api('/api/tables/2/leave', red.token, { gameId: joined.gameId })).code, 'GAME_TABLE_MISMATCH');
  const outsider = await f.login('路过家人');
  assert.equal((await f.api('/api/tables/1/leave', outsider.token, { gameId: joined.gameId })).status, 403);
  assert.deepEqual(f.app.state.games[joined.gameId], current);
  const actual = await f.api('/api/tables/1/leave', red.token, { gameId: joined.gameId });
  assert.equal(actual.status, 200); assert.equal(actual.gameId, joined.gameId);
  assert.equal(f.app.state.games[joined.gameId].seats.red, null);
  assert.equal((await f.api('/api/lobby', red.token)).tables[0].seats.red, null);
});

function socketFrame(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ws.off('message', message); ws.off('error', error); };
    const message = data => {
      const frame = JSON.parse(data);
      if (predicate(frame)) { cleanup(); resolve(frame); }
    };
    const error = cause => { cleanup(); reject(cause); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待真实 WebSocket 棋局消息超时')); }, timeout);
    ws.on('message', message); ws.on('error', error);
  });
}

async function subscribeSocket(f, t, person, gameId) {
  const ws = new WebSocket(`${f.base.replace('http', 'ws')}/ws?token=${person.token}`);
  t.after(() => ws.terminate());
  await socketFrame(ws, frame => frame.type === 'lobby');
  const subscribed = socketFrame(ws, frame => frame.type === 'game' && frame.game.id === gameId);
  ws.send(JSON.stringify({ type: 'subscribe', gameId }));
  return { ws, game: (await subscribed).game };
}

test('五档AI通过真实HTTP和WebSocket完成本地搜索并返回合法回应', { timeout: 15000 }, async t => {
  const f = await fixture(t, { now: Date.now, autoTimers: true, aiOptions: { search: undefined } });
  const levels = [];
  for (let difficulty = 1; difficulty <= 5; difficulty++) {
    const person = await f.login('AI真实回应' + difficulty);
    const created = await f.api('/api/ai', person.token, { difficulty, humanColor: 'red', timeControl: { mode: 'normal', perMoveSeconds: null, totalSeconds: null } });
    assert.equal(created.status, 200);
    const { ws, game } = await subscribeSocket(f, t, person, created.gameId);
    const humanMove = game.legalMoves.find(move => move.from === 54 && move.to === 45);
    assert.ok(humanMove);
    const afterHuman = applyMove(game.board, humanMove);
    const legalReplies = getLegalMoves(afterHuman, 'black');
    const replied = socketFrame(ws, frame => frame.type === 'game' && frame.game.id === game.id && frame.game.history.length === 2);
    const started = performance.now();
    const moved = await f.api(`/api/games/${game.id}/action`, person.token, operation(game, 'move', { moveId: humanMove.id }));
    assert.equal(moved.status, 200);
    const current = (await replied).game;
    const reply = current.history[1];
    const legal = legalReplies.find(move => move.id === reply.move.id);
    assert.ok(legal, 'AI 必须从当前棋盘的合法黑方走法中回应');
    assert.equal(reply.source, 'ai'); assert.equal(reply.color, 'black');
    assert.equal(current.aiSource, 'fallback');
    assert.match(current.aiDetail, /未配置 DeepSeek/);
    assert.equal(current.turn, 'red'); assert.equal(current.status, 'active');
    assert.deepEqual(current.board, applyMove(afterHuman, legal));
    const read = (await f.api(`/api/games/${game.id}`, person.token)).game;
    assert.deepEqual(read.board, current.board); assert.equal(read.history.length, 2);
    levels.push({ difficulty, moveId: legal.id, source: current.aiSource, elapsedMs: Math.round(performance.now() - started) });
    ws.close();
  }
  t.diagnostic('BACKEND_FUNCTIONAL ' + JSON.stringify({ kind: 'five-ai-levels', port: new URL(f.base).port, levels }));
});

test('每手、总时长转读秒和快棋在棋手断线时后台代走，旁观者同步且重连恢复', { timeout: 15000 }, async t => {
  const cases = [
    { name: 'per-move', control: { mode: 'normal', perMoveSeconds: 1, totalSeconds: null }, expectedUsedMs: 1000 },
    { name: 'total-and-overtime', control: { mode: 'normal', perMoveSeconds: null, totalSeconds: 1, overtimeSeconds: 1 }, expectedUsedMs: 2000 },
    { name: 'rapid', control: { mode: 'rapid', rapidSeconds: 1 }, expectedUsedMs: 1000 }
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = await fixture(t, { now: Date.now, autoTimers: true });
    const { red, black, game } = await pair(f, item.control);
    const spectator = await f.login('真实计时旁观者');
    assert.equal((await f.api('/api/tables/1/watch', spectator.token, {})).status, 200);
    const player = await subscribeSocket(f, t, red, game.id);
    const watcher = await subscribeSocket(f, t, spectator, game.id);
    const autoFrame = socketFrame(watcher.ws, frame => frame.type === 'game' && frame.game.id === game.id && frame.game.history.length === 1);
    const disconnected = new Promise(resolve => player.ws.once('close', resolve));
    player.ws.close(); await disconnected;
    const current = (await autoFrame).game;
    const auto = current.history[0];
    const legal = getLegalMoves(game.board, 'red').find(move => move.id === auto.move.id);
    assert.ok(legal, '到期代走必须对原棋盘合法');
    assert.equal(auto.source, 'auto'); assert.equal(auto.at, game.clock.deadline);
    assert.equal(current.clock.red.usedMs, item.expectedUsedMs);
    assert.equal(current.turn, 'black'); assert.deepEqual(current.board, applyMove(game.board, legal));
    assert.equal((await f.api(`/api/games/${game.id}/action`, spectator.token, operation(current, 'resign'))).status, 403);
    const reconnected = await subscribeSocket(f, t, red, game.id);
    assert.equal(reconnected.game.history.length, 1);
    assert.deepEqual(reconnected.game.board, current.board);
    assert.equal(reconnected.game.seats.red.id, red.user.id);
    const pending = socketFrame(watcher.ws, frame => frame.type === 'game' && frame.game.id === game.id && frame.game.history.length === 2);
    const blackMove = reconnected.game.legalMoves[0];
    const moved = await f.api(`/api/games/${game.id}/action`, black.token, operation(reconnected.game, 'move', { moveId: blackMove.id }));
    assert.equal(moved.status, 200);
    const continued = (await pending).game;
    assert.equal(continued.history[1].source, 'human'); assert.equal(continued.turn, 'red');
    t.diagnostic('BACKEND_FUNCTIONAL ' + JSON.stringify({ kind: 'disconnected-clock', mode: item.name, port: new URL(f.base).port, autoAt: auto.at, usedMs: current.clock.red.usedMs, reconnectedHistoryLength: reconnected.game.history.length, continuedHistoryLength: continued.history.length }));
  });
});
