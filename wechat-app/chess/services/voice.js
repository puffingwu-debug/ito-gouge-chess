const { getChessApp } = require('../session');
const api = require('./api');
const { getPreferences } = require('../utils/preferences');

function invoke(name, options = {}) {
  return new Promise((resolve, reject) => wx[name](Object.assign({}, options, { success: resolve, fail: reject })));
}
class VoiceRoom {
  constructor(gameId, onChange) {
    this.gameId = gameId;
    this.onChange = onChange;
    this.joined = false;
    this.microphone = false;
    this.earphone = getPreferences().voiceSound;
    this.generation = 0;
    this.muteSequence = 0;
    this.requestedMicrophone = false;
    this.members = res => this.emit({ count: (res.openIdList || []).length });
    this.interrupted = res => {
      this.generation++;
      this.muteSequence++;
      this.requestedMicrophone = false;
      this.joined = false;
      this.microphone = false;
      this.emit({ interrupted: true, error: '语音已中断：' + (res.errMsg || '请重新加入') });
      if (this.sessionToken) api.request('/api/voice/leave', 'POST', { gameId: this.gameId }, true, this.sessionToken).catch(() => {});
    };
    if (wx.onVoIPChatMembersChanged) wx.onVoIPChatMembersChanged(this.members);
    if (wx.onVoIPChatInterrupted) wx.onVoIPChatInterrupted(this.interrupted);
  }
  emit(extra = {}) {
    this.onChange(Object.assign({ joined: this.joined, microphone: this.microphone, earphone: this.earphone }, extra));
  }
  async join(options = {}) {
    if (this.joined) {
      if (this.sessionToken !== getChessApp().globalData.token) throw new Error('语音身份已改变，请重新加入');
      return;
    }
    if (this.joinTask) return this.joinTask;
    const task = this.performJoin(options);
    this.joinTask = task;
    try { return await task; }
    finally { if (this.joinTask === task) this.joinTask = null; }
  }
  async performJoin(options = {}) {
    if (!wx.joinVoIPChat) throw new Error('当前微信版本不支持多人语音，请更新微信');
    if (getChessApp().globalData.config.development) throw new Error('开发账号不能加入微信语音。请使用真实 AppID 与微信登录');
    const generation = ++this.generation;
    const token = this.sessionToken = getChessApp().globalData.token;
    if (this.leaveTask) await this.leaveTask;
    if (generation !== this.generation || token !== getChessApp().globalData.token) throw new Error('已取消加入语音');
    const earphone = options.silent ? false : getPreferences().voiceSound;
    await invoke('authorize', { scope: 'scope.record' });
    if (generation !== this.generation || token !== getChessApp().globalData.token) throw new Error('已取消加入语音');
    const sign = await api.request('/api/voice/sign', 'POST', { gameId: this.gameId }, true, token);
    try {
      if (generation !== this.generation || token !== getChessApp().globalData.token) throw new Error('已取消加入语音');
      const result = await invoke('joinVoIPChat', {
        roomType: 'voice', signature: sign.signature, nonceStr: sign.nonceStr,
        timeStamp: Number(sign.timeStamp), groupId: sign.groupId,
        muteConfig: { muteMicrophone: true, muteEarphone: !earphone }
      });
      this.earphone = earphone;
      if (generation !== this.generation || token !== getChessApp().globalData.token) {
        this.joined = true;
        this.microphone = false;
        this.emit();
        await invoke('exitVoIPChat');
        this.joined = false;
        this.emit({ count: 0 });
        throw new Error('已取消加入语音');
      }
      this.joined = true;
      this.microphone = false;
      this.emit({ error: '', count: (result.openIdList || []).length });
    } catch (err) {
      await api.request('/api/voice/leave', 'POST', { gameId: this.gameId }, true, token).catch(() => {});
      throw new Error('微信多人语音加入失败：' + (err.errMsg || err.message || '') + (err.errCode === undefined ? '' : '（' + err.errCode + '）'));
    }
  }
  async heartbeat() {
    if (!this.joined || !this.sessionToken || this.sessionToken !== getChessApp().globalData.token) throw new Error('语音会话已改变，请重新加入');
    if (this.heartbeatTask) return this.heartbeatTask;
    const generation = this.generation, token = this.sessionToken;
    const task = api.request('/api/voice/heartbeat', 'POST', { gameId: this.gameId }, true, token).then(result => {
      if (generation !== this.generation || !this.joined || token !== getChessApp().globalData.token) return null;
      if (!Number.isFinite(result.serverNow) || !Number.isFinite(result.expiresAt) || result.expiresAt <= result.serverNow) throw new Error('语音续期响应无效，请重新加入');
      return result;
    });
    this.heartbeatTask = task;
    try { return await task; } finally { if (this.heartbeatTask === task) this.heartbeatTask = null; }
  }
  async mute(microphone, earphone) {
    if (!this.joined) return;
    const token = this.sessionToken;
    if ((microphone || earphone) && token !== getChessApp().globalData.token) throw new Error('语音身份已改变，请重新加入');
    const generation = this.generation;
    const sequence = ++this.muteSequence;
    this.requestedMicrophone = microphone;
    this.requestedEarphone = earphone;
    await invoke('updateVoIPChatMuteConfig', { muteConfig: { muteMicrophone: !microphone, muteEarphone: !earphone } });
    if ((microphone || earphone) && token !== getChessApp().globalData.token) {
      await invoke('updateVoIPChatMuteConfig', { muteConfig: { muteMicrophone: true, muteEarphone: true } });
      throw new Error('语音身份已改变，请重新加入');
    }
    if (generation !== this.generation || !this.joined) {
      if (microphone && this.joined && !this.requestedMicrophone) await invoke('updateVoIPChatMuteConfig', { muteConfig: { muteMicrophone: true, muteEarphone: !this.earphone } });
      return;
    }
    if (sequence !== this.muteSequence) {
      if (microphone && !this.requestedMicrophone) {
        await invoke('updateVoIPChatMuteConfig', { muteConfig: { muteMicrophone: true, muteEarphone: !this.requestedEarphone } });
      }
      return;
    }
    this.microphone = microphone;
    this.earphone = earphone;
    this.emit({ error: '' });
  }
  async leave() {
    this.generation++;
    this.muteSequence++;
    this.requestedMicrophone = false;
    if (this.leaveTask) return this.leaveTask;
    this.leaveTask = this.performLeave();
    try { return await this.leaveTask; }
    finally { this.leaveTask = null; }
  }
  async performLeave() {
    let muteError;
    const token = this.sessionToken;
    try {
      if (this.joined) {
        invoke('updateVoIPChatMuteConfig', { muteConfig: { muteMicrophone: true, muteEarphone: !this.earphone } }).catch(err => { muteError = err; });
        try { await invoke('exitVoIPChat'); }
        catch (err) { throw new Error('未能确认退出语音：' + (err.errMsg || err.message || '') + (muteError ? '；关闭麦克风也失败' : '')); }
      }
      this.joined = false;
      this.microphone = false;
      this.emit({ count: 0 });
    } finally {
      if (token) await api.request('/api/voice/leave', 'POST', { gameId: this.gameId }, true, token).catch(() => {});
    }
  }
  destroy() {
    if (wx.offVoIPChatMembersChanged) wx.offVoIPChatMembersChanged(this.members);
    if (wx.offVoIPChatInterrupted) wx.offVoIPChatInterrupted(this.interrupted);
    return this.leave();
  }
}
module.exports = VoiceRoom;
