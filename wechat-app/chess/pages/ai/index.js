const { getChessApp } = require('../../session');
const api = require('../../services/api');
const { defaultControl } = require('../../utils/time');
const { getPreferences } = require('../../utils/preferences');
const recentGame = require('../../utils/recent-game');
Page({
  data: {
    difficulty: 2, humanColor: 'red', control: Object.assign({}, defaultControl), busy: false, error: '',
    difficulties: [
      { id: 1, name: '初学', detail: '熟悉棋子走法' }, { id: 2, name: '入门', detail: '练习布局与攻守' },
      { id: 3, name: '熟练', detail: '多想几步' }, { id: 4, name: '高手', detail: '寻找局面的机会' },
      { id: 5, name: '挑战', detail: '更强的计算对手' }
    ]
  },
  onLoad() { this.setData({ control: getPreferences().timeControl }); },
  onShow() { this.hidden = false; },
  onHide() { this.hidden = true; this.lifecycle = (this.lifecycle || 0) + 1; },
  onUnload() { this.onHide(); this.unloaded = true; },
  difficulty(event) { this.setData({ difficulty: Number(event.currentTarget.dataset.id) }); },
  color(event) { this.setData({ humanColor: event.currentTarget.dataset.color }); },
  control(event) { this.setData({ control: event.detail.value }); },
  async start() {
    if (this.data.busy || this.hidden || this.unloaded) return;
    const lifecycle = this.lifecycle || 0;
    this.setData({ busy: true, error: '' });
    try {
      const user = await getChessApp().ensureLogin();
      if (this.hidden || this.unloaded || lifecycle !== (this.lifecycle || 0)) return;
      const token = getChessApp().globalData.token;
      const result = await api.request('/api/ai', 'POST', {
        difficulty: this.data.difficulty, humanColor: this.data.humanColor, timeControl: this.data.control
      });
      const remembered = await recentGame.rememberCreated(result.gameId, user.id, token);
      if (!remembered || this.hidden || this.unloaded || lifecycle !== (this.lifecycle || 0) || token !== getChessApp().globalData.token) return;
      wx.redirectTo({ url: '/chess/pages/game/index?id=' + encodeURIComponent(result.gameId) });
    } catch (err) { if (!this.hidden && !this.unloaded && lifecycle === (this.lifecycle || 0)) this.setData({ error: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  }
});
