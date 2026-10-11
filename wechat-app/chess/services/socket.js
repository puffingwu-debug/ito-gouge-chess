const { getChessApp } = require('../session');
const config = require('../config');
const { configurationError } = require('./deployment');
const { cloudClient } = require('./cloud');

class GameSocket {
  constructor(options) {
    this.options = options;
    this.stopped = true;
    this.attempt = 0;
    this.generation = 0;
  }
  start() {
    this.stop();
    this.stopped = false;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const error = configurationError(config);
    if (error) { this.stop(); this.options.onStatus(error); return; }
    const token = getChessApp().globalData.token;
    if (!token) return;
    const generation = ++this.generation;
    this.sessionToken = token;
    this.options.onStatus(this.polling ? '实时连接中断，已改为定时刷新' : '连接中');
    if (config.transport === 'cloud') {
      try {
        cloudClient('connectContainer').connectContainer({ config: { env: config.cloudEnv }, service: config.cloudService,
          path: '/ws?token=' + encodeURIComponent(token), timeout: 20000
        }).then(result => this.attach(result.socketTask, generation, token), () => this.reconnect(null, generation));
      } catch (err) { this.reconnect(null, generation); }
      return;
    }
    const url = config.apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?token=' + encodeURIComponent(token);
    const socket = wx.connectSocket({ url, fail: () => this.reconnect(null, generation) });
    this.attach(socket, generation, token);
  }
  attach(socket, generation, token) {
    if (this.stopped || generation !== this.generation || token !== getChessApp().globalData.token) {
      socket.close({});
      if (!this.stopped && generation === this.generation) this.stop();
      return;
    }
    this.socket = socket;
    socket.onOpen(() => {
      if (!this.current(socket, generation)) return;
      this.stopPolling();
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.options.onStatus('已连接');
      if (this.options.gameId) this.send({ type: 'subscribe', gameId: this.options.gameId });
      this.send({ type: 'ping' });
      this.heartbeat = setInterval(() => {
        if (!this.current(socket, generation)) return;
        if (Date.now() - this.lastMessageAt > 30000) return this.reconnect(socket, generation);
        this.send({ type: 'ping' });
      }, 10000);
      if (config.transport === 'cloud') this.refreshHttp();
      else if (this.options.onReconnect) this.options.onReconnect();
    });
    socket.onMessage(event => {
      if (!this.current(socket, generation)) return;
      this.lastMessageAt = Date.now();
      try { this.options.onMessage(JSON.parse(event.data)); } catch (_) { /* Ignore non-JSON transport frames. */ }
    });
    socket.onClose(() => this.reconnect(socket, generation));
    socket.onError(() => this.reconnect(socket, generation));
  }
  current(socket, generation) {
    if (this.stopped || socket !== this.socket || generation !== this.generation) return false;
    if (this.sessionToken !== getChessApp().globalData.token) { this.stop(); return false; }
    return true;
  }
  send(message) {
    if (this.socket && this.current(this.socket, this.generation)) this.socket.send({ data: JSON.stringify(message), fail() {} });
  }
  refreshHttp() {
    if (this.refreshPending) return this.refreshPending;
    if (!this.options.onReconnect || this.stopped || this.sessionToken !== getChessApp().globalData.token) return Promise.resolve();
    let request;
    try { request = Promise.resolve(this.options.onReconnect()); } catch (err) { request = Promise.reject(err); }
    this.refreshPending = request.catch(() => {}).then(() => { this.refreshPending = null; });
    return this.refreshPending;
  }
  startPolling() {
    if (config.transport !== 'cloud' || !this.options.onReconnect || this.polling || this.stopped) return;
    this.polling = true;
    const epoch = this.pollEpoch = (this.pollEpoch || 0) + 1, token = this.sessionToken;
    this.options.onStatus('实时连接中断，已改为定时刷新');
    const poll = async () => {
      this.pollTimer = null;
      if (!this.polling || this.stopped || epoch !== this.pollEpoch) return;
      if (token !== getChessApp().globalData.token) { this.stop(); return; }
      await this.refreshHttp();
      if (!this.polling || this.stopped || epoch !== this.pollEpoch) return;
      if (token !== getChessApp().globalData.token) { this.stop(); return; }
      this.pollTimer = setTimeout(poll, 2500);
    };
    poll();
  }
  stopPolling() {
    this.polling = false;
    this.pollEpoch = (this.pollEpoch || 0) + 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  reconnect(socket, generation = this.generation) {
    if (this.stopped || generation !== this.generation || (socket && socket !== this.socket) || this.retry) return;
    if (this.sessionToken !== getChessApp().globalData.token) { this.stop(); return; }
    clearInterval(this.heartbeat);
    this.options.onStatus('连接中断，正在重连');
    this.startPolling();
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.sessionToken !== getChessApp().globalData.token) { this.stop(); return; }
      const previous = this.socket;
      this.socket = null;
      if (previous) previous.close({});
      this.connect();
    }, Math.min(1000 * Math.pow(2, this.attempt++), 10000));
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.stopPolling();
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.retry = null;
    if (this.socket) this.socket.close({});
    this.socket = null;
  }
}
module.exports = GameSocket;
