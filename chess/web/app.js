import { confirmedMove, paintMotion } from './chess-motion.js';
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const names = { red: { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' }, black: { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' } };
const levels = ['新手', '初级', '中级', '高级', '挑战'];
const descriptions = ['轻松熟悉棋盘与走法', '开始考虑吃子与防守', '多看几步，练习攻守', '更深搜索，认真较量', '本地引擎的最高搜索档'];
const defaults = { mode: 'normal', perMoveSeconds: 60, totalSeconds: 600, overtimeSeconds: 20, rapidSeconds: 15 };
const reactions = { handshake: ['🤝', '握手'], thumbsup: ['👍', '点赞'], badmove: ['🙈', '臭棋'], cry: ['😭', '哭鼻子'], laugh: ['😂', '哈哈大笑'], whiteflag: ['🏳️', '白旗'] };
const state = { route: 'home', token: localStorage.getItem('gouge.token'), user: null, health: null, tables: [], game: null, selected: null, flipped: false, difficulty: 2, humanColor: 'red', socket: null, reconnect: null, busy: false, serverOffset: 0 };
let toastTimer, motion = null, motionTimer, motionAnimations = [], pendingLeave = null, pendingResign = null;
const motionQueue = [];
const chat = { gameId: null, token: null, seq: 0, ready: false, messages: [], queue: [], captionIds: [], caption: null, draft: '', status: '正在同步同桌消息…', active: false, generation: 0, sending: false, retry: null, cooldown: 0 };
let chatTimer, chatPending, captionTimer, chatCooldownTimer;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sideName = color => color === 'red' ? '红方' : '黑方';
const other = color => color === 'red' ? 'black' : 'red';
function prefs() { try { return { ...defaults, ...JSON.parse(localStorage.getItem('gouge.time') || '{}') }; } catch { return { ...defaults }; } }
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4200); }
async function api(path, method = 'GET', data, token = state.token, signal) {
  const response = await fetch(`/api${path}`, { method, signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.token === token) { state.token = null; state.user = null; localStorage.removeItem('gouge.token'); state.socket?.close(); syncChat(); }
    throw Object.assign(new Error(body.error || `请求失败（${response.status}）`), { status: response.status, code: body.code, retryAfterMs: body.retryAfterMs });
  }
  return body;
}
async function task(fn) {
  if (state.busy) return;
  state.busy = true; app.classList.add('busy');
  try { await fn(); } catch (error) { toast(error.message); if (state.game) await refreshGame().catch(() => {}); }
  finally { state.busy = false; app.classList.remove('busy'); }
}
function avatar(user, color = '', size = '') {
  const value = user?.avatar;
  if (value && (/^\/(uploads|avatars)\//.test(value) || /^https:\/\//.test(value) || /^data:image\/(png|jpeg|webp);base64,/.test(value))) return `<img class="avatar ${color} ${size}" src="${escape(value)}" alt="${escape(user.name)}的头像">`;
  return `<div class="avatar ${color} ${size}" aria-hidden="true">${escape(user?.kind === 'ai' ? '棋' : (user?.name || '待').slice(0, 1))}</div>`;
}
function updateHeader() {
  document.body.classList.toggle('in-game', state.route === 'game' && !!state.game);
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.route === state.route));
  document.querySelector('#profile-button').textContent = state.user?.name || '未登录';
  document.querySelector('#connection-label').textContent = `${state.health?.devMode ? '本地开发模式' : '微信服务模式'} · ${!state.user ? '服务可用' : state.socket?.readyState === 1 ? '已连接' : '连接恢复中'}`;
}
function render() {
  const focusedCell = document.activeElement?.dataset.cell;
  if (state.route !== 'game') cancelMotion();
  updateHeader();
  if (state.route !== 'home' && !state.user) { renderLogin(); return; }
  ({ home: renderHome, ai: renderAI, lobby: renderLobby, settings: renderSettings, game: renderGame }[state.route] || renderHome)();
  if (focusedCell !== undefined) app.querySelector(`[data-cell="${focusedCell}"]`)?.focus({ preventScroll: true });
  tick();
  if (motion && state.route === 'game') {
    motionAnimations.forEach(animation => animation.cancel());
    motionAnimations = paintMotion(motion, boardFlipped() ? 'black' : 'red');
  }
  syncChat();
}
function initialBoard() {
  const board = Array(90).fill(null);
  for (const [color, y, cy, py] of [['black', 0, 2, 3], ['red', 9, 7, 6]]) {
    ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'].forEach((type, x) => { board[y * 9 + x] = { type, color }; });
    [1, 7].forEach(x => { board[cy * 9 + x] = { type: 'C', color }; });
    [0, 2, 4, 6, 8].forEach(x => { board[py * 9 + x] = { type: 'P', color }; });
  }
  return board;
}
function boardMarkup(board, interactive = false) {
  const flipped = interactive && boardFlipped();
  const legal = interactive && state.selected !== null ? state.game.legalMoves.filter(move => move.from === state.selected).map(move => move.to) : [];
  let lines = '';
  for (let y = 0; y < 10; y++) lines += `<line x1="0" y1="${y * 60}" x2="480" y2="${y * 60}"/>`;
  for (let x = 0; x < 9; x++) lines += x === 0 || x === 8 ? `<line x1="${x * 60}" y1="0" x2="${x * 60}" y2="540"/>` : `<line x1="${x * 60}" y1="0" x2="${x * 60}" y2="240"/><line x1="${x * 60}" y1="300" x2="${x * 60}" y2="540"/>`;
  lines += '<path d="M180 0L300 120M300 0L180 120M180 420L300 540M300 420L180 540" fill="none"/>';
  let marks = '';
  for (const [x, y] of [[1, 2], [7, 2], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3], [1, 7], [7, 7], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]]) {
    if (x > 0) marks += `<path d="M${x * 60 - 4} ${y * 60 - 12}v8h-8M${x * 60 - 4} ${y * 60 + 12}v-8h-8"/>`;
    if (x < 8) marks += `<path d="M${x * 60 + 4} ${y * 60 - 12}v8h8M${x * 60 + 4} ${y * 60 + 12}v-8h8"/>`;
  }
  const cells = board.map((piece, index) => {
    let x = index % 9, y = Math.floor(index / 9); if (flipped) { x = 8 - x; y = 9 - y; }
    const isLegal = legal.includes(index);
    const last = interactive && [state.game.lastMove?.from, state.game.lastMove?.to].includes(index);
    const label = `${piece ? sideName(piece.color) + names[piece.color][piece.type] : '空位'}，横坐标${index % 9 + 1}，纵坐标${Math.floor(index / 9) + 1}${isLegal ? '，可落子' : ''}`;
    return `<${interactive ? 'button' : 'div'} class="board-point${state.selected === index && interactive ? ' selected' : ''}${isLegal ? ' legal' : ''}${last ? ' last' : ''}" style="left:${x / 8 * 100}%;top:${y / 9 * 100}%" ${interactive ? `data-cell="${index}" aria-label="${escape(label)}"` : ''}>${piece ? `<span class="piece ${piece.color}">${names[piece.color][piece.type]}</span>` : ''}</${interactive ? 'button' : 'div'}>`;
  }).join('');
  return `<div class="board" ${interactive ? 'role="group" aria-label="中国象棋棋盘"' : 'aria-hidden="true"'}><div class="board-playfield"><svg class="board-grid" viewBox="0 0 480 540" preserveAspectRatio="none"><g stroke="currentColor" stroke-width="1.4">${lines}<g stroke-width="1">${marks}</g></g><g fill="currentColor" font-size="28" font-family="Songti SC,serif"><text x="65" y="280" letter-spacing="14">楚河</text><text x="318" y="280" letter-spacing="14">汉界</text></g></svg>${cells}</div><div class="board-labels">${['九', '八', '七', '六', '五', '四', '三', '二', '一'].map(n => `<span>${n}</span>`).join('')}</div></div>`;
}
function renderHome() {
  app.innerHTML = `<section class="hero"><div class="hero-copy"><div class="eyebrow">狗哥家的象棋时光</div><h1>一起下盘棋，<br><em>聊聊家常。</em></h1><p>和家人隔着屏幕，也能坐在同一张棋桌前。想练练棋，就先找 AI 来一盘。</p><div class="hero-actions"><button class="primary" data-route="ai">与 AI 下棋</button><button data-route="lobby">去家人大厅</button>${state.game ? '<button data-route="game">继续对局</button>' : ''}</div><div class="hero-meta"><span>五档 AI 难度</span><span>六张家人棋桌</span><span>同意后悔棋</span></div></div><div class="hero-board">${boardMarkup(initialBoard())}</div></section><section class="home-bottom"><div class="home-item"><strong>慢慢想，也能下快棋</strong><p>各自累计思考时间，自由设定每手时限。超时后，系统代走一步。</p></div><div class="home-item"><strong>下棋、观棋，都在一桌</strong><p>选择棋桌入座，或看看家人正在下的棋。同桌棋手和旁观者都可以文字交流。</p></div><div class="home-item"><strong>悔棋，先问问对方</strong><p>对方同意后，撤回到自己上一手之前。已经思考的时间仍然保留。</p></div></section>`;
}
function renderLogin() {
  const dev = state.health?.devMode;
  app.innerHTML = `<section class="card login-card"><span class="badge ${dev ? 'warning' : ''}">${dev ? '本地开发账号' : '微信身份验证'}</span><h2>先打个招呼</h2><p>${dev ? '填写称呼即可试玩。这个账号用于本地开发，不是微信登录。' : '请使用微信小程序登录。浏览器试玩账号仅在服务端开发模式下开放。'}</p>${dev ? '<form id="login-form"><label for="login-name">怎么称呼你？</label><input id="login-name" name="name" maxlength="20" autocomplete="nickname" placeholder="例如：狗哥" required><button class="primary full" type="submit">进入棋馆</button></form>' : '<button class="full" data-route="home">返回首页</button>'}</section>`;
}
function timeForm(prefix, time = prefs()) {
  return `<div class="field"><label for="${prefix}-mode">计时模式</label><select id="${prefix}-mode" data-time-mode="${prefix}"><option value="normal" ${time.mode === 'normal' ? 'selected' : ''}>普通模式</option><option value="rapid" ${time.mode === 'rapid' ? 'selected' : ''}>快棋模式</option></select></div><div class="timer-inputs" id="${prefix}-normal" ${time.mode === 'rapid' ? 'hidden' : ''}><div class="timer-toggle"><label class="checkbox-label"><input type="checkbox" id="${prefix}-per-on" ${time.perMoveSeconds !== null ? 'checked' : ''}>每手等待上限</label><input aria-label="每手等待上限秒数" id="${prefix}-per" type="number" min="1" max="86400" value="${time.perMoveSeconds ?? 60}"></div><div class="timer-toggle"><label class="checkbox-label"><input type="checkbox" id="${prefix}-total-on" ${time.totalSeconds !== null ? 'checked' : ''}>每人总思考额度</label><input aria-label="每人总额度分钟" id="${prefix}-total" type="number" min="0.1" max="1440" step="0.1" value="${(time.totalSeconds ?? 600) / 60}"></div><div class="field"><label for="${prefix}-overtime">额度用完后，每手限时（秒）</label><input id="${prefix}-overtime" type="number" min="1" max="86400" value="${time.overtimeSeconds}"></div></div><div class="field" id="${prefix}-rapid" ${time.mode !== 'rapid' ? 'hidden' : ''}><label for="${prefix}-q">快棋每手限时（秒）</label><input id="${prefix}-q" type="number" min="1" max="86400" value="${time.rapidSeconds}"></div>`;
}
function readTime(prefix) {
  const value = id => Number(document.getElementById(`${prefix}-${id}`).value);
  const time = { mode: document.getElementById(`${prefix}-mode`).value, perMoveSeconds: document.getElementById(`${prefix}-per-on`).checked ? value('per') : null, totalSeconds: document.getElementById(`${prefix}-total-on`).checked ? Math.round(value('total') * 60) : null, overtimeSeconds: value('overtime'), rapidSeconds: value('q') };
  if ([time.perMoveSeconds, time.totalSeconds, time.overtimeSeconds, time.rapidSeconds].some(n => n !== null && (!Number.isFinite(n) || n <= 0 || n > 86400))) throw new Error('时长必须大于 0，且不超过 24 小时。');
  return time;
}
function renderAI() {
  app.innerHTML = `<header class="page-head"><div><div class="eyebrow">练练手，找找棋感</div><h1>与 AI 下棋</h1><p>选一个适合自己的对手。</p></div><span class="badge ${state.health?.deepseekConfigured ? '' : 'warning'}">${state.health?.deepseekConfigured ? 'DeepSeek 已配置' : '本地引擎可用'}</span></header><section class="setup-layout"><div class="card"><h3>选择难度</h3><div class="difficulty-list">${levels.map((label, i) => `<button class="difficulty-option ${state.difficulty === i + 1 ? 'selected' : ''}" data-difficulty="${i + 1}" aria-pressed="${state.difficulty === i + 1}"><span class="difficulty-number">0${i + 1}</span><span><strong>${label}</strong><small>${descriptions[i]}</small></span></button>`).join('')}</div><p class="setup-note">五档采用不同搜索预算和候选策略。难度名称不代表专业棋力评级。</p></div><form class="card" id="ai-form"><h3>这一盘怎么下</h3><div class="field"><label>选择执棋</label><div class="segmented"><button type="button" data-color="red" class="${state.humanColor === 'red' ? 'selected' : ''}">红方 · 先行</button><button type="button" data-color="black" class="${state.humanColor === 'black' ? 'selected' : ''}">黑方 · 后行</button></div></div>${timeForm('ai')}<p class="setup-note">双方独立计时。达到截止时间后，系统自动走一手合法棋。</p><button class="primary full" type="submit">开始对局</button></form></section>`;
}
function renderLobby() {
  app.innerHTML = `<header class="page-head"><div><div class="eyebrow">家人的棋馆</div><h1>选张桌子，坐下来</h1><p>空位可以入座，正在下棋的桌子可以旁观。</p></div><button data-action="refresh-lobby">刷新大厅</button></header><section class="table-grid">${state.tables.length ? state.tables.map(table => {
    const occupied = Object.values(table.seats).filter(Boolean).length;
    const seated = Object.values(table.seats).some(user => user?.id === state.user.id);
    const status = table.status === 'active' ? '对局中' : table.status === 'finished' ? '本局结束' : occupied ? '等待开局' : '空桌';
    return `<article class="card table-card"><div class="table-head"><h2 class="table-number">${String(table.id).padStart(2, '0')} 号桌</h2><span class="badge ${table.status === 'active' ? '' : 'warning'}">${status}</span></div><div class="seats-row">${seatMarkup(table.seats.red, 'red')}<span class="versus">对弈</span>${seatMarkup(table.seats.black, 'black')}</div><div class="table-actions"><button class="primary" data-join="${table.id}" ${occupied >= 2 && !seated ? 'disabled' : ''}>${seated ? '回到棋桌' : '入座下棋'}</button><button data-watch="${table.id}" ${!table.gameId ? 'disabled' : ''}>旁观</button></div><p class="spectator">${table.spectatorCount || 0} 人旁观 · 每桌独立聊天</p></article>`;
  }).join('') : '<div class="card muted">正在获取六张棋桌…</div>'}</section><p class="rule-note">浏览器可用于本地联机试玩，同桌聊天与互动只在这桌家人之间同步。</p>`;
}
function seatMarkup(user, color) { return `<div class="seat-person">${avatar(user, color)}<span>${escape(user?.name || '等待家人')}</span><small class="muted">${sideName(color)}</small></div>`; }
function renderSettings() {
  const h = state.health;
  app.innerHTML = `<header class="page-head settings-head"><div><h1>设置</h1><p>${state.game ? '本局操作与详情集中在这里，计时继续。' : '修改称呼，以及下一盘的默认计时。'}</p></div>${state.game ? '<button class="primary" data-route="game">返回棋盘</button>' : ''}</header>${state.game ? `<section class="settings-layout game-settings" id="game-settings">${gameSettingsMarkup()}</section>` : ''}<section class="settings-layout"><form class="card" id="profile-form"><h3>个人资料</h3><div class="profile-edit">${avatar(state.user)}<div><label for="avatar-file">更换头像</label><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp"></div></div><div class="field"><label for="profile-name">昵称</label><input id="profile-name" name="name" maxlength="20" value="${escape(state.user.name)}" required></div><button class="primary full">保存资料</button><p class="setup-note">${h.devMode ? '当前使用本地开发账号。微信客户端会使用真实微信登录，并由用户主动填写头像、昵称。' : '微信身份已由服务端验证，昵称与头像可以自行修改。'}</p><button class="text-button full" type="button" data-action="logout">退出当前账号</button></form><form class="card" id="preferences-form"><h3>默认计时</h3>${timeForm('prefs')}<div class="field"><label class="checkbox-label"><input id="sound-on" type="checkbox" ${localStorage.getItem('gouge.sound') === 'true' ? 'checked' : ''}>播放落子提示音</label></div><button class="primary full">保存默认设置</button><p class="setup-note">仅用于下一盘开局，进行中的对局规则不会改变。</p></form><div class="card"><h3>服务状态</h3><div class="status-list">${[['对战服务', true], ['真实微信登录', h.wechatConfigured], ['DeepSeek 接口', h.deepseekConfigured]].map(([label, ok]) => `<div class="status-line"><span>${label}</span><span class="badge ${ok ? '' : 'warning'}">${ok ? '已配置' : '待配置'}</span></div>`).join('')}</div><p class="rule-note">“已配置”仅表示服务端配置存在。外部服务与微信真机权限需另行验证。</p></div><div class="card"><h3>规则说明</h3><p class="small muted">中国象棋基础规则与循环局面按 WXF 2018 实现。复杂棋例的实际验证范围记录在源码 docs/RULES.md 中。</p><p class="rule-note">家庭玩法：超时自动走棋；双方同意后可以悔棋；悔棋不退还已消耗的时间。</p><button class="text-button" type="button" data-action="rules">查看计时与悔棋说明</button></div></section>`;
}
function playerColor() { return state.game ? ['red', 'black'].find(color => state.game.seats[color]?.id === state.user?.id) || null : null; }
function boardFlipped() { const color = playerColor(); return color ? color === 'black' : state.flipped; }
function gameSummary(time) {
  if (time.mode === 'rapid') return `快棋 · 每手 ${time.rapidSeconds} 秒`;
  return [time.perMoveSeconds !== null ? `每手 ${time.perMoveSeconds} 秒` : '', time.totalSeconds !== null ? `每人 ${time.totalSeconds / 60} 分钟，之后每手 ${time.overtimeSeconds} 秒` : ''].filter(Boolean).join('；') || '不限时，统计思考时间';
}
function playerBar(color, settings = false) {
  const g = state.game, user = (g.status === 'finished' && g.resultSeats ? g.resultSeats : g.seats)[color];
  return `<div class="player-bar ${g.status === 'active' && g.turn === color ? 'active' : ''}">${avatar(user, color)}<div class="player-details"><div class="player-name">${escape(user?.name || '等待家人入座')}${user?.id === state.user.id ? ' · 我' : ''}</div><div class="player-side">${sideName(color)}${g.status === 'waiting' && user ? (g.ready[color] ? ' · 已准备' : ' · 未准备') : user?.kind === 'ai' ? ` · ${levels[g.difficulty - 1]}` : ''}</div></div><div class="player-clock"><div class="clock-big" data-clock="${color}" aria-label="${sideName(color)}剩余时间">—</div></div>${settings ? '<button class="game-settings-button" data-route="settings" aria-label="打开本局设置">设置</button>' : ''}</div>`;
}
function gameStatus(game = state.game, color = playerColor()) {
  let status = game.status === 'waiting' ? '等待双方准备' : game.status === 'finished' ? (game.outcome?.winner ? `${sideName(game.outcome.winner)}获胜 · ${game.outcome.reason}` : `本局和棋 · ${game.outcome?.reason || ''}`) : !color ? `正在旁观 · ${sideName(game.turn)}行棋` : game.turn === color ? '轮到你了，点选棋子，再点落点' : game.aiThinking ? 'AI 正在思考…' : '家人正在思考，稍等片刻';
  if (game.status === 'active' && game.history.at(-1)?.source === 'auto') status += ' · 上一手系统代走';
  return status;
}
function gameNotice(game, color) {
  if (game.undo || game.draw) {
    const request = game.undo || game.draw, action = game.undo ? '悔棋' : '和棋';
    return request.requesterId === state.user.id ? `${action}申请待回应` : color ? `对方申请${action}，去答复` : `棋手正在协商${action}`;
  }
  if (game.status === 'waiting' && color) return game.ready[color] ? '查看开局规则' : '去设置准备';
  if (game.status === 'finished') return '查看本局';
  return '';
}
function renderGame() {
  const g = state.game;
  if (!g) { app.innerHTML = '<div class="loading">正在恢复棋局…</div>'; return; }
  const color = playerColor(), bottom = boardFlipped() ? 'black' : 'red', top = other(bottom);
  const frame = motion, shownBoard = frame ? frame.before.map((piece, index) => index === frame.move.from || index === frame.move.to ? null : piece) : g.board;
  const overlay = frame ? `<div class="motion-layer" aria-hidden="true"><div class="moving-actor"><span class="piece ${frame.piece.color}">${names[frame.piece.color][frame.piece.type]}</span><img src="/hand.svg" alt=""></div>${frame.captured ? `<div class="capture-flight"><span class="piece flying-piece ${frame.captured.color}">${names[frame.captured.color][frame.captured.type]}</span></div>` : ''}</div>` : '';
  const notice = gameNotice(g, color);
  app.innerHTML = `<section class="game-layout"><div class="game-main">${playerBar(top, true)}<div class="board-scene ${frame ? 'animating' : ''}">${boardMarkup(shownBoard, true)}${overlay}<div class="chat-caption" aria-live="polite" hidden></div></div>${playerBar(bottom)}<div class="game-status ${g.status === 'finished' ? 'finished' : ''}"><span>${escape(gameStatus(g, color))}</span>${notice ? `<button data-route="settings">${escape(notice)}</button>` : ''}</div><div class="game-exit-actions" aria-label="本局操作"><button class="danger" data-action="resign" ${g.status === 'active' && color ? '' : 'disabled'}>认输</button><button data-action="leave-game">离开</button></div>${chatPanelMarkup()}</div></section>`;
}
function chatAvailable() {
  const game = state.game;
  return Boolean(state.health?.devMode && state.token && state.user && game?.mode === 'pvp' && (playerColor() || game.spectators?.some(user => user?.id === state.user.id)));
}
function chatPanelMarkup() {
  const available = chatAvailable(), ai = state.game?.mode === 'ai';
  return `<section class="chat-panel" aria-label="同桌文字交流"><div class="chat-reactions">${Object.entries(reactions).map(([id, [emoji, label]]) => `<button data-reaction="${id}" aria-label="${label}" title="${label}${id === 'whiteflag' ? '（只是互动，不认输）' : ''}" ${available ? '' : 'disabled'}><span>${emoji}</span><small>${label}</small></button>`).join('')}</div><button class="primary chat-open" data-action="chat-open" ${available ? '' : 'disabled'}>💬 ${ai ? 'AI 对局不使用聊天' : state.health?.devMode ? '同桌聊天 · 查看与输入' : '同桌聊天 · 请在微信中使用'}</button><p id="chat-status">${ai ? '和家人进入同一张棋桌后，可以文字交流' : available ? escape(chat.status) : '只有本桌棋手和旁观者可以交流'}</p></section>`;
}
function chatContext() { return { gameId: state.game?.id, token: state.token, generation: chat.generation }; }
function currentChat(context) { return chat.active && !document.hidden && chatAvailable() && state.route === 'game' && context.gameId === state.game?.id && context.token === state.token && context.generation === chat.generation; }
function paintChat() {
  const caption = app.querySelector('.chat-caption');
  if (caption) {
    caption.hidden = !chat.caption;
    if (!chat.caption) { caption.innerHTML = ''; delete caption.dataset.id; }
    else {
      if (caption.dataset.id !== chat.caption.id) { caption.dataset.id = chat.caption.id; caption.innerHTML = `<strong>${escape(chat.caption.name)}</strong><div class="chat-caption-text"><span>${escape(chat.caption.text)}</span></div>`; }
      const window = caption.querySelector('.chat-caption-text'), text = window.querySelector('span');
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight), lines = Math.max(1, Math.ceil((text.scrollHeight - 1) / lineHeight));
      const travel = Math.max(0, text.scrollHeight - window.clientHeight);
      chat.caption.duration ||= Math.max(3600, 2000 + lines * 1300);
      const elapsed = Date.now() - chat.caption.startedAt;
      caption.style.animationDuration = `${chat.caption.duration}ms`; caption.style.animationDelay = `${-elapsed}ms`;
      window.classList.toggle('scrolling', travel > 1); text.style.setProperty('--chat-rise', `${-travel}px`);
      text.style.animationDuration = `${chat.caption.duration}ms`; text.style.animationDelay = `${-elapsed}ms`;
    }
  }
  const status = app.querySelector('#chat-status'); if (status && chatAvailable()) status.textContent = chat.status;
  const disabled = !chatAvailable() || chat.sending || Date.now() < chat.cooldown;
  app.querySelectorAll('[data-reaction]').forEach(button => { button.disabled = disabled; });
  if (dialog.open && dialog.dataset.chat === 'true') {
    const list = dialog.querySelector('#chat-messages'), previous = list?.dataset.seq;
    if (list && previous !== String(chat.seq)) {
      list.innerHTML = chat.messages.length ? chat.messages.map(message => `<li data-message-id="${escape(message.id)}"><strong>${escape(message.name)}</strong><span>${escape(message.text)}</span></li>`).join('') : '<li class="empty-chat">还没有消息，和家人打个招呼吧。</li>';
      list.dataset.seq = String(chat.seq); list.scrollTop = list.scrollHeight;
    }
    const send = dialog.querySelector('#chat-send'); if (send) send.disabled = disabled;
  }
}
function nextCaption() {
  clearTimeout(captionTimer); const message = chat.queue.shift(); chat.caption = message ? { ...message, startedAt: Date.now() } : null; paintChat();
  if (chat.caption) captionTimer = setTimeout(nextCaption, chat.caption.duration || 3600);
}
function queueCaptions(messages) {
  for (const message of messages) if (!chat.captionIds.includes(message.id)) {
    chat.captionIds.push(message.id); chat.queue.push(message);
  }
  chat.captionIds = chat.captionIds.slice(-100); chat.queue = chat.queue.slice(-50);
  if (!chat.caption) nextCaption(); else paintChat();
}
function receiveChat(value, context) {
  if (!currentChat(context) || value.gameId !== context.gameId || !Number.isSafeInteger(value.seq) || !Array.isArray(value.messages)) return false;
  if (value.seq < chat.seq) {
    if (value.message && !value.duplicate && chat.messages.some(message => message.id === value.message.id)) { queueCaptions([value.message]); return true; }
    return false;
  }
  const initial = !chat.ready;
  const added = initial && !value.message ? [] : value.messages.filter(message => message.seq > chat.seq);
  if (value.message && !value.duplicate && !added.some(message => message.id === value.message.id)) added.push(value.message);
  chat.seq = value.seq; chat.ready = true; chat.messages = value.messages.slice(-50); chat.status = '同桌可见 · 每两秒发送一条 · 白旗只是互动';
  queueCaptions(added);
  return true;
}
function syncChat() {
  const enabled = state.route === 'game' && !document.hidden && chatAvailable();
  if (chat.gameId !== state.game?.id || chat.token !== state.token) {
    clearTimeout(captionTimer); clearTimeout(chatCooldownTimer);
    Object.assign(chat, { gameId: state.game?.id || null, token: state.token, seq: 0, ready: false, messages: [], queue: [], captionIds: [], caption: null, draft: '', retry: null, cooldown: 0, sending: false, status: '正在同步同桌消息…' });
    if (dialog.dataset.chat === 'true') dialog.close();
    chat.generation++; chatPending?.controller.abort();
  }
  if (!enabled) {
    if (chat.active) { chat.active = false; chat.generation++; chatPending?.controller.abort(); }
    clearTimeout(chatTimer); chatTimer = null; clearTimeout(captionTimer); chat.caption = null; chat.queue = [];
    if (dialog.dataset.chat === 'true') dialog.close();
    return;
  }
  if (!chat.active) { chat.active = true; chat.generation++; }
  paintChat();
  if (!chatPending && !chatTimer) pollChat();
}
function pollChat() {
  const context = { ...chatContext(), controller: new AbortController() }; chatPending = context;
  api(`/games/${context.gameId}/chat?userIdHint=${encodeURIComponent(state.user.id)}`, 'GET', undefined, context.token, context.controller.signal)
    .then(value => receiveChat(value, context))
    .catch(error => { if (currentChat(context) && error.name !== 'AbortError') { chat.status = error.message; paintChat(); } })
    .finally(() => {
      if (chatPending === context) chatPending = null;
      if (currentChat(context)) chatTimer = setTimeout(() => { chatTimer = null; pollChat(); }, 2500);
      else syncChat();
    });
}
function openChat() {
  if (!chatAvailable()) return;
  showDialog('同桌聊天', `<ol class="chat-messages" id="chat-messages" aria-live="polite"></ol><form id="chat-form"><label for="chat-text">给这桌家人留句话</label><textarea id="chat-text" rows="3" maxlength="400" placeholder="输入文字，最多 200 字">${escape(chat.draft)}</textarea><div class="chat-compose"><span id="chat-count">${Array.from(chat.draft).length}/200</span><button class="primary" id="chat-send" type="submit">发送</button></div></form>`, '<button data-close-dialog>回到棋盘</button>');
  dialog.dataset.chat = 'true'; paintChat(); dialog.querySelector('#chat-text').focus();
}
async function sendChat(content) {
  if (!chatAvailable() || chat.sending || Date.now() < chat.cooldown) return;
  const context = chatContext(), key = JSON.stringify(content);
  const retry = chat.retry?.key === key && chat.retry.gameId === context.gameId && chat.retry.token === context.token ? chat.retry : { ...context, key, reqId: crypto.randomUUID(), ...content };
  chat.retry = retry; chat.sending = true; paintChat();
  try {
    const value = await api(`/games/${context.gameId}/chat`, 'POST', { reqId: retry.reqId, userIdHint: state.user.id, ...content }, context.token);
    if (!receiveChat(value, context)) return;
    chat.retry = null; chat.cooldown = Date.now() + 2000;
    if (content.text !== undefined) { chat.draft = ''; const input = dialog.querySelector('#chat-text'); if (input) input.value = ''; const counter = dialog.querySelector('#chat-count'); if (counter) counter.textContent = '0/200'; }
  } catch (error) {
    if (currentChat(context)) { chat.status = error.message; toast(error.message); if (error.retryAfterMs) chat.cooldown = Date.now() + error.retryAfterMs; }
  } finally {
    if (context.gameId === chat.gameId && context.token === chat.token) { chat.sending = false; paintChat(); clearTimeout(chatCooldownTimer); chatCooldownTimer = setTimeout(paintChat, Math.max(0, chat.cooldown - Date.now())); }
  }
}
function undoMarkup(game, color) {
  if (!game.undo) return '';
  const mine = game.undo.requesterId === state.user.id;
  return `<section class="undo-box"><p>${mine ? '悔棋申请已发出，等待对方同意。' : '对方申请撤回自己上一手，之后的回应也将撤回。'}</p>${color && !mine ? '<div class="segmented"><button data-action="undo-accept">同意悔棋</button><button data-action="undo-reject">拒绝</button></div>' : ''}<small>申请期间继续计时，15 秒后失效。</small></section>`;
}
function gameSettingsMarkup() {
  const g = state.game, color = playerColor();
  if (!g) return '';
  return `<article class="card game-control-card"><h3>${g.mode === 'ai' ? '与 AI 对弈' : `${String(g.tableId).padStart(2, '0')} 号棋桌`}</h3><span class="badge">${color ? sideName(color) + '棋手' : '观棋中'}</span><div class="game-status ${g.status === 'finished' ? 'finished' : ''}">${escape(gameStatus(g, color))}</div>${drawMarkup(g, color)}${undoMarkup(g, color)}<div class="game-buttons">${g.status === 'waiting' && color ? `<button class="primary" data-action="ready" ${g.ready[color] ? 'disabled' : ''}>${g.ready[color] ? '已准备' : g.ownerId === state.user.id ? '设置规则并准备' : '同意规则并准备'}</button>` : ''}${g.status === 'active' && color ? `<button data-action="undo" ${g.undo || !g.history.some(item => item.color === color) ? 'disabled' : ''}>申请悔棋</button><button data-action="draw">和棋</button><button class="danger" data-action="resign">认输</button>` : ''}${g.status === 'finished' && color ? '<button class="primary" data-action="rematch">再来一局</button>' : ''}<button data-action="flip" ${color ? 'disabled' : ''}>${color ? '自己一方在下' : '翻转棋盘'}</button><button data-action="leave-game">返回${g.mode === 'ai' ? '首页' : '大厅'}</button></div><p class="setup-note">${g.status === 'active' && color ? g.mode === 'ai' ? '离开后计时继续，可从首页继续本局。成功新开 AI 对局或加入另一棋桌，会自动结束本局并判你负。' : '离开后计时继续，选择原棋桌可回到席位。成功新开 AI 对局或加入另一棋桌，会自动结束本局并判你负。' : '查看设置不会离开棋桌。'}</p></article><article class="card"><h3>计时与规则</h3><p class="small muted">${escape(gameSummary(g.timeControl))}</p><div class="clock-details">${['red', 'black'].map(side => `<div class="clock-detail-row"><span>${sideName(side)}</span><strong data-clock="${side}">—</strong><small data-used="${side}">累计 00:00</small></div>`).join('')}</div>${g.mode === 'ai' ? `<div class="info-pair"><span>AI 落子来源</span><strong>${g.aiSource === 'deepseek' ? 'DeepSeek' : '本地引擎'}</strong></div>${g.aiDetail ? `<p class="small muted">${escape(g.aiDetail)}</p>` : ''}` : ''}<p class="rule-note">双方分别累计用时。超时自动走棋，悔棋不退已用时间。</p><button class="text-button" data-action="rules">查看规则说明</button></article><article class="card"><h3>走棋记录 · ${g.history.length} 手</h3>${g.history.length ? `<ol class="history-list">${g.history.slice(-20).map((item, i) => `<li><span class="move-number">${Math.max(0, g.history.length - 20) + i + 1}</span><span class="move-color ${item.color}">${sideName(item.color)}</span><span>${escape(item.notation || moveLabel(item.move))}</span>${item.source === 'auto' ? '<span class="auto">系统代走</span>' : ''}</li>`).join('')}</ol>` : '<p class="empty-history">落子后，记录会出现在这里。</p>'}</article>${g.mode === 'pvp' ? `<article class="card"><h3>同桌家人</h3><p class="spectator-names">${g.spectators?.length ? g.spectators.map(user => escape(user.name)).join('、') + ' 正在观棋' : '暂时没有旁观者'}</p><p class="rule-note">同桌棋手和旁观者可以文字交流，并发送握手、点赞等互动。白旗只是互动，不会认输。</p><button data-route="game">回到棋盘聊天</button></article>` : ''}`;
}
function drawMarkup(game, color) {
  if (!game.draw) return '';
  const mine = game.draw.requesterId === state.user.id;
  return `<section class="undo-box"><p>${mine ? '和棋申请已发出，等待对方同意。' : '对方申请和棋。是否同意结束本局？'}</p>${!mine && color ? '<div class="segmented"><button data-action="draw-accept">同意和棋</button><button data-action="draw-reject">继续对弈</button></div>' : ''}<small>申请期间继续计时，15 秒后失效。</small></section>`;
}
function moveLabel(move) { return move ? `${String.fromCharCode(97 + move.from % 9)}${9 - Math.floor(move.from / 9)} → ${String.fromCharCode(97 + move.to % 9)}${9 - Math.floor(move.to / 9)}` : ''; }
function duration(ms) { const seconds = Math.max(0, Math.ceil((ms || 0) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function tick() {
  const g = state.game; if (!g || !['game', 'settings'].includes(state.route)) return;
  const now = Date.now() + state.serverOffset;
  for (const color of ['red', 'black']) {
    const clock = g.clock?.[color]; if (!clock) continue;
    const active = g.status === 'active' && g.turn === color;
    const used = clock.usedMs + (active ? Math.max(0, now - g.serverNow) : 0);
    const el = app.querySelector(`[data-clock="${color}"]`);
    if (el) el.textContent = g.status === 'active' && active ? (g.clock.deadline == null ? '不限时' : duration(g.clock.deadline - now)) : clock.totalRemainingMs != null && g.timeControl.mode !== 'rapid' ? duration(Math.max(0, g.timeControl.totalSeconds * 1000 - used)) : '—';
    const usedEl = app.querySelector(`[data-used="${color}"]`); if (usedEl) usedEl.textContent = `累计 ${duration(used)}`;
  }
}
function playMoveSound() {
  if (localStorage.getItem('gouge.sound') !== 'true') return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  const ctx = state.audioContext ||= new Audio();
  ctx.resume().then(() => {
    const oscillator = ctx.createOscillator(), gain = ctx.createGain(), time = ctx.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(680, time); oscillator.frequency.exponentialRampToValueAtTime(180, time + 0.09);
    gain.gain.setValueAtTime(0.05, time); gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(time); oscillator.stop(time + 0.11);
  }).catch(() => {});
}
function cancelMotion() {
  clearTimeout(motionTimer); motionQueue.length = 0; motion = null;
  motionAnimations.forEach(animation => animation.cancel()); motionAnimations = [];
}
function beginMotion() {
  motion = motionQueue.shift() || null;
  if (!motion) return;
  motion.startedAt = performance.now();
  motionTimer = setTimeout(() => {
    motionAnimations.forEach(animation => animation.cancel()); motionAnimations = []; motion = null;
    beginMotion();
    if (state.route === 'game') render();
  }, motion.captured ? 1150 : 800);
}
function receiveGame(game) {
  const previous = state.game;
  if (previous?.id === game.id && (game.version < previous.version || (game.version === previous.version && game.serverNow < previous.serverNow))) return;
  const frame = confirmedMove(previous, game);
  const changedHistory = previous && (previous.id !== game.id || previous.history.length !== game.history.length || previous.history.at(-1)?.at !== game.history.at(-1)?.at);
  if (changedHistory && !frame) cancelMotion();
  if (frame && state.route === 'game') playMoveSound();
  state.game = game; state.serverOffset = game.serverNow - Date.now();
  if (frame && state.route === 'game' && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    motionQueue.push(frame);
    if (motionQueue.length > 2) cancelMotion();
    else if (!motion) beginMotion();
  }
  if (game.status === 'finished' && previous?.status !== 'finished' && !frame) cancelMotion();
  if (state.selected !== null && !game.legalMoves.some(move => move.from === state.selected)) state.selected = null;
  if (state.route === 'game') render();
  else if (state.route === 'settings') { const section = app.querySelector('#game-settings'); if (section) { section.innerHTML = gameSettingsMarkup(); tick(); } }
}
async function refreshGame() { if (state.game) receiveGame((await api(`/games/${state.game.id}`)).game); }
async function enterGame(id) { cancelMotion(); state.selected = null; state.flipped = false; state.game = null; state.route = 'game'; localStorage.setItem('gouge.lastGame', id); receiveGame((await api(`/games/${id}`)).game); state.socket?.readyState === 1 && state.socket.send(JSON.stringify({ type: 'subscribe', gameId: id })); history.replaceState(null, '', '#game'); render(); }
async function navigate(route) {
  if (['game', 'settings'].includes(state.route) && !['game', 'settings'].includes(route) && state.game?.mode === 'pvp') {
    const keep = playerColor() && state.game.status === 'active';
    await api(`/tables/${state.game.tableId}/leave`, 'POST', { gameId: state.game.id });
    if (!keep) { state.game = null; localStorage.removeItem('gouge.lastGame'); }
  }
  state.route = route; state.selected = null; history.replaceState(null, '', `#${route}`);
  if (route === 'lobby' && state.user) state.tables = (await api('/lobby')).tables;
  if (['game', 'settings'].includes(route) && state.game) await refreshGame();
  render();
}
function openSocket() {
  if (!state.token || state.socket?.readyState === 0 || state.socket?.readyState === 1) return;
  clearTimeout(state.reconnect);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.onopen = () => { updateHeader(); if (state.game) socket.send(JSON.stringify({ type: 'subscribe', gameId: state.game.id })); };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'lobby') { state.tables = message.tables; if (state.route === 'lobby') render(); }
    if (message.type === 'game' && message.game.id === state.game?.id) receiveGame(message.game);
  };
  socket.onclose = () => { updateHeader(); if (state.token) state.reconnect = setTimeout(openSocket, 1800); };
  socket.onerror = () => {};
}
async function gameAction(type, data = {}) {
  const game = state.game;
  receiveGame((await api(`/games/${game.id}/action`, 'POST', { type, version: game.version, turnId: game.turnId, operationId: crypto.randomUUID(), ...data })).game);
  state.selected = null;
}
function showDialog(title, body, buttons = '<button class="primary" data-close-dialog>知道了</button>') { delete dialog.dataset.chat; dialog.innerHTML = `<h3>${title}</h3>${body}<div class="segmented">${buttons}</div>`; dialog.showModal(); }
function showRules() { showDialog('这一盘的家庭规则', '<p>基础走棋采用中国象棋规则。红方先行，不能让自己的将帅处于被将状态。</p><p>双方分别累计思考时间。总额度用尽后进入每手限时；普通每手限制同时开启时，两个截止时间取较早者。快棋按每手倒计时。</p><p>超时后系统代走一手合法棋，不直接判负。没有合法走法时按规则结束对局。</p><p>悔棋需要对方同意，回到申请者自己上一手之前，也撤回对方随后一手。已经思考的时间不退还。申请期间继续计时，有新落子则申请失效。</p><p>复杂棋例的实际验证范围请查项目中的 docs/RULES.md。</p>'); }
document.addEventListener('click', event => {
  const el = event.target.closest('button,a'); if (!el) return;
  if (el.dataset.route) { event.preventDefault(); task(() => navigate(el.dataset.route)); }
  if (el.dataset.closeDialog !== undefined) { pendingLeave = null; pendingResign = null; dialog.close(); }
  if (el.dataset.difficulty) { const time = readTime('ai'); localStorage.setItem('gouge.time', JSON.stringify(time)); state.difficulty = Number(el.dataset.difficulty); renderAI(); }
  if (el.dataset.color) { const time = readTime('ai'); localStorage.setItem('gouge.time', JSON.stringify(time)); state.humanColor = el.dataset.color; renderAI(); }
  if (el.dataset.join) task(async () => { await enterGame((await api(`/tables/${el.dataset.join}/join`, 'POST', {})).gameId); });
  if (el.dataset.watch) task(async () => { await enterGame((await api(`/tables/${el.dataset.watch}/watch`, 'POST', {})).gameId); });
  if (el.dataset.cell !== undefined) {
    const index = Number(el.dataset.cell), g = state.game, color = playerColor();
    if (!color || g.status !== 'active' || g.turn !== color || state.busy) return;
    if (motion) { cancelMotion(); render(); }
    const move = state.selected !== null && g.legalMoves.find(candidate => candidate.from === state.selected && candidate.to === index);
    if (move) { task(async () => { await gameAction('move', { moveId: move.id }); }); return; }
    if (g.board[index]?.color === color) { state.selected = state.selected === index ? null : index; render(); }
    else if (state.selected !== null) toast('这个位置不能落子，请选择标记的合法落点。');
  }
  const action = el.dataset.action;
  if (action === 'rules') showRules();
  if (action === 'flip' && !playerColor()) { cancelMotion(); state.flipped = !state.flipped; state.selected = null; toast('棋盘方向已翻转，返回棋盘查看。'); }
  if (action === 'chat-open') openChat();
  if (el.dataset.reaction) sendChat({ reaction: el.dataset.reaction });
  if (action === 'retry') location.reload();
  if (action === 'refresh-lobby') task(async () => { state.tables = (await api('/lobby')).tables; render(); });
  if (action === 'undo') task(() => gameAction('undo-request'));
  if (action === 'draw') showDialog('和棋', '<p>可以向对方申请和棋，也可以在满足自然限着规则时提和。申请期间继续计时，有新落子则申请失效。</p>' + (state.game.mode === 'ai' ? '<p>家庭 AI 对局采用固定策略：同意玩家的协商和棋申请。</p>' : ''), '<button data-close-dialog>取消</button><button data-action="draw-claim">自然限着提和</button><button class="primary" data-action="draw-request">申请和棋</button>');
  if (action === 'draw-claim' || action === 'draw-request') task(async () => { dialog.close(); await gameAction(action); });
  if (action === 'draw-accept' || action === 'draw-reject') task(() => gameAction('draw-respond', { requestId: state.game.draw.id, accept: action === 'draw-accept' }));
  if (action === 'undo-accept' || action === 'undo-reject') task(() => gameAction('undo-respond', { requestId: state.game.undo.id, accept: action === 'undo-accept' }));
  if (action === 'resign' && state.game?.status === 'active' && playerColor()) {
    pendingResign = { gameId: state.game.id, userId: state.user.id, color: playerColor() };
    showDialog('确认认输？', '<p>认输后，这一局会立即结束。</p>', '<button data-close-dialog>继续下棋</button><button class="danger" data-action="confirm-resign">确认认输</button>');
  }
  if (action === 'confirm-resign') task(async () => {
    const pending = pendingResign; pendingResign = null; dialog.close();
    if (pending && state.game?.id === pending.gameId && state.user?.id === pending.userId && playerColor() === pending.color && state.game.status === 'active') await gameAction('resign');
  });
  if (action === 'rematch') task(async () => { await gameAction('rematch'); });
  if (action === 'ready') {
    if (state.game.ownerId === state.user.id) showDialog('确认本桌计时', timeForm('ready', state.game.timeControl) + '<p class="setup-note">对方确认规则并准备后，才会正式开始计时。</p>', '<button data-close-dialog>取消</button><button class="primary" data-action="confirm-ready">设置并准备</button>');
    else task(async () => { receiveGame((await api(`/games/${state.game.id}/ready`, 'POST', {})).game); });
  }
  if (action === 'confirm-ready') task(async () => { const timeControl = readTime('ready'); receiveGame((await api(`/games/${state.game.id}/ready`, 'POST', { timeControl })).game); dialog.close(); });
  if (action === 'leave-game' && state.game) {
    const game = state.game;
    if (game.status === 'active' && playerColor()) {
      pendingLeave = { gameId: game.id, userId: state.user.id, color: playerColor() };
      showDialog('离开当前棋盘？', `<p>返回${game.mode === 'ai' ? '首页' : '大厅'}后计时继续，可以回来继续本局。</p><p>成功新开 AI 对局或加入另一棋桌后，本局会自动结束并判你负。</p>`, '<button data-close-dialog>继续下棋</button><button class="primary" data-action="confirm-leave">继续离开</button>');
    } else task(() => navigate(game.mode === 'ai' ? 'home' : 'lobby'));
  }
  if (action === 'confirm-leave') task(async () => {
    const pending = pendingLeave, game = state.game; pendingLeave = null; dialog.close();
    if (!pending || game?.id !== pending.gameId || state.user?.id !== pending.userId || playerColor() !== pending.color || game.status !== 'active') return;
    await navigate(game.mode === 'ai' ? 'home' : 'lobby');
  });
  if (action === 'logout') {
    if (state.game?.status === 'active' && playerColor()) showDialog('先结束当前对局', '<p>请先回到棋桌认输或完成对局，再退出账号。返回首页不会停止对局计时。</p>');
    else { state.token = null; state.user = null; state.game = null; clearTimeout(state.reconnect); state.socket?.close(); localStorage.removeItem('gouge.token'); localStorage.removeItem('gouge.lastGame'); state.route = 'home'; render(); }
  }
});
document.addEventListener('change', event => {
  const prefix = event.target.dataset.timeMode;
  if (prefix) { document.getElementById(`${prefix}-normal`).hidden = event.target.value !== 'normal'; document.getElementById(`${prefix}-rapid`).hidden = event.target.value !== 'rapid'; }
});
document.addEventListener('keydown', event => {
  const index = document.activeElement?.dataset.cell;
  if (index === undefined || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault(); const flip = boardFlipped() ? -1 : 1;
  const direction = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[event.key] * flip;
  const next = Number(index) + direction;
  if (next >= 0 && next < 90 && (Math.abs(direction) === 9 || Math.floor(next / 9) === Math.floor(Number(index) / 9))) app.querySelector(`[data-cell="${next}"]`)?.focus();
});
document.addEventListener('submit', event => {
  event.preventDefault(); const id = event.target.id;
  if (id === 'chat-form') {
    const text = dialog.querySelector('#chat-text').value.trim();
    if (!text || Array.from(text).length > 200) { toast('请输入 1 至 200 个字符。'); return; }
    sendChat({ text }); return;
  }
  task(async () => {
    if (id === 'login-form') { const response = await api('/login/dev', 'POST', { name: document.querySelector('#login-name').value.trim() }); state.token = response.token; state.user = response.user; localStorage.setItem('gouge.token', state.token); openSocket(); await navigate(state.route); }
    if (id === 'ai-form') { const timeControl = readTime('ai'); localStorage.setItem('gouge.time', JSON.stringify(timeControl)); await enterGame((await api('/ai', 'POST', { difficulty: state.difficulty, humanColor: state.humanColor, timeControl })).gameId); }
    if (id === 'preferences-form') { localStorage.setItem('gouge.time', JSON.stringify(readTime('prefs'))); localStorage.setItem('gouge.sound', String(document.querySelector('#sound-on').checked)); toast('下一盘的默认计时已保存。'); }
    if (id === 'profile-form') {
      const body = { name: document.querySelector('#profile-name').value.trim() }, file = document.querySelector('#avatar-file').files[0];
      if (file) { if (file.size > 1024 * 1024) throw new Error('头像图片请控制在 1 MB 以内。'); const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); body.avatar = (await api('/avatar', 'POST', { dataUrl })).avatar; }
      state.user = (await api('/me', 'PATCH', body)).user; render(); toast('个人资料已保存。');
    }
  });
});
async function start() {
  try {
    state.health = await api('/health');
    if (state.token) { try { state.user = (await api('/me')).user; } catch { state.token = null; localStorage.removeItem('gouge.token'); } }
    if (state.user) {
      openSocket(); state.tables = (await api('/lobby')).tables;
      const saved = localStorage.getItem('gouge.lastGame');
      if (saved) { try { state.game = (await api(`/games/${saved}`)).game; state.serverOffset = state.game.serverNow - Date.now(); if (state.socket?.readyState === 1) state.socket.send(JSON.stringify({ type: 'subscribe', gameId: state.game.id })); } catch { localStorage.removeItem('gouge.lastGame'); } }
    }
    const route = location.hash.slice(1); state.route = ['home', 'ai', 'lobby', 'settings', 'game'].includes(route) && (route !== 'game' || state.game) ? route : state.game ? 'game' : 'home';
    render();
  } catch (error) { app.innerHTML = `<section class="card error-card"><h2>棋馆还没有连接上</h2><p class="rule-note">${escape(error.message)}。请确认启动了本地对战服务。</p><button class="primary full" data-action="retry">重新连接</button></section>`; }
}
document.addEventListener('input', event => { if (event.target.id === 'chat-text') { chat.draft = event.target.value; dialog.querySelector('#chat-count').textContent = `${Array.from(chat.draft).length}/200`; } });
dialog.addEventListener('close', () => { delete dialog.dataset.chat; });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelMotion(); if (state.route === 'game') render(); } syncChat(); });
window.addEventListener('pagehide', () => { chat.active = false; chat.generation++; clearTimeout(chatTimer); chatPending?.controller.abort(); clearTimeout(captionTimer); clearTimeout(chatCooldownTimer); });
window.addEventListener('resize', () => { if (motion) { cancelMotion(); render(); } });
setInterval(tick, 500);
window.addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  if (['home', 'ai', 'lobby', 'settings', 'game'].includes(route) && (route !== 'game' || state.game)) task(() => navigate(route));
});
setInterval(() => { if (['game', 'settings'].includes(state.route) && state.game && state.socket?.readyState !== 1 && !state.busy) refreshGame().catch(() => {}); }, 5000);
setInterval(() => { if (state.socket?.readyState === 1) state.socket.send(JSON.stringify({ type: 'ping' })); }, 20000);
start();
