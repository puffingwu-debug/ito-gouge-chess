import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createApp } from '../server/app.js';

const require = createRequire(import.meta.url);
const { createChatHandler, createLocalStore, authorizeMember, APP_ID, REACTIONS } = require('../cloudfunctions/gouge-chess-chat/handler.cjs');
const cloudRoot = new URL('../cloudfunctions/gouge-chess-chat/', import.meta.url);
const clone = value => structuredClone(value);

function fixture(options = {}) {
  let time = 100000, checks = 0;
  const users = {
    a: { id: 'a', name: '红方', kind: 'human', openid: 'openid-a' },
    b: { id: 'b', name: '黑方', kind: 'human', openid: 'openid-b' },
    s: { id: 's', name: '观众', kind: 'human', openid: 'openid-s' },
    x: { id: 'x', name: '另一桌', kind: 'human', openid: 'openid-x' },
  };
  const games = {
    game1: { id: 'game1', mode: 'pvp', tableId: 1, seats: { red: 'a', black: 'b' }, spectators: ['s'], status: 'active' },
    game2: { id: 'game2', mode: 'pvp', tableId: 2, seats: { red: 'x', black: null }, spectators: [], status: 'waiting' },
    ai1: { id: 'ai1', mode: 'ai', tableId: null, seats: { red: 'a', black: 'ai' }, spectators: [] },
  };
  const authority = { tables: ['game1', 'game2', null, null, null, null] };
  const store = createLocalStore({
    authorize: target => authorizeMember({ identity: target.identity, user: users[target.userIdHint] || Object.values(users).find(u => u.openid === target.identity.openid), game: games[target.gameId], authority }),
    persist: options.persist,
  });
  const handle = createChatHandler({ store, identity: context => context, now: () => time,
    checkText: options.checkText || (async () => { checks++; return true; }) });
  const call = (who, input) => handle({ gameId: 'game1', ...input }, { appId: APP_ID, openid: users[who].openid });
  return { handle, call, store, games, users, authority, advance: ms => { time += ms; }, checks: () => checks };
}
const send = (reqId, text = '大家好') => ({ operation: 'send', reqId, text });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('棋手和登记旁观者同桌聊天，身份、AI、别桌和历史参与者隔离', async () => {
  const f = fixture();
  const first = await f.call('a', { ...send('r1'), name: '伪造昵称', openid: 'openid-x', userId: 'x' });
  assert.equal(first.message.name, '红方'); assert.equal(first.message.userId, 'a');
  assert.equal((await f.call('b', { operation: 'list' })).messages[0].text, '大家好');
  assert.equal((await f.call('s', send('r2', '观棋中'))).seq, 2);
  await rejectsCode(f.call('x', { operation: 'list' }), 'NOT_MEMBER');
  await rejectsCode(f.call('a', { ...send('r3'), gameId: 'game2' }), 'NOT_MEMBER');
  await rejectsCode(f.call('a', { operation: 'list', gameId: 'ai1' }), 'CHAT_AI_UNSUPPORTED');
  await rejectsCode(f.handle({ operation: 'list', gameId: 'game1' }, { appId: 'other-app', openid: 'openid-a' }), 'CHAT_IDENTITY_REQUIRED');
  await rejectsCode(f.handle({ operation: 'list', gameId: 'game1', openid: 'openid-a' }, { appId: APP_ID }), 'CHAT_IDENTITY_REQUIRED');
  await rejectsCode(f.call('a', { operation: 'list', userIdHint: 'b' }), 'CHAT_IDENTITY_MISMATCH');
  f.games.game1.status = 'finished'; f.games.game1.participants = ['a']; f.games.game1.seats.red = null;
  await rejectsCode(f.call('a', { operation: 'list' }), 'NOT_MEMBER');
  f.authority.tables[0] = 'game-new';
  await rejectsCode(f.call('s', { operation: 'list' }), 'CHAT_ROOM_INACTIVE');
});

test('六个固定互动可发，白旗不改变棋局，自由文本不能冒充互动', async () => {
  const f = fixture(), before = clone(f.games.game1);
  assert.deepEqual(Object.keys(REACTIONS), ['handshake', 'thumbsup', 'badmove', 'cry', 'laugh', 'whiteflag']);
  for (const [index, reaction] of Object.keys(REACTIONS).entries()) {
    const result = await f.call('a', { operation: 'send', reqId: `reaction-${index}`, reaction });
    assert.equal(result.message.kind, 'reaction'); assert.equal(result.message.reaction, reaction);
    assert.ok(result.message.text); f.advance(2000);
  }
  assert.equal(f.checks(), 0); assert.deepEqual(f.games.game1, before);
  await rejectsCode(f.call('a', { operation: 'send', reqId: 'bad-reaction', reaction: 'resign' }), 'BAD_REACTION');
  for (const reaction of [null, ['laugh'], { kind: 'laugh' }]) await rejectsCode(f.call('a', { operation: 'send', reqId: 'wrong-type', reaction }), 'BAD_REACTION');
  await rejectsCode(f.call('a', { operation: 'send', reqId: 'mixed', reaction: 'laugh', text: '自由输入' }), 'BAD_CHAT_CONTENT');
});

test('200 Unicode 字、空白、控制符及reqId输入边界', async () => {
  const f = fixture();
  const text = '棋'.repeat(100) + '😀'.repeat(100);
  assert.equal((await f.call('a', send('unicode', text))).message.text, text);
  for (const bad of ['', ' \n ', '😀'.repeat(201), '文本\u0000']) await rejectsCode(f.call('b', send('bad', bad)), 'BAD_CHAT_TEXT');
  await rejectsCode(f.call('b', send('bad/id')), 'BAD_REQ_ID');
  await rejectsCode(f.call('b', { operation: 'send', text: '缺ID' }), 'BAD_REQ_ID');
});

test('同reqId重发幂等、不同内容冲突，2秒限频不被换昵称绕过', async () => {
  const f = fixture();
  const result = await f.call('a', send('r1'));
  const duplicate = await f.call('a', send('r1'));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.message.id, result.message.id); assert.equal(duplicate.seq, 1);
  assert.equal(f.checks(), 1);
  await rejectsCode(f.call('a', send('r1', '换内容')), 'REQ_ID_CONFLICT');
  f.users.a.name = '改名';
  await rejectsCode(f.call('a', send('r2')), 'CHAT_RATE_LIMIT');
  f.advance(1999); await rejectsCode(f.call('a', send('r2')), 'CHAT_RATE_LIMIT');
  f.advance(1); assert.equal((await f.call('a', send('r2'))).message.name, '改名');
});

test('并发不同棋手原子seq，同人并发只提交一次，重复并发仍幂等', async () => {
  const f = fixture();
  const results = await Promise.all(['a', 'b', 's'].map(who => f.call(who, send(`r-${who}`))));
  assert.deepEqual(results.map(value => value.message.seq).sort(), [1, 2, 3]);
  f.advance(2000);
  const same = await Promise.all([f.call('a', send('same')), f.call('a', send('same'))]);
  assert.equal(same[0].message.id, same[1].message.id); assert.equal(same.filter(value => value.duplicate).length, 1);
  f.advance(2000);
  const conflict = await Promise.allSettled([f.call('a', send('other1')), f.call('a', send('other2'))]);
  assert.equal(conflict.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(conflict.find(value => value.status === 'rejected').reason.code, 'CHAT_RATE_LIMIT');
  assert.equal((await f.call('b', { operation: 'list' })).seq, 5);
});

test('审核异常/不通过不保存；审核期间离桌后事务重新核验拒绝', async () => {
  for (const checkText of [async () => false, async () => { throw new Error('upstream-private'); }]) {
    const f = fixture({ checkText });
    await rejectsCode(f.call('a', send('denied')), checkText.toString().includes('throw') ? 'CHAT_TEXT_UNAVAILABLE' : 'CHAT_TEXT_REJECTED');
    assert.equal((await f.call('b', { operation: 'list' })).seq, 0);
  }
  let checked, complete;
  const pending = new Promise(resolve => { checked = resolve; });
  const f = fixture({ checkText: async () => { checked(); return new Promise(resolve => { complete = resolve; }); } });
  const request = f.call('a', send('late')); await pending;
  f.games.game1.seats.red = null; complete(true);
  await rejectsCode(request, 'NOT_MEMBER');
  assert.equal((await f.call('b', { operation: 'list' })).seq, 0);
});

test('最近50条且seq不倒退；裁掉正文后重复reqId仍不重发，去重记录不留正文', async () => {
  const f = fixture();
  for (let index = 0; index < 55; index++) { await f.call('a', send(`r${index}`, `内容${index}`)); f.advance(2000); }
  const current = await f.call('b', { operation: 'list' });
  assert.equal(current.seq, 55); assert.equal(current.messages.length, 50); assert.equal(current.messages[0].seq, 6);
  const duplicate = await f.call('a', send('r0', '内容0'));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.seq, 55); assert.equal(duplicate.message, undefined);
  const stored = f.store.exportState();
  assert.equal(Object.keys(stored.receipts).length, 55);
  assert.ok(Object.values(stored.receipts).every(value => !('text' in value) && !('message' in value)));
});

test('持久化失败不确认、不部分更新，并可继续重试同reqId', async () => {
  let fail = true;
  const f = fixture({ persist: () => { if (fail) throw new Error('disk unavailable'); } });
  await assert.rejects(f.call('a', send('retry')));
  assert.equal((await f.call('b', { operation: 'list' })).seq, 0);
  assert.equal(Object.keys(f.store.exportState().receipts).length, 0);
  fail = false; assert.equal((await f.call('a', send('retry'))).seq, 1);
});

function cloudFixture() {
  const data = new Map(), writes = [], checkerCalls = []; let identity = { APPID: APP_ID, OPENID: 'openid-a' }, queue = Promise.resolve(), getFailure = () => null;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  data.set('gouge_chess_state/authority', { schema: 1, tables: ['game1', null, null, null, null, null] });
  data.set(`gouge_chess_state/${hash('users:a')}`, { kind: 'users', key: 'a', json: JSON.stringify({ id: 'a', name: '真实昵称', kind: 'human', openid: 'openid-a' }) });
  data.set(`gouge_chess_state/${hash('games:game1')}`, { kind: 'games', key: 'game1', json: JSON.stringify({ id: 'game1', mode: 'pvp', tableId: 1, seats: { red: 'a', black: null }, spectators: [] }) });
  function collection(name, state, transactional = false) {
    return { doc: id => ({ get: async () => { const error = getFailure(name, id); if (error) throw error; return { data: clone(state.get(`${name}/${id}`) || null) }; },
      set: async ({ data: value }) => { assert.equal(transactional, true); assert.equal(name, 'gouge_chess_chat'); state.set(`${name}/${id}`, clone(value)); writes.push(`${name}/${id}`); return { errMsg: 'document.set:ok' }; } }),
      where: filter => ({ orderBy: () => ({ skip: offset => ({ limit: limit => ({ get: async () => ({ data: [...state].filter(([key, value]) => key.startsWith(`${name}/`) && value.kind === filter.kind).slice(offset, offset + limit).map(([, value]) => clone(value)) }) }) }) }) }) };
  }
  const db = { collection: name => collection(name, data), runTransaction: callback => {
    const pending = queue.then(async () => { const next = clone(data); const result = await callback({ collection: name => collection(name, next, true) }); data.clear(); for (const [key, value] of next) data.set(key, value); return result; });
    queue = pending.catch(() => {}); return pending;
  } };
  const cloud = { DYNAMIC_CURRENT_ENV: 'dynamic', init: () => {}, getWXContext: () => identity, database: () => db,
    openapi: { security: { msgSecCheck: async input => { checkerCalls.push(input); return { errCode: 0, result: { suggest: 'pass' } }; } } } };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('index.js', cloudRoot), 'utf8'), { module, exports: module.exports,
    require: name => name === 'wx-server-sdk' ? cloud : name === './handler.cjs' ? require('../cloudfunctions/gouge-chess-chat/handler.cjs') : require(name), Date, process: { env: {} } });
  return { main: module.exports.main, data, writes, checkerCalls, setIdentity: value => { identity = value; }, setGetFailure: value => { getFailure = value; }, cloud };
}

test('云包装受信WXContext、原库只读跨集合事务与安全审核精确参数', async () => {
  const f = cloudFixture(), original = clone([...f.data]);
  const sent = await f.main({ operation: 'send', gameId: 'game1', userIdHint: 'a', reqId: 'cloud1', text: '真实文字', APPID: APP_ID, OPENID: '伪造' });
  assert.equal(sent.seq, 1); assert.equal(sent.message.name, '真实昵称');
  assert.deepEqual(clone(f.checkerCalls[0]), { version: 2, scene: 4, openid: 'openid-a', content: '真实文字' });
  assert.ok(f.writes.every(key => key.startsWith('gouge_chess_chat/')));
  assert.deepEqual([...f.data].filter(([key]) => key.startsWith('gouge_chess_state/')), original);
  assert.equal((await f.main({ operation: 'list', gameId: 'game1' })).seq, 1);
  f.setIdentity({ APPID: APP_ID, OPENID: 'wrong' });
  assert.equal((await f.main({ operation: 'list', gameId: 'game1', userIdHint: 'a', OPENID: 'openid-a' })).code, 'CHAT_IDENTITY_MISMATCH');
  f.setIdentity({ APPID: 'wrong-app', OPENID: 'openid-a' });
  assert.equal((await f.main({ operation: 'list', gameId: 'game1' })).code, 'CHAT_IDENTITY_REQUIRED');
});

test('云包装审核返回不完整/审核失败及未知数据库错误均failclosed且不泄露上游内容', async () => {
  const f = cloudFixture();
  f.cloud.openapi.security.msgSecCheck = async () => ({ errCode: 0 });
  assert.equal((await f.main({ operation: 'send', gameId: 'game1', userIdHint: 'a', reqId: 'unsafe', text: '待审' })).code, 'CHAT_TEXT_UNAVAILABLE');
  assert.equal(f.writes.length, 0);
  f.cloud.openapi.security.msgSecCheck = async () => ({ errCode: 0, result: { suggest: 'risky' } });
  assert.equal((await f.main({ operation: 'send', gameId: 'game1', userIdHint: 'a', reqId: 'unsafe', text: '待审' })).code, 'CHAT_TEXT_REJECTED');
  f.cloud.openapi.security.msgSecCheck = async () => { throw new Error('secret-token-debug'); };
  const failure = await f.main({ operation: 'send', gameId: 'game1', userIdHint: 'a', reqId: 'unsafe', text: '待审' });
  assert.equal(failure.code, 'CHAT_TEXT_UNAVAILABLE'); assert.ok(!JSON.stringify(failure).includes('secret-token'));
  assert.equal(f.writes.length, 0);
  f.setGetFailure(() => Object.assign(new Error('secret-db-detail'), { code: 'PERMISSION_DENIED' }));
  const unavailable = await f.main({ operation: 'list', gameId: 'game1', userIdHint: 'a' });
  assert.equal(unavailable.code, 'CHAT_UNAVAILABLE'); assert.ok(!JSON.stringify(unavailable).includes('secret-db'));
});

test('仅明确DOCUMENT_NOT_FOUND允许创建新聊天文档，不吞数据库权限错误', async () => {
  const f = cloudFixture();
  f.setGetFailure((name, id) => name === 'gouge_chess_chat' && !f.data.has(`${name}/${id}`) ? Object.assign(new Error('missing'), { code: 'DOCUMENT_NOT_FOUND' }) : null);
  const result = await f.main({ operation: 'send', gameId: 'game1', userIdHint: 'a', reqId: 'missing', reaction: 'thumbsup' });
  assert.equal(result.seq, 1); assert.equal(result.message.reaction, 'thumbsup');
});

test('本地HTTP必须已有Bearer；DEV隔离聊天持久化而不污染棋局，正式HTTP无开发绕过', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gouge-chat-http-'));
  const app = createApp({ env: { DEV_MODE: 'true' }, dataDir: directory, autoTimers: false });
  let production, resumed;
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { if (production) await production.close(); if (resumed) await resumed.close(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = async (path, token, body) => { const result = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: result.status, ...(await result.json()) }; };
  const a = await api('/api/login/dev', null, { name: 'A' }), s = await api('/api/login/dev', null, { name: 'S' });
  const { gameId } = await api('/api/tables/1/join', a.token, {}); await api('/api/tables/1/watch', s.token, {});
  const before = clone(app.state);
  assert.equal((await api(`/api/games/${gameId}/chat`, null)).status, 401);
  assert.equal((await api(`/api/games/${gameId}/chat`, a.token, send('http1'))).seq, 1);
  assert.equal((await api(`/api/games/${gameId}/chat`, s.token)).messages[0].name, 'A');
  assert.deepEqual(app.state, before); assert.ok(!readFileSync(join(directory, 'state.json'), 'utf8').includes('大家好'));
  assert.ok(readFileSync(join(directory, 'chat.json'), 'utf8').includes('大家好'));
  await api('/api/tables/1/leave', s.token, { gameId });
  assert.equal((await api(`/api/games/${gameId}/chat`, s.token)).code, 'NOT_MEMBER');
  await app.close();
  resumed = createApp({ env: { DEV_MODE: 'true' }, dataDir: directory, autoTimers: false });
  const resumedAddress = await resumed.listen(0);
  const restored = await fetch(`http://127.0.0.1:${resumedAddress.port}/api/games/${gameId}/chat`, { headers: { Authorization: `Bearer ${a.token}` } }).then(result => result.json());
  assert.equal(restored.seq, 1); assert.equal(restored.messages[0].text, '大家好');
  production = createApp({ env: { DEV_MODE: 'false', WECHAT_APP_ID: 'wx-test', WECHAT_APP_SECRET: 'test-only', PUBLIC_BASE_URL: 'https://example.test' }, dataDir: join(directory, 'production'), autoTimers: false,
    fetch: async () => ({ ok: true, json: async () => ({ openid: 'real-openid', session_key: 'test-only-session' }) }) });
  const prodAddress = await production.listen(0);
  const logged = await fetch(`http://127.0.0.1:${prodAddress.port}/api/login/wechat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'mock-wechat-login' }) }).then(value => value.json());
  const disabled = await fetch(`http://127.0.0.1:${prodAddress.port}/api/games/unused/chat`, { headers: { Authorization: `Bearer ${logged.token}` } });
  assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'CHAT_CLOUD_FUNCTION_REQUIRED');
});
