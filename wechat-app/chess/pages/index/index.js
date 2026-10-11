const { getChessApp } = require('../../session');
const api = require('../../services/api');
const recentGame = require('../../utils/recent-game');
const { configurationError } = require('../../services/deployment');
Page({
  returnTools() { wx.reLaunch({ url: '/pages/index/index' }); },
  data: { user: null, development: false, busy: false, error: '', recentGame: null, recentError: '' },
  async onShow() {
    this.hidden = false;
    const app = getChessApp();
    const error = configurationError(app.globalData.config);
    this.setData({ user: api.userView(app.globalData.user), development: app.globalData.config.development, error, recentGame: null, recentError: '' });
    if (error) return;
    this.loadAvatar();
    await this.refreshRecent();
  },
  async refreshRecent() {
    const app = getChessApp();
    if (!app.globalData.user || !app.globalData.token) return;
    const userId = app.globalData.user.id;
    const token = app.globalData.token, lifecycle = this.lifecycle || 0;
    const recent = recentGame.recentFor(userId);
    if (!recent) return;
    try {
      const result = await api.request('/api/games/' + encodeURIComponent(recent.gameId));
      if (!this.currentOperation(lifecycle) || app.globalData.token !== token || !app.globalData.user || app.globalData.user.id !== userId) return;
      const game = result.game;
      if (game.status === 'finished' || !recentGame.ownColor(game, userId)) {
        recentGame.forget(recent.gameId);
        this.setData({ recentGame: null });
        return;
      }
      this.setData({ recentGame: {
        gameId: game.id, label: game.mode === 'ai' ? 'AI 对战' : '第 ' + game.tableId + ' 桌',
        statusText: game.status === 'active' ? '对局仍在计时' : '等待开局确认'
      }, recentError: '' });
    } catch (err) {
      if (!this.currentOperation(lifecycle) || app.globalData.token !== token) return;
      if (err.status === 403 || err.status === 404) {
        recentGame.forget(recent.gameId);
        this.setData({ recentGame: null, recentError: '' });
      }
      else this.setData({ recentError: '未能读取上次对局：' + api.errorText(err) });
    }
  },
  continueGame() {
    if (this.data.recentGame) wx.navigateTo({ url: '/chess/pages/game/index?id=' + encodeURIComponent(this.data.recentGame.gameId) });
  },
  loadAvatar() {
    const user = this.data.user, app = getChessApp(), token = app.globalData.token, lifecycle = this.lifecycle || 0;
    if (!user || !user.avatar || !user.avatar.startsWith('cloud://')) return;
    api.resolveAvatar(user.avatar).then(url => {
      if (this.currentOperation(lifecycle) && app.globalData.token === token && this.data.user && this.data.user.id === user.id && this.data.user.avatar === user.avatar) {
        this.setData({ user: Object.assign({}, this.data.user, { avatarUrl: url }) });
      }
    }).catch(() => {});
  },
  async login() {
    if (this.data.busy || this.hidden || this.unloaded) return;
    const lifecycle = this.lifecycle || 0;
    this.setData({ busy: true, error: '' });
    try {
      const user = await getChessApp().login();
      if (!this.currentOperation(lifecycle)) return;
      this.setData({ user });
      this.loadAvatar();
      await this.refreshRecent();
    }
    catch (err) { if (this.currentOperation(lifecycle)) this.setData({ error: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  async navigate(event) {
    if (this.data.busy || this.hidden || this.unloaded) return;
    const lifecycle = this.lifecycle || 0;
    this.setData({ busy: true, error: '' });
    try {
      const user = await getChessApp().ensureLogin();
      if (!this.currentOperation(lifecycle)) return;
      this.setData({ user });
      wx.navigateTo({ url: '/chess/pages/' + event.currentTarget.dataset.page + '/index' });
    } catch (err) { if (this.currentOperation(lifecycle)) this.setData({ error: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  currentOperation(lifecycle) { return !this.hidden && !this.unloaded && lifecycle === (this.lifecycle || 0); },
  onHide() { this.hidden = true; this.lifecycle = (this.lifecycle || 0) + 1; },
  onUnload() { this.onHide(); this.unloaded = true; }
});
