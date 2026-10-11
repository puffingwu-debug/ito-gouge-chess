import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';

const productionEnv = {
  DEV_MODE: 'false', HOST: '127.0.0.1', PUBLIC_BASE_URL: 'https://chess.example.invalid',
  WECHAT_APP_ID: 'wx-test-only', WECHAT_APP_SECRET: 'test-only-secret', WECHAT_VOICE_ENABLED: 'false',
};
async function provider(url) {
  const request = new URL(url);
  assert.equal(request.origin, 'https://api.weixin.qq.com');
  assert.equal(request.pathname, '/sns/jscode2session');
  assert.equal(request.searchParams.get('appid'), productionEnv.WECHAT_APP_ID);
  assert.equal(request.searchParams.get('secret'), productionEnv.WECHAT_APP_SECRET);
  return { ok: true, json: async () => ({ openid: request.searchParams.get('js_code'), session_key: 'test-only-session' }) };
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gouge-production-test-'));
  const apps = [];
  const start = async () => {
    const app = createApp({ env: productionEnv, dataDir: directory, fetch: provider });
    apps.push(app);
    const address = await app.listen(0);
    return { app, port: address.port, base: `http://127.0.0.1:${address.port}` };
  };
  t.after(async () => {
    for (const app of apps) await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, start, ...(await start()) };
}
async function api(base, path, token, body, origin) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...(await response.json()) };
}
function frame(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket frame timeout')), 3000);
    const message = bytes => finish(null, JSON.parse(bytes));
    const error = failure => finish(failure);
    function finish(failure, result) {
      clearTimeout(timer); ws.off('message', message); ws.off('error', error);
      failure ? reject(failure) : resolve(result);
    }
    ws.once('message', message); ws.once('error', error);
  });
}

// A real local HTTP/upgrade transport substitute; it does not validate Caddy or TLS.
async function proxy(port) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const server = http.createServer((req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(port, '127.0.0.1'); track(upstream);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('生产模式缺配置或使用 HTTP 公网地址时拒绝启动且不写数据', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gouge-production-guard-'));
  const dataDir = join(directory, 'not-created');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const env of [
    { DEV_MODE: 'false' },
    { ...productionEnv, WECHAT_APP_SECRET: '' },
    { ...productionEnv, PUBLIC_BASE_URL: 'http://chess.example.invalid' },
  ]) assert.throws(() => createApp({ env, dataDir }), /正式模式/);
  assert.equal(existsSync(dataDir), false);
});

test('生产 HTTP 和真实 WebSocket 经代理保留认证、来源限制和棋局订阅', { timeout: 10000 }, async t => {
  const f = await fixture(t), forwarding = await proxy(f.port);
  let ws;
  try {
    const health = await api(forwarding.base, '/api/health', null, undefined, productionEnv.PUBLIC_BASE_URL);
    assert.equal(health.status, 200); assert.equal(health.ok, true); assert.equal(health.devMode, false);
    assert.equal(health.wechatConfigured, true); assert.equal(health.voiceConfigured, false); assert.equal(health.deepseekConfigured, false);
    assert.equal(JSON.stringify(health).includes(productionEnv.WECHAT_APP_SECRET), false);
    assert.equal((await api(forwarding.base, '/api/health', null, undefined, 'https://unallowed.example.invalid')).code, 'BAD_ORIGIN');
    const disabled = await api(forwarding.base, '/api/login/dev', null, { name: '禁止的开发账号' }, productionEnv.PUBLIC_BASE_URL);
    assert.equal(disabled.status, 403); assert.equal(disabled.code, 'DEV_DISABLED');
    const login = await api(forwarding.base, '/api/login/wechat', null, { code: 'production-player' }, productionEnv.PUBLIC_BASE_URL);
    assert.equal(login.status, 200); assert.ok(login.token); assert.equal('sessionKey' in login.user, false);
    const joined = await api(forwarding.base, '/api/tables/1/join', login.token, { color: 'red' }, productionEnv.PUBLIC_BASE_URL);
    assert.equal(joined.status, 200);
    const voice = await api(forwarding.base, '/api/voice/sign', login.token, { gameId: joined.gameId }, productionEnv.PUBLIC_BASE_URL);
    assert.equal(voice.status, 503); assert.equal(voice.code, 'VOICE_UNCONFIGURED');
    ws = new WebSocket(`${forwarding.base.replace('http:', 'ws:')}/ws?token=${login.token}`, { origin: productionEnv.PUBLIC_BASE_URL });
    assert.equal((await frame(ws)).type, 'lobby');
    const subscription = frame(ws); ws.send(JSON.stringify({ type: 'subscribe', gameId: joined.gameId }));
    const snapshot = await subscription;
    assert.equal(snapshot.type, 'game'); assert.equal(snapshot.game.id, joined.gameId);
    assert.equal(snapshot.game.seats.red.id, login.user.id);
    const pong = frame(ws); ws.send(JSON.stringify({ type: 'ping' })); assert.equal((await pong).type, 'pong');
    const denied = new WebSocket(`${forwarding.base.replace('http:', 'ws:')}/ws?token=${login.token}`, { origin: 'https://unallowed.example.invalid' });
    const deniedError = await new Promise((resolve, reject) => {
      denied.once('open', () => { denied.terminate(); reject(new Error('Unallowed WebSocket origin opened')); });
      denied.once('error', resolve);
    });
    assert.match(deniedError.message, /401/);
  } finally {
    ws?.terminate(); await forwarding.close();
  }
});

test('生产单实例重启保留微信会话和棋桌，持久化不保存明文令牌', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const login = await api(f.base, '/api/login/wechat', null, { code: 'restart-player' });
  assert.equal(login.status, 200);
  const joined = await api(f.base, '/api/tables/3/join', login.token, { color: 'black' });
  assert.equal(joined.status, 200);
  await f.app.close();
  const stateFile = join(f.directory, 'state.json');
  assert.equal(readFileSync(stateFile, 'utf8').includes(login.token), false);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const resumed = await f.start();
  const me = await api(resumed.base, '/api/me', login.token);
  assert.equal(me.status, 200); assert.equal(me.user.id, login.user.id);
  const result = await api(resumed.base, `/api/games/${joined.gameId}`, login.token);
  assert.equal(result.status, 200); assert.equal(result.game.status, 'waiting');
  assert.equal(result.game.tableId, 3); assert.equal(result.game.seats.black.id, login.user.id);
  assert.equal((await api(resumed.base, '/api/lobby', login.token)).tables[2].gameId, joined.gameId);
});
