const config = require('../config');

class GameSocket {
  constructor(options) {
    this.options = options;
    this.stopped = true;
    this.attempt = 0;
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    const token = getApp().globalData.token;
    if (!token) return;
    this.options.onStatus('连接中');
    const url = config.apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?token=' + encodeURIComponent(token);
    const socket = wx.connectSocket({ url, fail: () => this.reconnect(socket) });
    this.socket = socket;
    socket.onOpen(() => {
      if (socket !== this.socket || this.stopped) return;
      this.attempt = 0;
      this.options.onStatus('已连接');
      if (this.options.gameId) this.send({ type: 'subscribe', gameId: this.options.gameId });
      this.send({ type: 'ping' });
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 10000);
      if (this.options.onReconnect) this.options.onReconnect();
    });
    socket.onMessage(event => {
      if (socket !== this.socket || this.stopped) return;
      try { this.options.onMessage(JSON.parse(event.data)); } catch (_) { /* Ignore non-JSON transport frames. */ }
    });
    socket.onClose(() => this.reconnect(socket));
    socket.onError(() => this.reconnect(socket));
  }
  send(message) {
    if (this.socket) this.socket.send({ data: JSON.stringify(message), fail() {} });
  }
  reconnect(socket) {
    if (this.stopped || socket !== this.socket || this.retry) return;
    clearInterval(this.heartbeat);
    this.options.onStatus('连接中断，正在重连');
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.socket) this.socket.close({});
      this.socket = null;
      this.connect();
    }, Math.min(1000 * Math.pow(2, this.attempt++), 10000));
  }
  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.retry = null;
    if (this.socket) this.socket.close({});
    this.socket = null;
  }
}
module.exports = GameSocket;
