import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = resolve(process.env.ITO_HOST_ROOT || fileURLToPath(new URL('../../wechat-app/', import.meta.url)));
const settle = () => new Promise(resolve => setImmediate(resolve));
const msg = seq => ({ id: 'm' + seq, seq, userId: 'me', name: '棋友', kind: 'text', text: '第' + seq + '条', at: 1000 });
const snapshot = seq => ({ gameId: 'game-1', seq, messages: Array.from({ length: seq }, (_, n) => msg(n + 1)) });

function fixture(integrated, cloud = false) {
  const calls = [], updates = [], additions = [], timers = new Map();
  const app = { globalData: { token: 'session-A', user: { id: 'me' } } };
  const config = cloud ? { transport: 'cloud', cloudEnv: 'test-env', chatFunction: 'gouge-chess-chat' } : {};
  const f = { app, calls, updates, additions, timers, list: () => Promise.resolve(snapshot(0)), send: () => Promise.resolve({ ...snapshot(1), message: msg(1) }) };
  const wx = { cloud: { init() {}, callFunction(options) { calls.push(options); return f.cloud(options); } } };
  const api = { errorText: error => error.message, request(path, method, data, auth, token) {
    calls.push({ path, method, data, auth, token });
    return method === 'GET' ? f.list() : f.send(data);
  } };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(integrated ? resolve(host, 'chess/services/chat.js') : resolve('miniprogram/services/chat.js'), 'utf8'), {
    module, wx, getApp: () => app, Date, Math,
    require(name) { if (name === '../session') return { getChessApp: () => app }; if (name === '../config') return config; if (name === './api') return api; throw new Error(name); },
    setTimeout(callback, ms) { const id = timers.size + 1; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  f.room = new module.exports('game-1', { onState: value => updates.push(JSON.parse(JSON.stringify(value))), onNew: value => additions.push(JSON.parse(JSON.stringify(value))) });
  return f;
}

for (const integrated of [false, true]) {
  const label = integrated ? 'HOST' : 'standalone';
  test(label + ' chat polls over HTTP, hides history from subtitles and displays each new named message once', async () => {
    const f = fixture(integrated); f.list = () => Promise.resolve(snapshot(2));
    f.room.start(); await settle();
    assert.equal(f.room.ready, true); assert.equal(f.room.seq, 2); assert.equal(f.additions.length, 0);
    f.list = () => Promise.resolve(snapshot(3)); await f.room.refresh(); await f.room.refresh();
    assert.equal(f.additions.length, 1); assert.equal(f.additions[0][0].name, '棋友'); assert.equal(f.additions[0][0].seq, 3);
    assert.equal(f.calls[0].token, 'session-A'); assert.equal(f.calls[0].method, 'GET');
    f.room.stop(); assert.equal(f.timers.size, 0);
  });
  test(label + ' a delayed read cannot overwrite a successful send or replay a subtitle', async () => {
    const f = fixture(integrated); let finish;
    f.list = () => new Promise(resolve => { finish = resolve; }); f.room.start();
    f.send = () => Promise.resolve({ ...snapshot(3), message: msg(3) });
    assert.equal(await f.room.send({ text: '这步不错' }), true);
    finish(snapshot(1)); await settle();
    assert.equal(f.room.seq, 3); assert.equal(f.room.messages.length, 3);
    assert.equal(f.additions.length, 1); assert.equal(f.additions[0][0].seq, 3);
    f.room.stop();
  });
  test(label + ' hiding and replacement identities ignore late responses and never share the old chat cache', async () => {
    const f = fixture(integrated); let finish;
    f.list = () => new Promise(resolve => { finish = resolve; }); f.room.start();
    f.room.stop(); const count = f.updates.length; finish(snapshot(2)); await settle();
    assert.equal(f.updates.length, count);
    f.list = () => Promise.resolve(snapshot(1)); f.room.start(); await settle();
    let finishSend; f.send = () => new Promise(resolve => { finishSend = resolve; });
    const pending = f.room.send({ reaction: 'whiteflag' });
    f.app.globalData.token = 'session-B'; f.app.globalData.user = { id: 'other' };
    f.list = () => Promise.resolve(snapshot(0)); f.room.start(); await settle();
    finishSend({ ...snapshot(2), message: msg(2) }); assert.equal(await pending, false);
    assert.equal(f.room.seq, 0); assert.equal(f.room.messages.length, 0); assert.equal(f.additions.length, 0);
    f.room.stop();
  });
  test(label + ' retry after a lost send response uses the same request id and retains the error until recovery', async () => {
    const f = fixture(integrated); f.room.start(); await settle();
    f.send = () => Promise.reject(new Error('消息确认丢失'));
    await assert.rejects(f.room.send({ text: '你好' }), /确认丢失/);
    assert.equal(f.room.busy, false); assert.equal(f.room.error, '消息确认丢失');
    const id = f.calls.at(-1).data.reqId;
    f.send = () => Promise.resolve({ ...snapshot(1), message: msg(1), duplicate: true });
    assert.equal(await f.room.send({ text: '你好' }), true);
    assert.equal(f.calls.at(-1).data.reqId, id); assert.equal(f.room.error, '');
    f.room.stop();
  });
  test(label + ' cloud chat uses the named function and a server-verified identity hint; logical failures stay visible', async () => {
    const f = fixture(integrated, true); f.cloud = () => Promise.resolve({ result: snapshot(0) });
    f.room.start(); await settle();
    assert.equal(f.calls[0].name, 'gouge-chess-chat'); assert.equal(f.calls[0].data.userIdHint, 'me'); assert.equal(f.calls[0].config.env, 'test-env');
    f.cloud = () => Promise.resolve({ result: { ok: false, code: 'NOT_MEMBER', error: '已经离开这桌' } });
    await assert.rejects(f.room.send({ reaction: 'whiteflag' }), /离开/);
    assert.equal(f.room.error, '已经离开这桌'); assert.equal(f.room.busy, false);
    f.room.stop();
  });
}

for (const integrated of [false, true]) {
  const label = integrated ? 'HOST' : 'standalone';
  test(label + ' the initial read may contain a just-sent message before its acknowledgement and still subtitles it exactly once', async () => {
    const f = fixture(integrated); let finishRead, finishSend;
    f.list = () => new Promise(resolve => { finishRead = resolve; });
    f.send = () => new Promise(resolve => { finishSend = resolve; });
    f.room.start(); const pending = f.room.send({ text: '刚发的一条' });
    finishRead(snapshot(1)); await settle(); assert.equal(f.additions.length, 0);
    finishSend({ ...snapshot(1), message: msg(1) }); assert.equal(await pending, true);
    assert.equal(f.additions.length, 1); assert.deepEqual(f.additions[0].map(message => message.seq), [1]);
    f.list = () => Promise.resolve(snapshot(1)); await f.room.refresh();
    assert.equal(f.additions.length, 1); f.room.stop();
  });
  test(label + ' a newer initial read stays authoritative while a delayed successful own acknowledgement only subtitles that message', async () => {
    const f = fixture(integrated); let finishRead, finishSend;
    f.list = () => new Promise(resolve => { finishRead = resolve; });
    f.send = () => new Promise(resolve => { finishSend = resolve; });
    f.room.start(); const pending = f.room.send({ text: '晚确认' });
    finishRead(snapshot(2)); await settle();
    finishSend({ ...snapshot(1), message: msg(1) }); assert.equal(await pending, true);
    assert.equal(f.room.seq, 2); assert.equal(f.room.messages.length, 2);
    assert.equal(f.additions.length, 1); assert.deepEqual(f.additions[0].map(message => message.seq), [1]); f.room.stop();
  });
  test(label + ' lost acknowledgements retain their request id across a same-identity settings return and clear on a different identity', async () => {
    const f = fixture(integrated); f.room.start(); await settle();
    f.send = () => Promise.reject(new Error('确认丢失'));
    await assert.rejects(f.room.send({ text: '回来重试' }), /确认丢失/);
    const originalId = f.calls.at(-1).data.reqId;
    f.room.stop(); f.list = () => Promise.resolve(snapshot(1)); f.room.start(); await settle();
    f.send = () => Promise.resolve({ ...snapshot(1), message: msg(1), duplicate: true });
    assert.equal(await f.room.send({ text: '回来重试' }), true);
    assert.equal(f.calls.at(-1).data.reqId, originalId);
    assert.equal(f.additions.length, 1);
    f.send = () => Promise.reject(new Error('又一次确认丢失'));
    await assert.rejects(f.room.send({ text: '另一次' }), /确认丢失/);
    const oldIdentityId = f.calls.at(-1).data.reqId;
    f.room.stop(); f.app.globalData.token = 'session-B'; f.app.globalData.user = { id: 'other' };
    f.list = () => Promise.resolve(snapshot(0)); f.room.start(); await settle();
    f.send = () => Promise.resolve(snapshot(0)); await f.room.send({ text: '另一次' });
    assert.notEqual(f.calls.at(-1).data.reqId, oldIdentityId); f.room.stop();
  });
}

for (const integrated of [false, true]) {
  const label = integrated ? 'HOST' : 'standalone';
  test(label + ' a CHAT_TEXT_UNAVAILABLE send error survives successful polling and clears only when retrying or succeeding', async () => {
    const f = fixture(integrated, true);
    f.cloud = options => Promise.resolve({ result: options.data.operation === 'send'
      ? { ok: false, code: 'CHAT_TEXT_UNAVAILABLE', error: '文字检查暂时不可用，请稍后重试' }
      : snapshot(0) });
    f.room.start(); await settle();
    await assert.rejects(f.room.send({ text: '一条未能发送的文字' }), /文字检查暂时不可用/);
    const failed = f.room.error;
    await f.room.refresh(); assert.equal(f.room.ready, true); assert.equal(f.room.error, failed);
    assert.equal(f.updates.at(-1).error, failed);
    f.room.stop(); f.room.start(); await settle(); assert.equal(f.room.error, failed);
    let finish;
    f.cloud = options => options.data.operation === 'list' ? Promise.resolve({ result: snapshot(0) })
      : new Promise(resolve => { finish = resolve; });
    const retry = f.room.send({ text: '一条未能发送的文字' });
    assert.equal(f.room.error, ''); assert.equal(f.room.busy, true);
    finish({ result: { ...snapshot(1), message: msg(1) } }); assert.equal(await retry, true);
    assert.equal(f.room.error, ''); f.room.stop();
  });
  test(label + ' a read-only error clears after a successful read and never replaces an unresolved send failure', async () => {
    const f = fixture(integrated); f.room.start(); await settle();
    f.list = () => Promise.reject(new Error('读取失败'));
    await assert.rejects(f.room.refresh(), /读取失败/); assert.equal(f.room.error, '读取失败');
    f.list = () => Promise.resolve(snapshot(0)); await f.room.refresh(); assert.equal(f.room.error, '');
    f.send = () => Promise.reject(new Error('发送失败'));
    await assert.rejects(f.room.send({ reaction: 'thumbsup' }), /发送失败/);
    f.list = () => Promise.reject(new Error('又一次读取失败'));
    await assert.rejects(f.room.refresh(), /读取失败/); assert.equal(f.room.error, '发送失败');
    f.list = () => Promise.resolve(snapshot(1)); await f.room.refresh(); assert.equal(f.room.error, '发送失败');
    f.room.stop();
  });
}
