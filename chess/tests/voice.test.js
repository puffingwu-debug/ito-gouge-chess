import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

function fixture({ manualTimers = false, voiceSound = true } = {}) {
  const calls = [], states = [], cache = new Map();
  const app = { globalData: { token: 'test', config: { development: false } }, clearSession() {} };
  let interrupted, pendingTimer;
  const schedule = manualTimers ? callback => { pendingTimer = callback; return callback; } : setTimeout;
  const cancel = manualTimers ? handle => { if (pendingTimer === handle) pendingTimer = null; } : clearTimeout;
  const wx = {
    getStorageSync(key) { if (key === 'gougePreferences') return { voiceSound }; },
    authorize(options) { calls.push({ type: 'authorize' }); options.success({}); },
    request(options) { calls.push({ type: 'request', url: options.url, header: options.header }); options.success({ statusCode: 200,
      data: options.url.endsWith('/sign') ? { signature: 'real-sign', nonceStr: 'nonce', timeStamp: 12, groupId: 'table' } : { ok: true } }); },
    joinVoIPChat(options) { calls.push({ type: 'join', options }); options.success({ openIdList: ['me'] }); },
    updateVoIPChatMuteConfig(options) { calls.push({ type: 'mute', options }); options.success({}); },
    exitVoIPChat(options) { calls.push({ type: 'exit' }); options.success({}); },
    onVoIPChatMembersChanged() {}, offVoIPChatMembersChanged() {}, offVoIPChatInterrupted() {},
    onVoIPChatInterrupted(callback) { interrupted = callback; }
  };
  function load(file) {
    file = resolve(file); if (!extname(file)) file += '.js';
    if (file.endsWith('/miniprogram/config.js')) return { apiBase: 'http://127.0.0.1:8787' };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, wx, getApp: () => app,
      require: name => load(resolve(dirname(file), name)), setTimeout: schedule, clearTimeout: cancel, Date }, { filename: file });
    return module.exports;
  }
  const VoiceRoom = load('miniprogram/services/voice.js'), VoiceController = load('miniprogram/services/voice-controller.js');
  let controller, connected = true, state = {};
  const room = new VoiceRoom('game-1', value => { state = { ...state, ...value }; states.push({ ...state }); controller?.roomChanged(value); });
  controller = new VoiceController(room, value => { state = { ...state, ...value }; states.push({ ...state }); }, () => connected);
  return { wx, calls, app, room, controller, states, state: () => state, disconnect: () => { connected = false; }, interrupt: () => interrupted({ errMsg: '真实通话中断' }),
    firePress: () => { const callback = pendingTimer; pendingTimer = null; if (callback) callback(); } };
}
async function until(predicate) { for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate()); }

test('点一下加入后持续开麦，再点关闭；只使用真实微信语音 API', async () => {
  const f = fixture();
  assert.equal(await f.controller.tap(), true);
  assert.equal(f.room.joined, true); assert.equal(f.state().continuous, true); assert.equal(f.state().microphone, true);
  assert.equal(f.calls.find(call => call.type === 'join').options.muteConfig.muteMicrophone, true);
  await f.controller.tap();
  assert.equal(f.state().continuous, false); assert.equal(f.state().microphone, false); assert.equal(f.room.joined, true);
  assert.equal(f.calls.filter(call => call.type === 'join').length, 1);
  await f.room.destroy();
});

test('长按临时开麦，松手立即发送静音；长按后不误触持续开麦', async () => {
  const f = fixture(); f.controller.touchStart(); await f.controller.longPress();
  assert.equal(f.state().holding, true); assert.equal(f.state().microphone, true); assert.equal(f.state().continuous, false);
  const release = f.controller.touchEnd();
  assert.equal(f.calls.at(-1).type, 'mute'); assert.equal(f.calls.at(-1).options.muteConfig.muteMicrophone, true);
  await release; await f.controller.tap();
  assert.equal(f.state().microphone, false); assert.equal(f.state().continuous, false);
  f.controller.touchStart(); await f.controller.touchEnd(); await f.controller.tap();
  assert.equal(f.state().continuous, true); await f.room.destroy();
});

test('麦克风授权等待期间松手，晚到授权和加入成功均不打开麦克风', async () => {
  const f = fixture(); let authorize;
  f.wx.authorize = options => { authorize = options; };
  f.controller.touchStart(); const pressing = f.controller.longPress();
  await f.controller.touchEnd(); authorize.success({}); await pressing;
  assert.equal(f.state().holding, false); assert.equal(f.state().microphone, false);
  assert.ok(f.calls.filter(call => call.type === 'mute').every(call => call.options.muteConfig.muteMicrophone));
  await f.room.destroy();
});

test('原生加入等待期间松手，不因成功回调误开麦', async () => {
  const f = fixture(); let joining;
  f.wx.joinVoIPChat = options => { joining = options; f.calls.push({ type: 'join', options }); };
  f.controller.touchStart(); const pressing = f.controller.longPress(); await until(() => joining);
  await f.controller.touchEnd(); joining.success({ openIdList: ['me'] }); await pressing;
  assert.equal(f.state().microphone, false); assert.equal(f.state().holding, false);
  assert.ok(f.calls.filter(call => call.type === 'mute').every(call => call.options.muteConfig.muteMicrophone));
  await f.room.destroy();
});

test('未完成的开麦回调不能覆盖松手静音，晚到回调再次补发静音', async () => {
  const f = fixture(); f.room.joined = true; f.room.sessionToken = f.app.globalData.token;
  let unmute;
  f.wx.updateVoIPChatMuteConfig = options => {
    f.calls.push({ type: 'mute', options });
    if (!options.muteConfig.muteMicrophone) unmute = options; else options.success({});
  };
  f.controller.touchStart(); const pressing = f.controller.longPress(); await until(() => unmute);
  await f.controller.touchEnd(); assert.equal(f.state().microphone, false);
  unmute.success({}); await pressing;
  assert.equal(f.state().microphone, false);
  assert.deepEqual(f.calls.filter(call => call.type === 'mute').map(call => call.options.muteConfig.muteMicrophone), [false, true, true]);
  await f.room.destroy();
});

test('touchcancel、页面隐藏和断线都收麦并且不恢复持续开麦', async () => {
  const f = fixture(); await f.controller.tap(); await f.controller.touchCancel();
  assert.equal(f.state().microphone, false); assert.equal(f.state().continuous, false);
  f.controller.touchStart(); await f.controller.touchEnd(); await f.controller.tap();
  await f.controller.stop('', true); assert.equal(f.room.joined, false); assert.equal(f.state().continuous, false);
  await f.controller.tap(); assert.equal(f.room.joined, false);
  f.controller.resume(); f.disconnect(); f.controller.touchStart(); await f.controller.touchEnd();
  assert.equal(await f.controller.tap(), false); assert.match(f.state().error, /棋局连接尚未恢复/);
  await f.room.destroy();
});

test('隐藏时仍在加入的语音晚到成功会退出，不开启麦克风', async () => {
  const f = fixture(); let joining;
  f.wx.joinVoIPChat = options => { joining = options; };
  const opening = f.controller.tap(); await until(() => joining);
  await f.controller.stop('', true); joining.success({ openIdList: ['me'] }); await opening;
  assert.equal(f.room.joined, false); assert.ok(f.calls.some(call => call.type === 'exit'));
  assert.equal(f.state().microphone, false); assert.equal(f.state().continuous, false);
  await f.room.destroy();
});

test('异步加入途中断线不误开麦，原生中断清除开麦意图', async () => {
  const f = fixture(); let joining;
  f.wx.joinVoIPChat = options => { joining = options; };
  const opening = f.controller.tap(); await until(() => joining); f.disconnect();
  joining.success({ openIdList: ['me'] }); await opening;
  assert.equal(f.room.joined, false); assert.equal(f.state().microphone, false); assert.match(f.state().error, /连接已中断/);
  const g = fixture(); await g.controller.tap(); g.interrupt();
  assert.equal(g.state().microphone, false); assert.equal(g.state().continuous, false); assert.match(g.state().error, /真实通话中断/);
  await f.room.destroy(); await g.room.destroy();
});

test('真实加入或静音失败显示错误并退出，不宣称麦克风已开启', async () => {
  const f = fixture(); f.wx.joinVoIPChat = options => options.fail({ errCode: -2, errMsg: '录音设备被占用' });
  assert.equal(await f.controller.tap(), false); assert.match(f.state().error, /录音设备被占用.*-2/); assert.equal(f.state().microphone, false);
  const g = fixture(); g.wx.updateVoIPChatMuteConfig = options => options.fail({ errMsg: '真实静音接口失败' });
  assert.equal(await g.controller.tap(), false); assert.match(g.state().error, /真实静音接口失败/); assert.equal(g.room.joined, false);
  await f.room.destroy(); await g.room.destroy();
});

test('语音签名晚到新身份后释放原会话席位，不使用新token或清除新会话', async () => {
  const f = fixture(); let signing;
  const request = f.wx.request;
  f.wx.request = options => { if (options.url.endsWith('/sign')) signing = options; else request(options); };
  const pending = f.controller.tap(); await until(() => signing);
  f.app.globalData.token = 'replacement-session';
  signing.success({ statusCode: 200, data: { signature: 'sign', nonceStr: 'nonce', timeStamp: 12, groupId: 'table' } });
  await pending;
  assert.equal(f.calls.some(call => call.type === 'join'), false);
  assert.equal(f.room.microphone, false);
  assert.equal(f.calls.filter(call => call.type === 'request' && call.url.endsWith('/leave')).at(-1).header.Authorization, 'Bearer test');
  assert.equal(f.app.globalData.token, 'replacement-session');
  await f.room.destroy();
});

test('旧身份已加入的房间不能被新身份join或解除静音复用', async () => {
  const f = fixture(); await f.room.join();
  f.app.globalData.token = 'new-member-session';
  const nativeCalls = f.calls.length;
  await assert.rejects(f.room.join(), /身份已改变/);
  await assert.rejects(f.room.mute(true, true), /身份已改变/);
  assert.equal(f.calls.length, nativeCalls); assert.equal(f.room.microphone, false);
  await f.room.destroy();
  assert.equal(f.calls.filter(call => call.type === 'request' && call.url.endsWith('/leave')).at(-1).header.Authorization, 'Bearer test');
  assert.equal(f.app.globalData.token, 'new-member-session');
});

test('解除静音响应晚到身份更换后补发双静音，不发布旧房间开麦状态', async () => {
  const f = fixture(); await f.room.join(); let opening;
  f.wx.updateVoIPChatMuteConfig = options => {
    f.calls.push({ type: 'mute', options });
    if (!options.muteConfig.muteMicrophone) opening = options; else options.success({});
  };
  const pending = f.room.mute(true, true); await until(() => opening);
  f.app.globalData.token = 'new-member-session'; opening.success({});
  await assert.rejects(pending, /身份已改变/);
  assert.equal(f.room.microphone, false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).options.muteConfig)), { muteMicrophone: true, muteEarphone: true });
  await f.room.destroy();
});

test('服务器未启用语音时保留配置错误，不调用微信join或伪称权限已成功', async () => {
  const f = fixture();
  f.wx.request = options => options.success({ statusCode: 503, data: { code: 'VOICE_UNCONFIGURED', error: '服务器尚未启用微信语音服务' } });
  assert.equal(await f.controller.tap(), false);
  assert.match(f.state().error, /服务器尚未启用/);
  assert.equal(f.calls.some(call => call.type === 'join'), false);
  assert.equal(f.state().microphone, false);
  await f.room.destroy();
});


test('长按计时在仍按住时开麦，短按或触摸取消清除计时任务', async () => {
  const f = fixture({ manualTimers: true });
  f.controller.touchStart(); f.firePress(); await until(() => f.room.microphone);
  assert.equal(f.state().holding, true); await f.controller.touchEnd();
  assert.equal(f.room.microphone, false);
  const joins = f.calls.filter(call => call.type === 'join').length;
  f.controller.touchStart(); await f.controller.touchEnd(); f.firePress();
  assert.equal(f.state().holding, false); assert.equal(f.room.microphone, false);
  f.controller.touchStart(); await f.controller.touchCancel(); f.firePress();
  assert.equal(f.state().holding, false); assert.equal(f.room.microphone, false);
  assert.equal(f.calls.filter(call => call.type === 'join').length, joins);
  await f.room.destroy();
});

test('底部输出键独立静音加入并开启收听，连续开麦和按住意图始终关闭', async () => {
  const f = fixture({ voiceSound: false });
  assert.equal(await f.controller.toggleEarphone(), true);
  assert.equal(f.room.joined, true);
  assert.equal(f.room.earphone, true);
  assert.equal(f.room.microphone, false);
  assert.equal(f.state().continuous, false);
  assert.equal(f.state().holding, false);
  const join = f.calls.find(call => call.type === 'join');
  assert.equal(join.options.muteConfig.muteMicrophone, true);
  assert.equal(join.options.muteConfig.muteEarphone, true);
  assert.ok(f.calls.some(call => call.type === 'mute' && call.options.muteConfig.muteMicrophone && !call.options.muteConfig.muteEarphone));
  assert.ok(f.states.every(state => !state.microphone && !state.continuous && !state.holding));
  await f.controller.toggleEarphone();
  assert.equal(f.room.earphone, false);
  assert.equal(f.room.joined, true);
  assert.equal(f.calls.filter(call => call.type === 'join').length, 1);
  await f.room.destroy();
});

test('输出授权晚到页面隐藏或主动退出后，不加入房间也不恢复收听', async () => {
  for (const inactive of [true, false]) {
    const f = fixture({ voiceSound: false }); let authorization;
    f.wx.authorize = options => { authorization = options; };
    const opening = f.controller.toggleEarphone();
    await until(() => authorization);
    await f.controller.stop('', inactive);
    authorization.success({}); await opening;
    assert.equal(f.room.joined, false);
    assert.equal(f.room.microphone, false);
    assert.equal(f.calls.some(call => call.type === 'join'), false);
    assert.ok(f.states.every(state => !(state.joined && state.earphone) && !state.microphone));
    await f.room.destroy();
  }
});

test('输出原生加入晚到隐藏后直接退出，即使默认声音开启也不会短暂放音', async () => {
  const f = fixture(); let joining;
  f.wx.joinVoIPChat = options => { joining = options; f.calls.push({ type: 'join', options }); };
  const opening = f.controller.toggleEarphone(); await until(() => joining);
  assert.equal(joining.muteConfig.muteMicrophone, true);
  assert.equal(joining.muteConfig.muteEarphone, true);
  await f.controller.stop('', true);
  joining.success({ openIdList: ['me'] }); await opening;
  assert.equal(f.room.joined, false);
  assert.equal(f.room.microphone, false);
  assert.ok(f.calls.some(call => call.type === 'exit'));
  assert.ok(f.calls.filter(call => call.type === 'mute').every(call => call.options.muteConfig.muteMicrophone && call.options.muteConfig.muteEarphone));
  await f.room.destroy();
});

test('输出加入途中断线后不启用收听或麦克风，保持原生静音并退出', async () => {
  const f = fixture({ voiceSound: false }); let joining;
  f.wx.joinVoIPChat = options => { joining = options; };
  const opening = f.controller.toggleEarphone(); await until(() => joining);
  f.disconnect(); joining.success({ openIdList: ['me'] }); await opening;
  assert.equal(f.room.joined, false);
  assert.equal(f.room.microphone, false);
  assert.equal(f.state().continuous, false);
  assert.equal(f.state().holding, false);
  assert.match(f.state().error, /连接已中断/);
  assert.ok(f.calls.filter(call => call.type === 'mute').every(call => call.options.muteConfig.muteMicrophone && call.options.muteConfig.muteEarphone));
  await f.room.destroy();
});

test('输出开启收听回调晚到退出后不能复活房间或收听状态', async () => {
  const f = fixture({ voiceSound: false }); f.room.joined = true; f.room.sessionToken = f.app.globalData.token; let enabling;
  f.wx.updateVoIPChatMuteConfig = options => {
    f.calls.push({ type: 'mute', options });
    if (!options.muteConfig.muteEarphone) enabling = options; else options.success({});
  };
  const opening = f.controller.toggleEarphone(); await until(() => enabling);
  await f.controller.stop('', true); enabling.success({}); await opening;
  assert.equal(f.room.joined, false);
  assert.equal(f.room.earphone, false);
  assert.equal(f.room.microphone, false);
  assert.ok(f.calls.filter(call => call.type === 'mute').every(call => call.options.muteConfig.muteMicrophone));
  await f.room.destroy();
});

test('取消的 silent join 迟到原生成功时从不发布正在收听状态', async () => {
  const f = fixture(); let joining;
  f.wx.joinVoIPChat = options => { joining = options; };
  const opening = f.room.join({ silent: true });
  await until(() => joining);
  assert.equal(joining.muteConfig.muteMicrophone, true);
  assert.equal(joining.muteConfig.muteEarphone, true);
  await f.room.leave();
  const afterCancellation = f.states.length;
  joining.success({ openIdList: ['me'] });
  await assert.rejects(opening, /已取消加入语音/);
  const lateStates = f.states.slice(afterCancellation);
  assert.ok(lateStates.length > 0);
  assert.ok(lateStates.every(state => state.earphone === false && state.microphone === false));
  assert.equal(f.room.joined, false);
  assert.equal(f.room.microphone, false);
  assert.equal(f.room.earphone, false);
  await f.room.destroy();
});
