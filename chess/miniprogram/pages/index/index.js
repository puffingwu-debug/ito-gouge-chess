const api = require('../../services/api');
const recentGame = require('../../utils/recent-game');
Page({
  data: { user: null, development: false, busy: false, error: '', recentGame: null, recentError: '' },
  async onShow() {
    const app = getApp();
    this.setData({ user: app.globalData.user, development: app.globalData.config.development, recentGame: null, recentError: '' });
    await this.refreshRecent();
  },
  async refreshRecent() {
    const app = getApp();
    if (!app.globalData.user || !app.globalData.token) return;
    const userId = app.globalData.user.id;
    const recent = recentGame.recentFor(userId);
    if (!recent) return;
    try {
      const result = await api.request('/api/games/' + encodeURIComponent(recent.gameId));
      if (!app.globalData.user || app.globalData.user.id !== userId) return;
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
      if (err.status === 403 || err.status === 404) {
        recentGame.forget(recent.gameId);
        this.setData({ recentGame: null, recentError: '' });
      }
      else this.setData({ recentError: '未能读取上次对局：' + api.errorText(err) });
    }
  },
  continueGame() {
    if (this.data.recentGame) wx.navigateTo({ url: '/pages/game/index?id=' + encodeURIComponent(this.data.recentGame.gameId) });
  },
  async login() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      this.setData({ user: await getApp().login() });
      await this.refreshRecent();
    }
    catch (err) { this.setData({ error: api.errorText(err) }); }
    finally { this.setData({ busy: false }); }
  },
  async navigate(event) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const user = await getApp().ensureLogin();
      this.setData({ user });
      wx.navigateTo({ url: '/pages/' + event.currentTarget.dataset.page + '/index' });
    } catch (err) { this.setData({ error: api.errorText(err) }); }
    finally { this.setData({ busy: false }); }
  }
});
