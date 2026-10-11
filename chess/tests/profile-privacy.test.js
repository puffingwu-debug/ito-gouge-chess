import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const targets = [
  { label: 'standalone', root: resolve('miniprogram') },
  { label: 'integrated', root: resolve(host, 'chess'), integrated: true }
];
const settle = () => new Promise(resolve => setImmediate(resolve));
const saveEvent = { detail: { value: { name: '新昵称' } } };

async function harness(target, authorization = 'deny') {
  const config = { apiBase: 'http://127.0.0.1:8787', development: true, transport: 'http' };
  const user = { id: 'me', name: '原昵称' };
  const storage = new Map([['gougeSession', { token: 'token-1', user, ...config }]]);
  const requests = [], reads = [], authorizations = [], toasts = [], cache = new Map();
  let app, definition;
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    showToast: options => toasts.push(options),
    getFileSystemManager: () => ({ readFile(options) {
      reads.push(options.filePath); options.success({ data: 'iVBORtest-avatar' });
    } }),
    request(options) {
      const path = new URL(options.url).pathname;
      requests.push({ path, method: options.method, data: options.data });
      const data = path === '/api/avatar' ? { avatar: '/avatars/new.png' } :
        { user: options.method === 'PATCH' ? { ...user, ...options.data } : user };
      options.success({ statusCode: 200, data });
    }
  };
  if (authorization !== 'missing') wx.requirePrivacyAuthorize = options => {
    authorizations.push(options);
    if (authorization === 'deny') options.fail({ errMsg: 'requirePrivacyAuthorize:fail 用户拒绝授权' });
    if (authorization === 'allow') options.success({ errMsg: 'requirePrivacyAuthorize:ok' });
  };
  function load(file) {
    file = resolve(target.root, file); if (!extname(file)) file += '.js';
    if (file === resolve(target.root, 'config.js')) return config;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, exports: module.exports, wx, console, Date,
      require: name => load(resolve(dirname(file), name)), getApp: () => app,
      App: value => { app = value; }, Page: value => { definition = value; },
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
    }, { filename: file });
    return module.exports;
  }
  if (target.integrated) app = load('session.js').getChessApp();
  else { load('app.js'); app.onLaunch(); }
  load('pages/settings/index.js');
  const page = { ...definition, data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch); } };
  await page.onLoad({});
  requests.length = 0;
  page.avatar({ detail: { avatarUrl: '/tmp/chosen-avatar.png' } });
  return { app, page, wx, storage, requests, reads, authorizations, toasts };
}

for (const target of targets) {
  const options = { skip: !existsSync(resolve(target.root, 'pages/settings/index.js')) && 'Set ITO_HOST_ROOT to test integrated chess' };
  for (const authorization of ['deny', 'missing']) for (const withAvatar of [true, false]) {
    test(target.label + ' profile save does not read an avatar or send data without privacy authorization (' + authorization + ', avatar=' + withAvatar + ')', options, async () => {
      const h = await harness(target, authorization);
      if (!withAvatar) h.page.setData({ avatarPath: '' });
      const before = structuredClone(h.storage.get('gougeSession'));
      await h.page.save(saveEvent);
      assert.equal(h.reads.length, 0, 'Unauthorized avatar must not be read');
      assert.equal(h.requests.length, 0, 'Unauthorized profile must not be submitted');
      assert.deepEqual(h.storage.get('gougeSession'), before);
      assert.equal(h.page.data.saved, false);
      assert.equal(h.page.data.busy, false);
      assert.ok(h.page.data.error, 'Explain why saving did not proceed');
    });
  }
  for (const withAvatar of [true, false]) {
    test(target.label + ' authorized profile save retains avatar upload and nickname saving (avatar=' + withAvatar + ')', options, async () => {
      const h = await harness(target, 'allow');
      if (!withAvatar) h.page.setData({ avatarPath: '' });
      await h.page.save(saveEvent);
      assert.equal(h.authorizations.length, 1);
      assert.deepEqual(h.reads, withAvatar ? ['/tmp/chosen-avatar.png'] : []);
      assert.deepEqual(structuredClone(h.requests), withAvatar ? [
        { path: '/api/avatar', method: 'POST', data: { dataUrl: 'data:image/png;base64,iVBORtest-avatar' } },
        { path: '/api/me', method: 'PATCH', data: { name: '新昵称', avatar: '/avatars/new.png' } }
      ] : [{ path: '/api/me', method: 'PATCH', data: { name: '新昵称' } }]);
      assert.equal(h.app.globalData.user.name, '新昵称');
      assert.equal(h.storage.get('gougeSession').user.name, '新昵称');
      assert.equal(h.page.data.saved, true);
      assert.equal(h.page.data.busy, false);
      assert.equal(h.page.data.error, '');
      assert.equal(h.page.data.avatarPath, '');
      assert.equal(h.toasts.length, 1);
    });
  }
  for (const cancellation of target.integrated ? ['logout', 'replace', 'unload'] : ['logout', 'replace']) {
    test(target.label + ' pending privacy authorization cannot submit a cancelled profile save (' + cancellation + ')', options, async () => {
      const h = await harness(target, 'pending');
      const pending = h.page.save(saveEvent);
      await settle();
      assert.equal(h.authorizations.length, 1, 'Saving must wait for the privacy authorization result');
      assert.equal(h.reads.length, 0);
      assert.equal(h.requests.length, 0);
      if (cancellation === 'logout') h.app.clearSession();
      else if (cancellation === 'replace') {
        h.app.globalData.token = 'token-2';
        h.app.globalData.user = { id: 'new-user', name: '另一个棋友' };
        h.app.saveSession();
      } else h.page.onUnload();
      const before = structuredClone(h.storage.get('gougeSession'));
      h.authorizations[0].success({ errMsg: 'requirePrivacyAuthorize:ok' });
      await pending;
      assert.equal(h.reads.length, 0, 'Stale save must not read the selected avatar');
      assert.equal(h.requests.length, 0, 'Stale save must not submit under a different session');
      assert.deepEqual(h.storage.get('gougeSession'), before);
      assert.equal(h.page.data.saved, false);
      assert.equal(h.toasts.length, 0);
    });
  }
}
