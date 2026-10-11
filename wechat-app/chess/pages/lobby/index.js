const { getChessApp } = require('../../session');
const api = require('../../services/api');
const GameSocket = require('../../services/socket');
const recentGame = require('../../utils/recent-game');
const statusNames = { empty: '等家人入座', waiting: '等待开始', active: '正在对弈', finished: '已结束' };
Page({
  data: { tables: [], error: '', busy: false, connection: '连接中' },
  onShow() { this.hidden = false; this.open(); },
  currentOperation(lifecycle, token) { return !this.hidden && !this.unloaded && lifecycle === (this.lifecycle || 0) && !!token && token === getChessApp().globalData.token; },
  async open() {
    const lifecycle = this.lifecycle || 0;
    this.setData({ error: '' });
    try {
      await getChessApp().ensureLogin();
      const token = getChessApp().globalData.token;
      if (!this.currentOperation(lifecycle, token)) return;
      await this.refresh();
      if (!this.currentOperation(lifecycle, token)) return;
      if (this.socket) this.socket.stop();
      this.socket = new GameSocket({
        onStatus: connection => { if (this.currentOperation(lifecycle, token)) this.setData({ connection }); },
        onMessage: message => { if (this.currentOperation(lifecycle, token) && message.type === 'lobby') this.renderTables(message.tables); },
        onReconnect: () => { if (this.currentOperation(lifecycle, token)) return this.refresh().catch(err => { if (this.currentOperation(lifecycle, token)) this.setData({ error: api.errorText(err) }); }); }
      });
      this.socket.start();
    } catch (err) { if (!this.hidden && !this.unloaded && lifecycle === (this.lifecycle || 0)) this.setData({ error: api.errorText(err), connection: '未连接' }); }
  },
  renderTables(tables) {
    this.setData({ tables: tables.map(table => Object.assign({}, table, { statusText: statusNames[table.status] || table.status })) });
  },
  async refresh() {
    const token = getChessApp().globalData.token, lifecycle = this.lifecycle || 0;
    const result = await api.request('/api/lobby');
    if (this.currentOperation(lifecycle, token)) this.renderTables(result.tables);
  },
  async onPullDownRefresh() {
    try { await this.refresh(); } catch (err) { this.setData({ error: api.errorText(err) }); }
    wx.stopPullDownRefresh();
  },
  async table(event) {
    if (this.data.busy || this.hidden || this.unloaded) return;
    const token = getChessApp().globalData.token, lifecycle = this.lifecycle || 0;
    const user = getChessApp().globalData.user;
    if (!token || !user) return;
    const { id, action, color } = event.currentTarget.dataset;
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.request('/api/tables/' + id + '/' + action, 'POST', action === 'join' && color ? { color } : {});
      if (action === 'join' && !await recentGame.rememberCreated(result.gameId, user.id, token)) return;
      if (!this.currentOperation(lifecycle, token)) return;
      wx.navigateTo({ url: '/chess/pages/game/index?id=' + encodeURIComponent(result.gameId) });
    } catch (err) { if (this.currentOperation(lifecycle, token)) this.setData({ error: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  onHide() { this.hidden = true; this.lifecycle = (this.lifecycle || 0) + 1; if (this.socket) this.socket.stop(); },
  onUnload() { this.onHide(); this.unloaded = true; }
});
