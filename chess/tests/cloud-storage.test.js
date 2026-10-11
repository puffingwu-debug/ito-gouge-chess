import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createCloudStorage } from '../server/cloud-storage.js';
import { createApp } from '../server/app.js';

// Only the CloudBase boundary is replaced. Transactions use optimistic commit
// conflicts, atomic rollback, and the SDK's distinct transaction/query data shapes.
export function fakeCloud() {
  let documents = new Map(), revision = 0;
  const files = new Map(), commits = [], signedFiles = [];
  const state = { failCommit: false, beforeCommit: null, getError: null };
  function collection(draft, transactional = false, operation = () => {}) {
    return {
      doc: id => ({
        get: async () => {
          operation();
          if (state.getError) throw state.getError;
          if (!draft.has(id)) throw Object.assign(new Error('document not found'), { code: 'DOCUMENT_NOT_FOUND' });
          return { data: transactional ? structuredClone(draft.get(id)) : [structuredClone(draft.get(id))] };
        },
        set: async value => { operation(); assert.equal('_id' in value, false); draft.set(id, { ...structuredClone(value), _id: id }); return { updated: 1 }; },
        update: async value => { operation(); if (!draft.has(id)) return { updated: 0 }; draft.set(id, { ...draft.get(id), ...structuredClone(value) }); return { updated: 1 }; },
        remove: async () => { operation(); return { deleted: Number(draft.delete(id)) }; },
      }),
      orderBy: () => ({ skip: offset => ({ limit: limit => ({ get: async () => ({ data: [...draft.values()].sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + limit).map(value => structuredClone(value)) }) }) }) }),
    };
  }
  const db = {
    collection: () => collection(documents),
    runTransaction: async callback => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const expected = revision, draft = structuredClone(documents);
        let operations = 0;
        const result = await callback({ collection: () => collection(draft, true, () => {
          if (++operations > 100) throw new Error('CloudBase transaction operation limit exceeded');
        }) });
        if (state.beforeCommit) await state.beforeCommit();
        if (state.failCommit) throw new Error('isolated database write failed');
        if (revision !== expected) continue;
        documents = draft; revision++; commits.push(structuredClone(documents)); return result;
      }
      throw Object.assign(new Error('transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
    },
  };
  return {
    database: () => db, files, commits, signedFiles, controls: state, documents: () => structuredClone(documents),
    uploadFile: async ({ cloudPath, fileContent }) => {
      assert.ok(Buffer.isBuffer(fileContent)); const fileID = `cloud://test-environment/${cloudPath}`;
      files.set(fileID, Buffer.from(fileContent)); return { fileID };
    },
    getTempFileURL: async ({ fileList }) => {
      for (const file of fileList) { assert.equal(file.maxAge, 300); assert.ok(files.has(file.fileID)); signedFiles.push(file.fileID); }
      return { fileList: fileList.map(file => ({ fileID: file.fileID, code: 'SUCCESS', tempFileURL: `https://avatar.example.invalid/${encodeURIComponent(file.fileID)}?signed=test-only` })) };
    },
  };
}
const env = { CLOUDBASE_ENV_ID: 'test-environment' };
const open = (app, extra = {}) => createCloudStorage({ env, app, autoRenew: false, ...extra });

test('真实SDK空authority抛DOCUMENT_NOT_FOUND时初始化，其他读取错误原样拒绝', async t => {
  const app = fakeCloud(), storage = await open(app); t.after(() => storage.close());
  assert.equal(storage.healthy(), true); assert.equal(app.documents().get('authority').schema, 1);
  const forbidden = fakeCloud();
  forbidden.controls.getError = Object.assign(new Error('database permission denied'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(open(forbidden), { code: 'PERMISSION_DENIED' });
  assert.equal(forbidden.documents().size, 0);
});

test('云数据库按记录持久化，重启恢复用户、私密会话、棋局和头像上传记录', async t => {
  const app = fakeCloud(), storage = await open(app);
  t.after(() => storage.close());
  const state = structuredClone(storage.initialState);
  for (let index = 0; index < 105; index++) {
    state.users[`user-${index}`] = { id: `user-${index}`, name: `家人${index}` };
    if ((index + 1) % 50 === 0) await storage.save(structuredClone(state));
  }
  state.sessions['hashed-token'] = { userId: 'user-1', expiresAt: 9999999999999 };
  state.games['game-1'] = { id: 'game-1', history: [{ notation: '兵五进一' }], version: 1 };
  state.tables[0] = 'game-1';
  const fileID = await storage.putAvatar('test-avatar.png', Buffer.from([137, 80, 78, 71]));
  state.avatars[fileID] = { ownerId: 'user-1' };
  await storage.save(state); await storage.close();
  const resumed = await open(app); t.after(() => resumed.close());
  assert.deepEqual(resumed.initialState, state);
  assert.deepEqual(app.files.get(fileID), Buffer.from([137, 80, 78, 71]));
  const before = app.documents();
  const next = structuredClone(state); next.games['game-1'].version = 2;
  await resumed.save(next);
  const changed = [...app.documents()].filter(([id, value]) => JSON.stringify(before.get(id)) !== JSON.stringify(value));
  assert.deepEqual(changed.map(([, value]) => value.kind).sort(), ['authority', 'games']);
});

test('并发部署只允许一个实例获取租约，旧实例关闭后才能恢复启动', async t => {
  const app = fakeCloud();
  const attempts = await Promise.allSettled([open(app), open(app)]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'CLOUD_INSTANCE_ACTIVE');
  const first = attempts.find(value => value.status === 'fulfilled').value;
  await first.close();
  const second = await open(app); t.after(() => second.close()); assert.equal(second.healthy(), true);
});

test('租约过期接管后，旧实例保存或续租不能覆盖新状态', async t => {
  let time = 10000;
  const app = fakeCloud(), old = await open(app, { now: () => 10000, leaseMs: 1000 });
  t.after(() => old.close());
  const original = structuredClone(old.initialState); original.users.owner = { name: '旧实例' };
  await old.save(original); time += 1001;
  // Even a stale local clock cannot bypass the database owner/fence check.
  assert.equal(old.healthy(), true);
  const current = await open(app, { now: () => time, leaseMs: 1000 }); t.after(() => current.close());
  const next = structuredClone(current.initialState); next.users.owner.name = '新实例'; await current.save(next);
  const stale = structuredClone(original); stale.users.owner.name = '旧实例迟到写';
  await assert.rejects(old.save(stale), { code: 'CLOUD_LEASE_LOST' });
  await assert.rejects(old.renew(), { code: 'CLOUD_LEASE_LOST' });
  await old.close(); await current.close();
  const resumed = await open(app, { now: () => time, leaseMs: 1000 }); t.after(() => resumed.close());
  assert.equal(resumed.initialState.users.owner.name, '新实例');
});

test('云配置失败不回退本地或开发登录，数据库版本冲突拒绝旧状态覆盖', async t => {
  assert.throws(() => createApp({ env: { CLOUD_STORAGE: 'true', DEV_MODE: 'false' } }), /不能退回/);
  assert.throws(() => createApp({ env: { CLOUD_STORAGE: 'true', DEV_MODE: 'true' } }), /DEV_MODE=false/);
  await assert.rejects(createCloudStorage({ env: {}, app: fakeCloud() }), { code: 'CLOUD_CONFIG_REQUIRED' });
  const app = fakeCloud(), storage = await open(app); t.after(() => storage.close());
  await app.database().runTransaction(tx => tx.collection('gouge_chess_state').doc('authority').update({ version: 8 }));
  const next = structuredClone(storage.initialState); next.users.versioned = { name: '拒绝覆盖' };
  await assert.rejects(storage.save(next), { code: 'CLOUD_VERSION_CONFLICT' });
  assert.equal(storage.healthy(), false);
  assert.equal([...app.documents().values()].some(value => value.key === 'versioned'), false);
});

test('事务失败不留下部分记录，健康变为失败且不能继续写入', async t => {
  const app = fakeCloud(), storage = await open(app); t.after(() => storage.close());
  const next = structuredClone(storage.initialState); next.users.new = { name: '尚未保存' };
  const original = app.documents(); app.controls.failCommit = true;
  await assert.rejects(storage.save(next)); assert.equal(storage.healthy(), false);
  assert.deepEqual(app.documents(), original);
  app.controls.failCommit = false; await assert.rejects(storage.save(next));
});

test('超出100操作的状态变更整体拒绝，不将一次业务拆成部分提交', async t => {
  const app = fakeCloud(), storage = await open(app); t.after(() => storage.close());
  const original = app.documents(), next = structuredClone(storage.initialState);
  for (let index = 0; index < 99; index++) next.users[`batch-${index}`] = { name: `用户${index}` };
  await assert.rejects(storage.save(next), { code: 'CLOUD_TRANSACTION_TOO_LARGE' });
  assert.deepEqual(app.documents(), original); assert.equal(storage.healthy(), false);
});

test('关闭等待在途写入提交后才释放租约；过期前续租允许正常继续保存', async t => {
  let time = 2000, release;
  const app = fakeCloud(), storage = await open(app, { now: () => time, leaseMs: 1000 });
  t.after(() => storage.close());
  time += 800; await storage.renew(); time += 500; assert.equal(storage.healthy(), true);
  const entered = new Promise(resolve => {
    app.controls.beforeCommit = () => { resolve(); return new Promise(done => { release = done; }); };
  });
  const next = structuredClone(storage.initialState); next.users.pending = { name: '已提交' };
  const saving = storage.save(next); await entered;
  app.controls.beforeCommit = null;
  let closed = false; const closing = storage.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, false);
  release(); await saving; await closing;
  const resumed = await open(app, { now: () => time, leaseMs: 1000 }); t.after(() => resumed.close());
  assert.equal(resumed.initialState.users.pending.name, '已提交');
});

async function cloudFixture(t, extra = {}) {
  let time = 1900000000000;
  const cloud = fakeCloud(), directory = mkdtempSync(join(tmpdir(), 'gouge-cloud-http-'));
  const apps = [];
  const start = async () => {
    const storage = await open(cloud, { now: () => time, ...extra });
    const app = createApp({ storage, dataDir: join(directory, 'never-use-local-data'), now: () => time, autoTimers: false,
      env: { DEV_MODE: 'false', CLOUD_STORAGE: 'true', CLOUD_CONTAINER_PRIVATE: 'true', HOST: '127.0.0.1', WECHAT_APP_ID: 'wx-cloud-test', WECHAT_APP_SECRET: 'test-only' },
      fetch: async url => ({ ok: true, json: async () => ({ openid: new URL(url).searchParams.get('js_code'), session_key: 'test-only-session' }) }) });
    apps.push(app); await app.flush();
    const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
    const api = async (path, token, body, method) => {
      const response = await fetch(`${base}${path}`, { method: method || (body === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, ...(await response.json()) };
    };
    return { app, base, api };
  };
  t.after(async () => { for (const app of apps) await app.close().catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
  return { cloud, directory, start, advance: amount => { time += amount; }, now: () => time, ...(await start()) };
}
async function cloudPair(f, timeControl = { mode: 'normal', perMoveSeconds: null, totalSeconds: null }) {
  const red = await f.api('/api/login/wechat', null, { code: 'red' }), black = await f.api('/api/login/wechat', null, { code: 'black' });
  const { gameId } = await f.api('/api/tables/1/join', red.token, { color: 'red' });
  await f.api('/api/tables/1/join', black.token, { color: 'black' });
  await f.api(`/api/games/${gameId}/ready`, red.token, { timeControl });
  const { game } = await f.api(`/api/games/${gameId}/ready`, black.token, {});
  return { red, black, game };
}
function operation(game, type, rest = {}) { return { type, version: game.version, turnId: game.turnId, operationId: crypto.randomUUID(), ...rest }; }
function frame(ws) { return new Promise((resolve, reject) => { ws.once('message', bytes => resolve(JSON.parse(bytes))); ws.once('error', reject); }); }

test('云模式不落容器文件，HTTP成功和WS落子通知必须等云事务提交', { timeout: 10000 }, async t => {
  const f = await cloudFixture(t), { red, game } = await cloudPair(f);
  const health = await f.api('/api/health');
  assert.equal(health.devMode, false); assert.deepEqual(health.storage, { kind: 'cloudbase', healthy: true });
  assert.equal((await f.api('/api/login/dev', null, { name: '不能开发登录' })).code, 'DEV_DISABLED');
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws?token=${red.token}`);
  t.after(() => ws.terminate()); await frame(ws);
  let subscribed = frame(ws); ws.send(JSON.stringify({ type: 'subscribe', gameId: game.id })); await subscribed;
  let release, received = false, responded = false;
  const entered = new Promise(resolve => { f.cloud.controls.beforeCommit = () => { resolve(); return new Promise(done => { release = done; }); }; });
  const body = operation(game, 'move', { moveId: game.legalMoves[0].id });
  const response = f.api(`/api/games/${game.id}/action`, red.token, body).then(value => { responded = true; return value; });
  const update = frame(ws).then(value => { received = true; return value; });
  await entered; await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(responded, false); assert.equal(received, false);
  f.cloud.controls.beforeCommit = null; release();
  assert.equal((await response).game.history.length, 1); assert.equal((await update).game.history.length, 1);
  assert.equal(existsSync(join(f.directory, 'never-use-local-data')), false);
  ws.terminate(); await f.app.close();
  const resumed = await f.start();
  assert.equal((await resumed.api('/api/me', red.token)).user.id, red.user.id);
  assert.equal((await resumed.api(`/api/games/${game.id}`, red.token)).game.history.length, 1);
  const duplicate = await resumed.api(`/api/games/${game.id}/action`, red.token, body);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.game.history.length, 1);
});

test('云保存失败返回503且不发布未提交落子，重启只恢复已提交棋局', { timeout: 10000 }, async t => {
  const f = await cloudFixture(t), { red, game } = await cloudPair(f);
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/ws?token=${red.token}`);
  t.after(() => ws.terminate()); await frame(ws);
  const subscribed = frame(ws); ws.send(JSON.stringify({ type: 'subscribe', gameId: game.id })); await subscribed;
  const frames = []; ws.on('message', bytes => frames.push(JSON.parse(bytes)));
  f.cloud.controls.failCommit = true;
  const failed = await f.api(`/api/games/${game.id}/action`, red.token, operation(game, 'move', { moveId: game.legalMoves[0].id }));
  assert.equal(failed.status, 503); assert.equal(failed.code, 'STORAGE_UNAVAILABLE');
  const health = await f.api('/api/health'); assert.equal(health.status, 503); assert.equal(health.ok, false); assert.equal(health.storage.healthy, false);
  assert.equal((await f.api(`/api/games/${game.id}`, red.token)).status, 503);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(frames.some(value => value.game?.history.length), false);
  f.cloud.controls.failCommit = false; assert.equal((await f.api('/api/health')).ok, false);
  ws.terminate(); await assert.rejects(f.app.close());
  const resumed = await f.start(); assert.equal((await resumed.api(`/api/games/${game.id}`, red.token)).game.history.length, 0);
});

test('云重启处理已保存截止时间，继续使用原会话而不依赖本地数据', async t => {
  const f = await cloudFixture(t), { red, game } = await cloudPair(f, { mode: 'rapid', rapidSeconds: 1 });
  await f.app.close(); f.advance(1500);
  const resumed = await f.start(), result = await resumed.api(`/api/games/${game.id}`, red.token);
  assert.equal(result.status, 200); assert.equal(result.game.history.length, 1); assert.equal(result.game.history[0].source, 'auto');
  assert.equal(result.game.turn, 'black'); assert.equal(result.game.clock.red.usedMs, 1000);
});

test('云头像只为已认证账号签发现有头像或同会话限时pending文件，不开放任意存储', async t => {
  const f = await cloudFixture(t, { leaseMs: 3600000 });
  const owner = await f.api('/api/login/wechat', null, { code: 'avatar-owner' });
  const other = await f.api('/api/login/wechat', null, { code: 'avatar-other' });
  const dataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;
  const uploads = [];
  for (let index = 0; index < 4; index++) uploads.push((await f.api('/api/avatar', owner.token, { dataUrl })).avatar);
  const fileID = uploads[3]; assert.ok(fileID.startsWith('cloud://'));
  assert.equal((await f.api('/api/avatar-url', null, { fileID })).status, 401);
  assert.equal((await f.api('/api/avatar-url', other.token, { fileID })).code, 'AVATAR_FORBIDDEN');
  assert.equal((await f.api('/api/avatar-url', owner.token, { fileID: uploads[0] })).code, 'AVATAR_FORBIDDEN');
  assert.equal((await f.api('/api/avatar-url', owner.token, { fileID: 'cloud://test-environment/private-state.json' })).code, 'AVATAR_FORBIDDEN');
  assert.deepEqual(f.cloud.signedFiles, []);
  const preview = await f.api('/api/avatar-url', owner.token, { fileID });
  assert.equal(preview.status, 200); assert.ok(preview.url.startsWith('https://')); assert.equal(preview.expiresAt, f.now() + 300000);
  const otherSession = await f.api('/api/login/wechat', null, { code: 'avatar-owner' });
  assert.equal((await f.api('/api/avatar-url', otherSession.token, { fileID })).code, 'AVATAR_FORBIDDEN');
  assert.equal((await f.api('/api/me', other.token, { avatar: fileID }, 'PATCH')).code, 'BAD_AVATAR');
  assert.equal((await f.api('/api/me', owner.token, { avatar: fileID }, 'PATCH')).user.avatar, fileID);
  assert.equal((await f.api('/api/avatar-url', other.token, { fileID })).status, 200);
  f.advance(600001);
  assert.equal((await f.api('/api/avatar-url', owner.token, { fileID: uploads[2] })).code, 'AVATAR_FORBIDDEN');
  assert.equal((await f.api('/api/avatar-url', other.token, { fileID })).status, 200);
  await f.app.close(); const resumed = await f.start();
  assert.equal((await resumed.api('/api/me', owner.token)).user.avatar, fileID);
  assert.equal((await resumed.api('/api/avatar-url', other.token, { fileID })).status, 200);
  assert.equal(existsSync(join(f.directory, 'never-use-local-data')), false);
});
