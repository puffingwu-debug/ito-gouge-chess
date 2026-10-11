const api = require('../../services/api');
const { defaultControl } = require('../../utils/time');
const { getPreferences } = require('../../utils/preferences');
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
  difficulty(event) { this.setData({ difficulty: Number(event.currentTarget.dataset.id) }); },
  color(event) { this.setData({ humanColor: event.currentTarget.dataset.color }); },
  control(event) { this.setData({ control: event.detail.value }); },
  async start() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const user = await getApp().ensureLogin();
      const result = await api.request('/api/ai', 'POST', {
        difficulty: this.data.difficulty, humanColor: this.data.humanColor, timeControl: this.data.control
      });
      wx.setStorageSync('gougeLastGame', { gameId: result.gameId, userId: user.id });
      wx.redirectTo({ url: '/pages/game/index?id=' + encodeURIComponent(result.gameId) });
    } catch (err) { this.setData({ error: api.errorText(err) }); }
    finally { this.setData({ busy: false }); }
  }
});
