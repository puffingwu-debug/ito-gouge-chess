const { getChessApp } = require('../../session');
const api = require('../../services/api');
const GameSocket = require('../../services/socket');
const { controlText, displayClock } = require('../../utils/time');
const { getPreferences, savePreferences } = require('../../utils/preferences');
const recentGame = require('../../utils/recent-game');
const { authorizePrivacy } = require('../../utils/privacy');
Page({
  data: { name: '', avatar: '', avatarRaw: '', avatarPath: '', busy: false, error: '', development: false, boardSide: 'own', saved: false, control: {}, moveSound: false, hasGame: false, game: null, gameBusy: false, gameError: '', connection: '连接中', userId: '', myColor: '', spectator: true, clock: {}, gameControl: {}, gameControlText: '', history: [], historyPlayers: {}, undoSeconds: 0, drawSeconds: 0, canRespondUndo: false, canRespondDraw: false, perspective: 'red', outcomeText: '' },
  async onLoad(options = {}) {
    this.gameId = options.gameId || '';
    this.setData({ hasGame: !!this.gameId });
    this.offset = 0;
    this.visible = false;
    this.unloaded = false;
    const preferences = getPreferences();
    this.setData({ development: getChessApp().globalData.config.development, boardSide: wx.getStorageSync('gougeBoardSide') || 'own', control: preferences.timeControl, moveSound: preferences.moveSound });
    try {
      await getChessApp().ensureLogin();
      if (this.unloaded) return;
      const token = getChessApp().globalData.token;
      const result = await api.request('/api/me');
      if (!this.currentSession(token) || !getChessApp().updateUser(result.user, token)) return;
      this.setData({ name: result.user.name, avatar: api.avatarUrl(result.user.avatar), avatarRaw: result.user.avatar || '' });
      this.loadAvatar(result.user.avatar, token);
    } catch (err) { if (!this.unloaded) this.setData({ error: api.errorText(err) }); }
  },
  onShow() {
    this.visible = true;
    if (!this.gameId) return;
    this.connectGame();
    clearInterval(this.interval);
    this.interval = setInterval(() => this.tickGame(), 250);
  },
  async connectGame() {
    const attempt = this.connectAttempt = (this.connectAttempt || 0) + 1;
    try {
      await getChessApp().ensureLogin();
      if (!this.visible || this.unloaded || attempt !== this.connectAttempt) return;
      const token = getChessApp().globalData.token;
      await this.refreshGame();
      if (!this.visible || !this.currentSession(token) || attempt !== this.connectAttempt) return;
      if (this.socket) this.socket.stop();
      this.socket = new GameSocket({ gameId: this.gameId,
        onStatus: connection => { if (this.visible && this.currentSession(token)) this.setData({ connection }); },
        onMessage: message => {
          if (!this.visible || !this.currentSession(token)) return;
          if (message.type === 'game' && message.game.id === this.gameId) this.renderGame(message.game, token);
          if (message.type === 'pong' && message.serverNow) this.offset = message.serverNow - Date.now();
        },
        onReconnect: () => { if (this.visible && this.currentSession(token)) return this.refreshGame().catch(err => { if (this.visible && this.currentSession(token)) this.setData({ gameError: api.errorText(err) }); }); }
      });
      this.socket.start();
    } catch (err) { if (this.visible) this.setData({ gameError: api.errorText(err), connection: '未连接' }); }
  },
  async refreshGame() {
    const token = getChessApp().globalData.token;
    const result = await api.request('/api/games/' + encodeURIComponent(this.gameId));
    this.renderGame(result.game, token);
  },
  currentSession(token) { return !this.unloaded && !!token && getChessApp().globalData.token === token && !!getChessApp().globalData.user; },
  renderGame(game, token = getChessApp().globalData.token) {
    if (!this.currentSession(token)) return;
    if (this.data.game && game.version < this.data.game.version) return;
    const userId = getChessApp().globalData.user.id;
    const myColor = recentGame.ownColor(game, userId);
    recentGame.remember(game, userId);
    this.offset = game.serverNow - Date.now();
    const draft = wx.getStorageSync('gougeGameControl');
    const gameControl = game.status === 'waiting' && game.ownerId === userId && !game.ready[myColor]
      ? (draft && draft.gameId === game.id && draft.userId === userId ? draft.control : getPreferences().timeControl)
      : game.timeControl;
    const flipped = wx.getStorageSync('gougeGamePerspective');
    const perspective = myColor || (flipped && flipped.gameId === game.id && flipped.userId === userId ? flipped.perspective : 'red');
    const history = (game.history || []).map((entry, index) => ({ index: index + 1,
      colorText: entry.color === 'red' ? '红' : '黑', color: entry.color,
      sourceText: { human: '手动', ai: 'AI', auto: '到时代走' }[entry.source] || entry.source,
      moveText: entry.notation || (entry.move.from + ' → ' + entry.move.to)
    })).reverse();
    const historyPlayers = game.status === 'finished' && game.resultSeats ? game.resultSeats : game.seats;
    const outcomeText = game.outcome ? (game.outcome.winner ? (game.outcome.winner === 'red' ? '红方胜' : '黑方胜') : '和棋') + ' · ' + game.outcome.reason : '';
    this.setData({ game, userId, myColor, spectator: !myColor, gameControl, gameControlText: controlText(game.timeControl), history, historyPlayers, perspective, outcomeText,
      canRespondUndo: !!myColor && !!game.undo && game.undo.requesterId !== userId,
      canRespondDraw: !!myColor && !!game.draw && game.draw.requesterId !== userId });
    this.tickGame();
    this.promptAgreement();
  },
  tickGame() {
    if (!this.visible || !this.data.game) return;
    const game = this.data.game;
    this.setData({ clock: displayClock(game, this.offset),
      undoSeconds: game.undo ? Math.max(0, Math.ceil((game.undo.expiresAt - Date.now() - this.offset) / 1000)) : 0,
      drawSeconds: game.draw ? Math.max(0, Math.ceil((game.draw.expiresAt - Date.now() - this.offset) / 1000)) : 0 });
  },
  gameControl(event) {
    const game = this.data.game;
    if (!game || game.status !== 'waiting' || game.ownerId !== this.data.userId || game.ready[this.data.myColor]) return;
    wx.setStorageSync('gougeGameControl', { gameId: game.id, userId: this.data.userId, control: event.detail.value });
    this.setData({ gameControl: event.detail.value });
  },
  async ready() {
    const game = this.data.game;
    if (!this.currentSession(getChessApp().globalData.token) || !game || this.data.gameBusy || this.data.spectator || game.status !== 'waiting' || game.ready[this.data.myColor]) return;
    this.setData({ gameBusy: true, gameError: '' });
    const token = getChessApp().globalData.token;
    try {
      const body = game.ownerId === this.data.userId ? { timeControl: this.data.gameControl } : {};
      const result = await api.request('/api/games/' + encodeURIComponent(this.gameId) + '/ready', 'POST', body);
      this.renderGame(result.game, token);
    } catch (err) { if (this.currentSession(token)) this.setData({ gameError: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ gameBusy: false }); }
  },
  async action(type, extras = {}) {
    const game = this.data.game;
    if (!this.currentSession(getChessApp().globalData.token) || !game || this.data.gameBusy || this.data.spectator || (type === 'rematch' ? game.status !== 'finished' : game.status !== 'active')) return;
    this.setData({ gameBusy: true, gameError: '' });
    const token = getChessApp().globalData.token;
    try {
      const result = await api.request('/api/games/' + encodeURIComponent(this.gameId) + '/action', 'POST', Object.assign({
        type, version: game.version, turnId: game.turnId, operationId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
      }, extras));
      this.renderGame(result.game, token);
    } catch (err) { if (this.currentSession(token)) { this.setData({ gameError: api.errorText(err) }); await this.refreshGame().catch(() => {}); } }
    finally { if (!this.unloaded) this.setData({ gameBusy: false }); }
  },
  undo() { if (this.data.game && this.data.game.history.length && !this.data.game.undo) return this.action('undo-request'); },
  undoRespond(event) { return this.respond('undo', event); },
  drawRespond(event) { return this.respond('draw', event); },
  respond(type, event) {
    const request = this.data.game && this.data.game[type];
    if (this.data.spectator || !request || request.requesterId === this.data.userId || request.expiresAt <= Date.now() + this.offset) return;
    return this.action(type + '-respond', { requestId: request.id, accept: event.currentTarget.dataset.accept === true || event.currentTarget.dataset.accept === 'true' });
  },
  draw() {
    if (this.data.spectator || !this.data.game || this.data.game.status !== 'active' || this.data.game.draw) return;
    wx.showActionSheet({ itemList: ['申请和棋', '自然限着提和'], success: result => this.action(result.tapIndex === 0 ? 'draw-request' : 'draw-claim') });
  },
  resign() {
    if (this.data.spectator || !this.data.game || this.data.game.status !== 'active') return;
    wx.showModal({ title: '认输结束这盘棋？', content: '这一步会结束当前对局。', confirmText: '认输', confirmColor: '#a8322e', success: result => { if (result.confirm) this.action('resign'); } });
  },
  rematch() { return this.action('rematch'); },
  flip() {
    if (!this.data.game || !this.data.spectator) return;
    const perspective = this.data.perspective === 'red' ? 'black' : 'red';
    wx.setStorageSync('gougeGamePerspective', { gameId: this.gameId, userId: this.data.userId, perspective });
    this.setData({ perspective });
  },
  promptAgreement() {
    if (!this.visible || this.data.spectator || !wx.showModal) return;
    const type = this.data.canRespondUndo ? 'undo' : (this.data.canRespondDraw ? 'draw' : '');
    const request = type && this.data.game[type];
    if (!request || request.expiresAt <= Date.now() + this.offset || this.lastAgreementId === request.id) return;
    this.lastAgreementId = request.id;
    wx.showModal({ title: type === 'undo' ? '对方申请悔棋' : '对方申请和棋', content: '请在 15 秒内选择，等待时棋局继续计时。', confirmText: '同意', cancelText: '拒绝', success: result => {
      const current = this.data.game && this.data.game[type];
      if (this.visible && current && current.id === request.id) this.respond(type, { currentTarget: { dataset: { accept: !!result.confirm } } });
    } });
  },
  returnGame() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const previous = pages[pages.length - 2];
    if (previous && previous.route === 'chess/pages/game/index' && previous.gameId === this.gameId) wx.navigateBack({ delta: 1 });
    else wx.redirectTo({ url: '/chess/pages/game/index?id=' + encodeURIComponent(this.gameId) });
  },
  async leaveTable() {
    const token = getChessApp().globalData.token;
    if (!this.currentSession(token) || !this.data.game || this.data.gameBusy) return;
    const game = this.data.game;
    this.setData({ gameBusy: true, gameError: '' });
    try {
      if (game.tableId && (this.data.spectator || game.status !== 'active')) await api.request('/api/tables/' + game.tableId + '/leave', 'POST', { gameId: game.id });
      if (!this.visible || !this.currentSession(token)) return;
      if (this.data.spectator || game.status !== 'active') recentGame.forget(game.id);
      wx.reLaunch({ url: '/chess/pages/index/index' });
    } catch (err) { if (this.currentSession(token)) this.setData({ gameError: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ gameBusy: false }); }
  },
  onHide() { this.visible = false; clearInterval(this.interval); if (this.socket) this.socket.stop(); },
  onUnload() { this.onHide(); this.unloaded = true; },
  avatar(event) { this.setData({ avatarPath: event.detail.avatarUrl, avatar: event.detail.avatarUrl, saved: false }); },
  loadAvatar(avatar, token) {
    if (!avatar || !avatar.startsWith('cloud://')) return;
    api.resolveAvatar(avatar).then(url => {
      if (this.currentSession(token) && this.data.avatarRaw === avatar && !this.data.avatarPath) this.setData({ avatar: url });
    }).catch(() => {});
  },
  name(event) { this.setData({ name: event.detail.value, saved: false }); },
  orientation(event) {
    const boardSide = event.detail.value ? 'red' : 'own';
    wx.setStorageSync('gougeBoardSide', boardSide);
    wx.removeStorageSync('gougeGamePerspective');
    this.setData({ boardSide });
    if (this.data.game) this.renderGame(this.data.game);
  },
  control(event) {
    savePreferences({ timeControl: event.detail.value });
    this.setData({ control: event.detail.value });
  },
  moveSound(event) {
    const moveSound = event.detail.value;
    savePreferences({ moveSound });
    this.setData({ moveSound });
  },

  privacy() {
    if (typeof wx.openPrivacyContract !== 'function') return wx.showToast({ title: '请更新微信后查看', icon: 'none' });
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时无法打开', icon: 'none' }) });
  },

  async save(event) {
    if (!this.currentSession(getChessApp().globalData.token) || this.data.busy) return;
    const name = ((event.detail.value && event.detail.value.name) || this.data.name).trim();
    if (!name) return this.setData({ error: '请填写一个昵称' });
    this.setData({ busy: true, error: '', saved: false });
    const token = getChessApp().globalData.token;
    try {
      await authorizePrivacy();
      if (!this.currentSession(token)) return;
      let avatar = this.data.avatarRaw;
      if (this.data.avatarPath) {
        const path = this.data.avatarPath;
        const base64 = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: res => resolve(res.data), fail: reject }));
        if (!this.currentSession(token)) return;
        const mime = base64.startsWith('iVBOR') ? 'image/png' : (base64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg');
        const uploaded = await api.request('/api/avatar', 'POST', { dataUrl: 'data:' + mime + ';base64,' + base64 });
        if (!this.currentSession(token)) return;
        avatar = uploaded.avatar;
      }
      const profile = { name };
      if (avatar) profile.avatar = avatar;
      const result = await api.request('/api/me', 'PATCH', profile);
      if (!this.currentSession(token) || !getChessApp().updateUser(result.user, token)) return;
      this.setData({ name: result.user.name, avatar: api.avatarUrl(result.user.avatar), avatarRaw: result.user.avatar || '', avatarPath: '', saved: true });
      this.loadAvatar(result.user.avatar, token);
      wx.showToast({ title: '资料已保存', icon: 'success' });
    } catch (err) { if (this.currentSession(token)) this.setData({ error: api.errorText(err) }); }
    finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  async logout() {
    const token = getChessApp().globalData.token;
    if (!this.currentSession(token) || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    const user = getChessApp().globalData.user;
    const recent = user && recentGame.recentFor(user.id);
    try {
      if (recent) {
        const result = await api.request('/api/games/' + encodeURIComponent(recent.gameId));
        if (!this.currentSession(token)) return;
        const game = result.game;
        if (recentGame.ownColor(game, user.id) && game.status !== 'finished') {
          const response = await new Promise(resolve => wx.showModal({
            title: '当前仍在棋桌入座',
            content: game.status === 'active' ? '请先完成这盘棋或认输，再退出账号。' + (this.data.development ? '开发账号退出后无法恢复原身份。' : '') : '请先返回棋桌离座，再退出账号。',
            confirmText: '返回棋桌', cancelText: '暂不退出',
            success: resolve, fail: () => resolve({ confirm: false })
          }));
          if (response.confirm && this.visible && this.currentSession(token)) wx.navigateTo({ url: '/chess/pages/game/index?id=' + encodeURIComponent(game.id) });
          return;
        }
        recentGame.forget(recent.gameId);
      }
      this.finishLogout();
    } catch (err) {
      if (!this.currentSession(token)) return;
      if (err.status === 403 || err.status === 404) { recentGame.forget(recent.gameId); this.finishLogout(); }
      else this.setData({ error: '未能确认当前棋局，请恢复连接后再退出：' + api.errorText(err) });
    } finally { if (!this.unloaded) this.setData({ busy: false }); }
  },
  finishLogout() {
    recentGame.forget();
    getChessApp().clearSession();
    wx.reLaunch({ url: '/chess/pages/index/index' });
  }
});
