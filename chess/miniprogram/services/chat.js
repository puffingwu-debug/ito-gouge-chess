const config = require('../config');
const api = require('./api');

class ChatRoom {
  constructor(gameId, callbacks) {
    this.gameId = gameId;
    this.callbacks = callbacks || {};
    this.generation = 0;
    this.active = false;
    this.seq = -1;
    this.messages = [];
    this.ready = false;
    this.busy = false;
    this.error = '';
    this.sendError = '';
    this.emitted = new Set();
  }
  state() {
    if (this.callbacks.onState) this.callbacks.onState({ messages: this.messages.slice(), ready: this.ready, busy: this.busy, error: this.error });
  }
  current(generation) {
    const app = getApp();
    return this.active && generation === this.generation && this.token === app.globalData.token && this.userId === (app.globalData.user && app.globalData.user.id);
  }
  start() {
    const app = getApp(), user = app.globalData.user;
    if (!user || !app.globalData.token) return;
    if (this.active && this.token === app.globalData.token && this.userId === user.id) return;
    const sameIdentity = this.token === app.globalData.token && this.userId === user.id;
    this.stop();
    this.active = true;
    this.token = app.globalData.token;
    this.userId = user.id;
    this.seq = -1;
    this.messages = [];
    this.ready = false;
    this.error = sameIdentity ? this.sendError : '';
    if (!sameIdentity) { this.attempt = null; this.sendError = ''; this.emitted.clear(); }
    this.state();
    this.poll(this.generation);
  }
  async poll(generation) {
    await this.refresh().catch(() => {});
    if (this.current(generation)) this.timer = setTimeout(() => this.poll(generation), 3000);
  }
  stop() {
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    this.pending = null;
    this.busy = false;
  }
  async request(operation, payload) {
    const data = Object.assign({ operation, gameId: this.gameId, userIdHint: this.userId }, payload);
    if (config.transport !== 'cloud') return api.request('/api/games/' + encodeURIComponent(this.gameId) + '/chat', operation === 'list' ? 'GET' : 'POST', operation === 'list' ? undefined : data, true, this.token);
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') throw new Error('当前微信版本不支持同桌聊天，请升级微信后重试');
    wx.cloud.init({ env: config.cloudEnv });
    const response = await wx.cloud.callFunction({ name: config.chatFunction || 'gouge-chess-chat', config: { env: config.cloudEnv }, data });
    const result = response.result;
    if (!result || result.ok === false || result.error) {
      const error = new Error(result && result.error || '聊天服务未返回消息，请重试');
      error.code = result && result.code;
      throw error;
    }
    return result;
  }
  receive(result, sent) {
    if (!result || result.gameId !== this.gameId || !Number.isInteger(result.seq) || result.seq < 0 || !Array.isArray(result.messages)) throw new Error('聊天消息读取失败，请重试');
    const additions = [];
    if (result.seq >= this.seq) {
      const previousSeq = this.seq, messages = result.messages.slice(-50);
      if (previousSeq >= 0) additions.push(...messages.filter(item => item.seq > previousSeq));
      this.seq = result.seq;
      this.messages = messages;
      this.ready = true;
      this.error = this.sendError;
      this.state();
    }
    if (sent && result.message && result.message.userId === this.userId) additions.push(result.message);
    const fresh = additions.filter(message => {
      if (this.emitted.has(message.seq)) return false;
      this.emitted.add(message.seq);
      return true;
    });
    if (fresh.length && this.callbacks.onNew) this.callbacks.onNew(fresh);
  }
  async refresh() {
    if (!this.active) return;
    const generation = this.generation;
    if (this.pending && this.pending.generation === generation) return this.pending.promise;
    const record = { generation };
    this.pending = record;
    record.promise = this.request('list').then(result => {
      if (this.current(generation)) this.receive(result, false);
    }).catch(error => {
      if (this.current(generation)) { this.error = this.sendError || api.errorText(error); this.state(); }
      throw error;
    }).finally(() => { if (this.pending === record) this.pending = null; });
    return record.promise;
  }
  async send(payload) {
    const generation = this.generation;
    if (!this.current(generation)) throw new Error('请先进入当前棋桌');
    if (this.busy) return false;
    const key = JSON.stringify(payload);
    if (!this.attempt || this.attempt.key !== key) this.attempt = { key, reqId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
    const attempt = this.attempt;
    this.busy = true;
    this.sendError = '';
    this.error = '';
    this.state();
    try {
      const result = await this.request('send', Object.assign({}, payload, { reqId: attempt.reqId }));
      if (!this.current(generation)) return false;
      this.sendError = '';
      this.error = '';
      this.receive(result, true);
      this.attempt = null;
      return true;
    } catch (error) {
      if (this.current(generation)) { this.sendError = api.errorText(error); this.error = this.sendError; this.state(); }
      throw error;
    } finally {
      if (this.current(generation)) { this.busy = false; this.state(); }
    }
  }
}
module.exports = ChatRoom;
