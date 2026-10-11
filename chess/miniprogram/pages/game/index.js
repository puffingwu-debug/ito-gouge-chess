const api = require('../../services/api');
const GameSocket = require('../../services/socket');
const ChatRoom = require('../../services/chat');
const { boardCells } = require('../../utils/board');
const { defaultControl, displayClock } = require('../../utils/time');
const { getPreferences } = require('../../utils/preferences');
const recentGame = require('../../utils/recent-game');
const { confirmedMove, sameBoard, displayPoint, queryGeometry } = require('../../utils/chess-motion');

function operationId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
Page({
  data: {
    game: null, cells: [], selected: -1, perspective: 'red', myColor: '', userId: '', spectator: true,
    connection: '连接中', error: '', soundError: '', busy: false, clock: {}, control: Object.assign({}, defaultControl),
    statusText: '', undoSeconds: 0, canRespondUndo: false,
    drawSeconds: 0, canRespondDraw: false,
    horizontal: Array.from({ length: 10 }, (_, n) => n * 100 / 9),
    vertical: Array.from({ length: 9 }, (_, n) => n * 12.5),
    chatMessages: [], chatEnabled: false, chatReady: false, chatBusy: false, chatError: '',
    chatOpen: false, chatDraft: '', chatUnread: 0, chatScrollTo: '', reactionOpen: false, subtitle: null,
    reactions: [{ id: 'handshake', emoji: '🤝', label: '握手' }, { id: 'thumbsup', emoji: '👍', label: '点赞' },
      { id: 'badmove', emoji: '🙈', label: '臭棋' }, { id: 'cry', emoji: '😭', label: '哭鼻子' },
      { id: 'laugh', emoji: '😂', label: '哈哈大笑' }, { id: 'whiteflag', emoji: '🏳️', label: '白旗' }],
    topPlayer: null, bottomPlayer: null, topColor: 'black', bottomColor: 'red',
    motion: null, layout: { frameWidth: 366, frameHeight: 405, gridWidth: 313, gridHeight: 352, padding: 26, pointSize: 39, pieceSize: 34, pieceFont: 23, safeBottom: 34 }
  },
  onLoad(options) {
    this.gameId = options.id;
    this.configureLayout();
    this.offset = 0;
    this.visible = false;
    this.unloaded = false;
    this.motionTimers = [];
    this.motionQueue = [];
    this.motionGeneration = 0;
    this.animationPrimed = false;
    this.subtitleQueue = [];
    this.subtitleGeneration = 0;
    this.chatRoom = new ChatRoom(this.gameId, {
      onState: state => this.applyChatState(state), onNew: messages => this.receiveChat(messages)
    });
  },
  onShow() {
    this.visible = true;
    this.animationPrimed = false;
    this.syncChat();
    this.allowMoveSound = false;
    this.setupAudio();
    this.connect();
    clearInterval(this.interval);
    this.interval = setInterval(() => this.tick(), 250);
  },
  configureLayout() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    const width = info.windowWidth || 390, height = info.windowHeight || 753;
    const safeBottom = info.screenHeight && info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 34;
    const waiting = this.data.game && this.data.game.status === 'waiting' && !this.data.spectator;
    const frameWidth = Math.floor(Math.max(244, Math.min(width - 24, (height - 316 - safeBottom - (waiting ? 48 : 0)) * 702 / 777)));
    const gridWidth = frameWidth * 600 / 702;
    this.setData({ layout: { frameWidth, frameHeight: frameWidth * 777 / 702, gridWidth, gridHeight: frameWidth * 675 / 702,
      padding: frameWidth * 51 / 702, pointSize: Math.max(34, gridWidth / 8), pieceSize: gridWidth / 8 * .88,
      pieceFont: gridWidth / 8 * .6, safeBottom } });
  },
  onResize() { this.cancelMotion(); this.configureLayout(); },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index?gameId=' + encodeURIComponent(this.gameId) }); },
  promptAgreement() {
    const game = this.data.game;
    if (!this.visible || this.data.spectator || !game || !wx.showModal) return;
    const type = this.data.canRespondUndo ? 'undo' : (this.data.canRespondDraw ? 'draw' : '');
    const request = type && game[type];
    if (!request || request.expiresAt <= Date.now() + this.offset || this.lastAgreementId === request.id) return;
    this.lastAgreementId = request.id;
    wx.showModal({ title: type === 'undo' ? '对方申请悔棋' : '对方申请和棋', content: '请在 15 秒内选择，等待时棋局继续计时。',
      confirmText: '同意', cancelText: '拒绝', success: result => {
        const current = this.data.game && this.data.game[type];
        if (this.visible && current && current.id === request.id && current.expiresAt > Date.now() + this.offset && !this.data.spectator) {
          this.action(type + '-respond', { requestId: current.id, accept: !!result.confirm });
        }
      } });
  },
  async connect() {
    this.setData({ error: '' });
    try {
      await getApp().ensureLogin();
      const token = getApp().globalData.token;
      await this.refresh();
      this.allowMoveSound = true;
      if (!this.visible) return;
      if (this.socket) this.socket.stop();
      this.socket = new GameSocket({
        gameId: this.gameId,
        onStatus: connection => {
          if (this.visible) this.setData({ connection });
          if (connection === '连接中断，正在重连') { this.cancelMotion(); this.animationPrimed = false; }
        },
        onMessage: message => {
          if (!this.visible) return;
          if (message.type === 'game' && message.game.id === this.gameId) { this.render(message.game); }
          if (message.type === 'pong' && message.serverNow) {
            this.offset = message.serverNow - Date.now();
          }
        },
        onReconnect: () => this.refresh().catch(err => this.setData({ error: api.errorText(err) }))
      });
      this.socket.start();
    } catch (err) { if (this.visible) this.setData({ error: api.errorText(err), connection: '未连接' }); }
  },
  async refresh() {
    const token = getApp().globalData.token;
    const result = await api.request('/api/games/' + encodeURIComponent(this.gameId));
    if (!this.unloaded && token === getApp().globalData.token) this.render(result.game);
  },
  render(game) {
    if (this.unloaded || !getApp().globalData.user) return;
    const previous = this.data.game;
    if (previous && game.version < previous.version) return;
    this.offset = game.serverNow - Date.now();
    const userId = getApp().globalData.user.id;
    const myColor = ['red', 'black'].find(color => game.seats[color] && game.seats[color].id === userId) || '';
    recentGame.remember(game, userId);
    const savedPerspective = wx.getStorageSync('gougeGamePerspective');
    const gamePerspective = savedPerspective && savedPerspective.gameId === game.id && savedPerspective.userId === userId ? savedPerspective.perspective : '';
    const perspective = myColor || gamePerspective || 'red';
    const positionChanged = previous && (previous.id !== game.id || !sameBoard(previous.board, game.board) || previous.history.length !== game.history.length);
    const orientationChanged = previous && perspective !== this.data.perspective;
    const move = this.visible && this.animationPrimed && !orientationChanged ? confirmedMove(previous, game) : null;
    const nonMoveFinish = previous && previous.status !== 'finished' && game.status === 'finished' && !move;
    let skipMotion = false;
    if (this.motionActive && positionChanged) {
      if (move && this.motionQueue.length < 2) this.motionQueue.push(move);
      else { this.cancelMotion(false); skipMotion = true; }
    }
    if (orientationChanged || (!move && positionChanged) || nonMoveFinish) { this.cancelMotion(false); skipMotion = true; }
    const selected = previous && previous.version === game.version ? this.data.selected : -1;
    const incomingUndo = game.undo && game.undo.requesterId !== userId;
    const incomingDraw = game.draw && game.draw.requesterId !== userId;
    const outcomeText = game.outcome ? (game.outcome.winner ? (game.outcome.winner === 'red' ? '红方胜' : '黑方胜') : '和棋') + ' · ' + game.outcome.reason : '';
    let statusText = game.status === 'waiting' ? '双方准备后开始' : (game.turn === 'red' ? '红方走棋' : '黑方走棋');
    if (!myColor) statusText = '正在旁观 · ' + statusText;
    if (game.aiThinking) statusText = 'AI 正在思考';
    if (game.status === 'finished') statusText = outcomeText;
    const bottomColor = perspective, topColor = perspective === 'red' ? 'black' : 'red';
    const displaySeats = game.status === 'finished' && game.resultSeats ? game.resultSeats : game.seats;
    const draft = wx.getStorageSync('gougeGameControl');
    const control = game.status === 'waiting' && game.ownerId === userId && !game.ready[myColor]
      ? (draft && draft.gameId === game.id && draft.userId === userId ? draft.control : getPreferences().timeControl)
      : game.timeControl;
    this.setData({
      game, myColor, userId, spectator: !myColor, perspective, selected,
      cells: boardCells(Object.assign({}, game, { board: this.visualBoard || game.board }), perspective, selected), statusText,
      control,
      canRespondUndo: !!incomingUndo && !!myColor,
      canRespondDraw: !!incomingDraw && !!myColor,
      topColor, bottomColor, topPlayer: api.userView(displaySeats[topColor]), bottomPlayer: api.userView(displaySeats[bottomColor])
    });
    if (move && !this.motionActive && !skipMotion) this.startMotion(move);
    this.animationPrimed = this.visible;
    if (!previous || previous.status !== game.status) this.configureLayout();
    this.promptAgreement();
    this.syncChat();
    this.tick();
    if (this.allowMoveSound && previous && previous.id === game.id && game.history.length > previous.history.length && this.audio) {
      this.audio.stop();
      this.audio.play();
    }
  },
  tick() {
    if (!this.data.game || !this.visible) return;
    if (this.chatActive && !this.chatCurrent()) this.stopChat();
    const game = this.data.game;
    const undoSeconds = game.undo ? Math.max(0, Math.ceil((game.undo.expiresAt - Date.now() - this.offset) / 1000)) : 0;
    const drawSeconds = game.draw ? Math.max(0, Math.ceil((game.draw.expiresAt - Date.now() - this.offset) / 1000)) : 0;
    this.setData({ clock: displayClock(game, this.offset), undoSeconds, drawSeconds });

  },
  async point(event) {
    const game = this.data.game;
    if (!game || this.data.busy || this.data.spectator || game.status !== 'active' || game.turn !== this.data.myColor) return;
    if (this.motionActive) this.cancelMotion();
    const index = Number(event.currentTarget.dataset.index);
    const candidate = (game.legalMoves || []).find(move => move.from === this.data.selected && move.to === index);
    if (candidate) return this.action('move', { moveId: candidate.id });
    const piece = game.board[index];
    const selected = piece && piece.color === this.data.myColor ? (this.data.selected === index ? -1 : index) : -1;
    this.setData({ selected, cells: boardCells(game, this.data.perspective, selected) });
  },
  async ready() {
    if (this.data.busy || !this.data.game || this.data.spectator || this.data.game.status !== 'waiting' || this.data.game.ready[this.data.myColor]) return;
    this.setData({ busy: true, error: '' });
    try {
      const mine = this.data.game.ownerId === getApp().globalData.user.id;
      const result = await api.request('/api/games/' + encodeURIComponent(this.gameId) + '/ready', 'POST', mine ? { timeControl: this.data.control } : {});
      this.render(result.game);
    } catch (err) { this.setData({ error: api.errorText(err) }); }
    finally { this.setData({ busy: false }); }
  },
  async action(type, extras = {}) {
    if (this.data.busy || !this.data.game) return;
    this.setData({ busy: true, error: '' });
    const game = this.data.game;
    try {
      const result = await api.request('/api/games/' + encodeURIComponent(this.gameId) + '/action', 'POST', Object.assign({
        type, version: game.version, turnId: game.turnId, operationId: operationId()
      }, extras));
      this.render(result.game);
    } catch (err) {
      this.setData({ error: api.errorText(err), selected: -1 });
      await this.refresh().catch(() => {});
    } finally { this.setData({ busy: false }); }
  },
  async resign() {
    const game = this.data.game;
    if (this.data.busy || this.data.spectator || !game || game.status !== 'active') return;
    const result = await new Promise(resolve => wx.showModal({
      title: '认输结束这盘棋？', content: '确认后，本盘将判你负。', confirmText: '认输', cancelText: '继续下棋', confirmColor: '#a8322e',
      success: resolve, fail: () => resolve({ confirm: false })
    }));
    const current = this.data.game;
    const user = getApp().globalData.user;
    if (result.confirm && this.visible && current && current.id === game.id && current.status === 'active' && user && recentGame.ownColor(current, user.id)) await this.action('resign');
  },
  async leaveTable() {
    let game = this.data.game;
    if (!game || this.data.busy) return;
    if (!this.data.spectator && game.status === 'active') {
      const result = await new Promise(resolve => wx.showModal({
        title: '离开当前棋桌？', content: '返回首页后计时继续，可回来接着下。创建或加入另一盘，旧局会自动判负。',
        confirmText: '继续离开', cancelText: '继续下棋', success: resolve, fail: () => resolve({ confirm: false })
      }));
      if (!result.confirm || !this.visible) return;
    }
    this.setData({ busy: true, error: '' });
    try {
      this.stopChat();
      game = this.data.game;
      if (game.tableId && (this.data.spectator || game.status !== 'active')) {
        await api.request('/api/tables/' + game.tableId + '/leave', 'POST', { gameId: game.id });
        this.leftTable = true;
      }
      if (this.data.spectator || game.status !== 'active') recentGame.forget(game.id);
      else recentGame.remember(game, this.data.userId);
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (err) { this.setData({ error: api.errorText(err) }); if (this.visible) this.syncChat(); }
    finally { this.setData({ busy: false }); }
  },
  undoRespond(event) {
    const undo = this.data.game.undo;
    if (undo) this.action('undo-respond', { requestId: undo.id, accept: event.currentTarget.dataset.accept === true || event.currentTarget.dataset.accept === 'true' });
  },
  drawRespond(event) {
    const draw = this.data.game && this.data.game.draw;
    if (this.data.spectator || !draw) return;
    this.action('draw-respond', { requestId: draw.id, accept: event.currentTarget.dataset.accept === true || event.currentTarget.dataset.accept === 'true' });
  },
  chatAllowed() {
    const app = getApp(), user = app.globalData.user, game = this.data.game;
    return !!(this.visible && !this.unloaded && user && app.globalData.token && game && game.id === this.gameId && game.mode === 'pvp' &&
      (['red', 'black'].some(color => game.seats[color] && game.seats[color].id === user.id) || (game.spectators || []).some(person => (person.id || person) === user.id)));
  },
  chatCurrent() {
    const app = getApp();
    return this.chatActive && this.chatAllowed() && this.chatToken === app.globalData.token && this.chatUserId === app.globalData.user.id;
  },
  syncChat() {
    if (!this.chatAllowed()) { this.stopChat(); return; }
    const app = getApp(), userId = app.globalData.user.id;
    if (this.chatActive && this.chatToken === app.globalData.token && this.chatUserId === userId) return;
    this.stopChat();
    this.chatToken = app.globalData.token;
    this.chatUserId = userId;
    this.chatActive = true;
    this.chatHasHistory = false;
    this.chatSeenSeq = 0;
    this.setData({ chatEnabled: true, chatMessages: [], chatDraft: '', chatUnread: 0, chatError: '' });
    this.chatRoom.start();
  },
  stopChat() {
    this.chatActive = false;
    if (this.chatRoom) this.chatRoom.stop();
    this.clearSubtitles();
    if (!this.unloaded) this.setData({ chatEnabled: false, chatOpen: false, reactionOpen: false, chatReady: false, chatBusy: false,
      chatMessages: [], chatDraft: '', chatUnread: 0, chatScrollTo: '', chatError: '' });
  },
  applyChatState(state) {
    if (!this.chatCurrent()) return;
    const patch = {};
    if (Array.isArray(state.messages)) {
      const messages = state.messages.map(message => Object.assign({}, message, {
        displayName: message.name + (message.userId === this.chatUserId ? ' · 我' : ''), rowId: 'chat-message-' + message.seq
      }));
      patch.chatMessages = messages;
      if (state.ready) {
        const additions = this.chatHasHistory ? messages.filter(message => message.seq > this.chatSeenSeq && message.userId !== this.chatUserId) : [];
        this.chatHasHistory = true;
        this.chatSeenSeq = Math.max(this.chatSeenSeq, ...messages.map(message => message.seq));
        patch.chatUnread = this.data.chatOpen ? 0 : this.data.chatUnread + additions.length;
      }
      if (this.data.chatOpen && messages.length) patch.chatScrollTo = messages[messages.length - 1].rowId;
    }
    if (typeof state.ready === 'boolean') patch.chatReady = state.ready;
    if (typeof state.busy === 'boolean') patch.chatBusy = state.busy;
    if (typeof state.error === 'string') patch.chatError = state.error;
    this.setData(patch);
  },
  toggleChat() {
    if (!this.chatCurrent()) return;
    const open = !this.data.chatOpen, messages = this.data.chatMessages;
    this.setData({ chatOpen: open, reactionOpen: false, chatUnread: open ? 0 : this.data.chatUnread,
      chatScrollTo: open && messages.length ? messages[messages.length - 1].rowId : '' });
  },
  closeChat() { this.setData({ chatOpen: false }); },
  chatInput(event) { this.setData({ chatDraft: Array.from(event.detail.value).slice(0, 200).join('') }); },
  async sendChat() {
    if (!this.chatCurrent() || this.data.chatBusy) return;
    const draft = this.data.chatDraft, text = draft.trim();
    if (!text) return;
    try {
      const sent = await this.chatRoom.send({ text });
      if (sent !== false && this.chatCurrent() && this.data.chatDraft === draft) this.setData({ chatDraft: '' });
    } catch (err) { if (this.chatCurrent()) this.setData({ chatError: api.errorText(err) }); }
  },
  openReactions() { if (this.chatCurrent()) this.setData({ reactionOpen: true, chatOpen: false }); },
  closeReactions() { this.setData({ reactionOpen: false }); },
  async chooseReaction(event) {
    const reaction = event.currentTarget.dataset.reaction;
    if (!this.chatCurrent() || this.data.chatBusy || !this.data.reactions.some(item => item.id === reaction)) return;
    this.setData({ reactionOpen: false });
    try { await this.chatRoom.send({ reaction }); }
    catch (err) { if (this.chatCurrent()) this.setData({ chatError: api.errorText(err) }); }
  },
  receiveChat(messages) {
    if (!this.chatCurrent()) return;
    const available = Math.max(0, 10 - this.subtitleQueue.length - (this.data.subtitle ? 1 : 0));
    this.subtitleQueue.push(...messages.slice(0, available));
    this.playSubtitle();
  },
  playSubtitle() {
    if (!this.chatCurrent() || this.data.subtitle || !this.subtitleQueue.length) return;
    const message = this.subtitleQueue.shift();
    const name = message.name + (message.userId === this.chatUserId ? ' · 我' : '');
    const lineLength = Math.max(8, Math.floor((this.data.layout.frameWidth - 48) / 22));
    const lines = (name + '：' + message.text).split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / lineLength)), 0);
    const duration = Math.max(3600, 2000 + lines * 1300), generation = this.subtitleGeneration;
    this.setData({ subtitle: { id: message.id, name, text: message.text, longText: lines > 3, duration } });
    this.subtitleTimer = setTimeout(() => {
      if (generation !== this.subtitleGeneration || !this.chatCurrent()) return;
      this.setData({ subtitle: null }, () => this.playSubtitle());
    }, duration);
  },
  clearSubtitles() {
    this.subtitleGeneration = (this.subtitleGeneration || 0) + 1;
    clearTimeout(this.subtitleTimer);
    this.subtitleQueue = [];
    if (!this.unloaded) this.setData({ subtitle: null });
  },
  motionLater(delay, callback, generation) {
    const timer = setTimeout(() => {
      if (this.motionGeneration === generation && this.motionActive && this.visible && !this.unloaded) callback();
    }, delay);
    this.motionTimers.push(timer);
  },
  updateMotion(patch) {
    this.setData({ motion: Object.assign({}, this.data.motion, patch) });
  },
  startMotion(move) {
    if (!this.visible || this.unloaded) return;
    const generation = ++this.motionGeneration;
    this.motionActive = true;
    this.currentMotion = move;
    this.visualBoard = move.boardBefore.slice();
    this.visualBoard[move.from] = null;
    this.setData({
      motion: null,
      cells: boardCells(Object.assign({}, this.data.game, { board: this.visualBoard }), this.data.perspective, -1)
    }, () => queryGeometry(this, geometry => {
      if (generation !== this.motionGeneration || !this.motionActive || !this.visible || this.unloaded) return;
      if (!geometry) { this.cancelMotion(); return; }
      const from = displayPoint(move.from, this.data.perspective, geometry.board, geometry.stage);
      const to = displayPoint(move.to, this.data.perspective, geometry.board, geometry.stage);
      const direction = to.x >= geometry.stage.width / 2 ? 1 : -1;
      const exit = { x: direction > 0 ? geometry.stage.width + 42 : -42, y: to.y - 70 };
      const lift = Math.min(18, geometry.board.width / 18);
      this.setData({ motion: {
        phase: 'take', mover: move.mover, captured: move.captured, handRotation: move.color === this.data.perspective ? 170 : -10,
        moverPoint: from, flyPoint: to, moverVisible: true, capturedVisible: false,
        moveDuration: 140, flyDuration: 0, flyRotation: 0, flyScale: 1, flyOpacity: 1
      } });
      this.motionLater(16, () => this.updateMotion({ phase: 'lift', moverPoint: { x: from.x, y: from.y - lift } }), generation);
      this.motionLater(150, () => this.updateMotion({ phase: 'travel', moverPoint: { x: to.x, y: to.y - lift }, moveDuration: 260 }), generation);
      this.motionLater(420, () => this.updateMotion({ phase: 'drop', moverPoint: to, moveDuration: 100 }), generation);
      this.motionLater(530, () => {
        this.visualBoard = move.boardAfter;
        this.setData({ cells: boardCells(Object.assign({}, this.data.game, { board: this.visualBoard }), this.data.perspective, -1) });
        this.updateMotion({ phase: 'release', moverVisible: false, capturedVisible: !!move.captured });
      }, generation);
      if (!move.captured) {
        this.motionLater(680, () => this.finishMotion(generation), generation);
        return;
      }
      this.motionLater(546, () => this.updateMotion({
        phase: 'strike', flyDuration: 110, flyPoint: { x: to.x + (direction * 36), y: to.y - 42 }, flyRotation: -45, flyScale: 1.06
      }), generation);
      this.motionLater(660, () => this.updateMotion({ phase: 'fly-away', flyDuration: 280, flyPoint: exit, flyRotation: 245, flyScale: 0.48, flyOpacity: 0.65 }), generation);
      this.motionLater(950, () => this.updateMotion({ phase: 'fade', flyDuration: 90, flyPoint: { x: exit.x + direction * 16, y: exit.y + 12 }, flyScale: 0.22, flyOpacity: 0 }), generation);
      this.motionLater(1040, () => this.finishMotion(generation), generation);
    }));
  },
  finishMotion(generation) {
    if (generation !== this.motionGeneration || !this.visible || this.unloaded) return;
    this.motionTimers.forEach(clearTimeout);
    this.motionTimers = [];
    this.currentMotion = null;
    this.motionActive = false;
    const next = this.motionQueue.shift();
    if (next) { this.startMotion(next); return; }
    this.visualBoard = null;
    this.setData({ motion: null, cells: boardCells(this.data.game, this.data.perspective, this.data.selected) });
  },
  cancelMotion(settle = true) {
    this.motionGeneration++;
    (this.motionTimers || []).forEach(clearTimeout);
    this.motionTimers = [];
    this.motionQueue = [];
    this.currentMotion = null;
    this.motionActive = false;
    this.visualBoard = null;
    if (this.unloaded) return;
    const patch = { motion: null };
    if (settle && this.data.game) patch.cells = boardCells(this.data.game, this.data.perspective, this.data.selected);
    this.setData(patch);
  },
  setupAudio() {
    this.releaseAudio();
    const preferences = getPreferences();
    this.setData({ soundError: '' });
    if (!preferences.moveSound || !wx.createInnerAudioContext) return;
    this.audio = wx.createInnerAudioContext();
    this.audio.src = '/assets/move.wav';
    this.audio.obeyMuteSwitch = true;
    this.audio.onError(() => {
      if (!this.unloaded) this.setData({ soundError: '落子声音未能播放' });
    });
  },
  releaseAudio() {
    if (!this.audio) return;
    this.audio.stop();
    this.audio.destroy();
    this.audio = null;
  },
  onHide() {
    this.visible = false;
    this.animationPrimed = false;
    this.cancelMotion();
    this.allowMoveSound = false;
    this.releaseAudio();
    clearInterval(this.interval);
    if (this.socket) this.socket.stop();
    this.stopChat();
  },
  onUnload() {
    this.onHide();
    this.unloaded = true;
    const game = this.data.game;
    if (game && game.tableId && this.data.spectator && !this.leftTable) api.request('/api/tables/' + game.tableId + '/leave', 'POST', { gameId: game.id }).catch(() => {});
  }
});
