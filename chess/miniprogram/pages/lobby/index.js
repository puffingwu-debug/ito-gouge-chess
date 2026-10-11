const api = require('../../services/api');
const GameSocket = require('../../services/socket');
const statusNames = { empty: '等家人入座', waiting: '等待开始', active: '正在对弈', finished: '已结束' };
Page({
  data: { tables: [], error: '', busy: false, connection: '连接中' },
  onShow() { this.open(); },
  async open() {
    this.setData({ error: '' });
    try {
      await getApp().ensureLogin();
      await this.refresh();
      if (this.socket) this.socket.stop();
      this.socket = new GameSocket({
        onStatus: connection => this.setData({ connection }),
        onMessage: message => { if (message.type === 'lobby') this.renderTables(message.tables); },
        onReconnect: () => this.refresh().catch(err => this.setData({ error: api.errorText(err) }))
      });
      this.socket.start();
    } catch (err) { this.setData({ error: api.errorText(err), connection: '未连接' }); }
  },
  renderTables(tables) {
    this.setData({ tables: tables.map(table => Object.assign({}, table, { statusText: statusNames[table.status] || table.status })) });
  },
  async refresh() {
    const result = await api.request('/api/lobby');
    this.renderTables(result.tables);
  },
  async onPullDownRefresh() {
    try { await this.refresh(); } catch (err) { this.setData({ error: api.errorText(err) }); }
    wx.stopPullDownRefresh();
  },
  async table(event) {
    if (this.data.busy) return;
    const { id, action, color } = event.currentTarget.dataset;
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.request('/api/tables/' + id + '/' + action, 'POST', action === 'join' && color ? { color } : {});
      if (action === 'join') wx.setStorageSync('gougeLastGame', { gameId: result.gameId, userId: getApp().globalData.user.id });
      wx.navigateTo({ url: '/pages/game/index?id=' + encodeURIComponent(result.gameId) });
    } catch (err) { this.setData({ error: api.errorText(err) }); }
    finally { this.setData({ busy: false }); }
  },
  onHide() { if (this.socket) this.socket.stop(); },
  onUnload() { if (this.socket) this.socket.stop(); }
});
