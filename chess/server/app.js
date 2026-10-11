import http from 'node:http';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer, WebSocket } from 'ws';
import * as chess from '../core/xiangqi.js';
import { normalizeTimeControl, getDeadline, clockSnapshot } from '../core/clock.js';
import { chooseAiMove } from './ai.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const other = color => color === 'red' ? 'black' : 'red';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const publicUser = user => user ? { id: user.id, name: user.name, avatar: user.avatar || '', kind: user.kind || 'human' } : null;
const nameOf = name => typeof name === 'string' && name.trim() ? name.trim().slice(0, 24) : '家人';

export function voiceSignature(appId, groupId, nonceStr, timeStamp, sessionKey) {
  return createHmac('sha256', sessionKey).update([appId, groupId, nonceStr, String(timeStamp)].sort().join('')).digest('hex');
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const devMode = env.DEV_MODE !== 'false';
  const storage = options.storage;
  if (env.CLOUD_STORAGE === 'true' && devMode) throw new Error('云托管必须显式 DEV_MODE=false，不提供开发账号');
  if (env.CLOUD_STORAGE === 'true' && (!storage || storage.kind !== 'cloudbase')) {
    throw new Error('云持久化须先成功初始化，不能退回容器本地文件');
  }
  if (storage && !storage.initialState) throw new Error('持久化初始化未返回状态');
  const privateContainer = env.CLOUD_CONTAINER_PRIVATE === 'true' && env.CLOUD_STORAGE === 'true' && !devMode;
  const now = options.now || Date.now;
  const fetchImpl = options.fetch || fetch;
  const config = {
    devMode, host: options.host || env.HOST || '127.0.0.1',
    appId: env.WECHAT_APP_ID || '', appSecret: env.WECHAT_APP_SECRET || '',
    voiceEnabled: env.WECHAT_VOICE_ENABLED === 'true',
    ai: { apiKey: env.DEEPSEEK_API_KEY || '', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL || 'deepseek-flash', timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS) || 6000 },
    sessionMs: 30 * 24 * 60 * 60 * 1000,
  };
  if (devMode && env.ALLOW_LAN_DEV !== 'true' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error('开发模式只允许绑定本机地址；可信局域网调试须显式 ALLOW_LAN_DEV=true，公网须 DEV_MODE=false');
  }
  if (!devMode && (!config.appId || !config.appSecret || (!env.PUBLIC_BASE_URL && !privateContainer))) {
    throw new Error('正式模式须配置 WECHAT_APP_ID、WECHAT_APP_SECRET 和 HTTPS PUBLIC_BASE_URL');
  }
  if (!devMode && env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('正式模式 PUBLIC_BASE_URL 必须为 HTTPS');
  const dataDir = storage ? null : resolve(options.dataDir || env.DATA_DIR || resolve(ROOT, '.data'));
  if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stateFile = dataDir ? resolve(dataDir, 'state.json') : null;
  let state = storage ? structuredClone(storage.initialState) : stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { users: {}, sessions: {}, games: {}, tables: Array(6).fill(null) };
  state.avatars ||= {};
  let localChat = null;
  if (devMode && !storage) {
    const { APP_ID, createChatHandler, createLocalStore, authorizeMember } = createRequire(import.meta.url)('../cloudfunctions/gouge-chess-chat/handler.cjs');
    const chatFile = resolve(dataDir, 'chat.json');
    const chatStore = createLocalStore({ initialState: existsSync(chatFile) ? JSON.parse(readFileSync(chatFile, 'utf8')) : undefined,
      authorize: target => {
        const record = target.userIdHint ? state.users[target.userIdHint] : Object.values(state.users).find(value => (value.openid || `dev:${value.id}`) === target.identity.openid);
        return authorizeMember({ identity: target.identity, user: record ? { ...record, openid: record.openid || `dev:${record.id}` } : null,
          game: state.games[target.gameId], authority: { tables: state.tables } });
      },
      persist: value => {
        writeFileSync(`${chatFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
        renameSync(`${chatFile}.tmp`, chatFile);
      },
    });
    localChat = createChatHandler({ store: chatStore, now,
      identity: context => ({ appId: APP_ID, openid: state.users[context.userId]?.openid || `dev:${context.userId}` }),
      // 本机DEV聊天不调用微信审核；正式聊天只使用受信WXContext云函数。
      checkText: options.chatTextCheck || (async () => true),
    });
  }
  const clients = new Map();
  const pendingAI = new Map();
  const loginRates = new Map();
  const pendingAvatars = new Map();
  let closed = false;
  let saveQueue = Promise.resolve(), storageFailure = null, saveScheduled = false;

  function storageHealthy() { return !storageFailure && (!storage || !storage.healthy || storage.healthy()); }
  function storageCheck() {
    if (!storageHealthy()) fail(503, 'STORAGE_UNAVAILABLE', '棋局保存服务暂时不可用，请稍后重新连接');
  }
  async function flush() { await saveQueue; storageCheck(); }
  function prunePendingAvatars() {
    for (const [key, values] of pendingAvatars) {
      const remaining = values.filter(value => value.expiresAt > now());
      if (remaining.length) pendingAvatars.set(key, remaining); else pendingAvatars.delete(key);
    }
  }

  function persist() {
    if (storage) {
      // 落子与 operationId 在同一次同步操作内提交为一个事务。
      if (saveScheduled) return;
      saveScheduled = true;
      saveQueue = saveQueue.then(() => {
        saveScheduled = false; storageCheck(); return storage.save(structuredClone(state));
      }).catch(error => {
        saveScheduled = false;
        storageFailure = error;
        for (const abort of pendingAI.values()) abort.abort();
        throw Object.assign(new Error('棋局保存服务暂时不可用，请稍后重新连接'), { status: 503, code: 'STORAGE_UNAVAILABLE' });
      });
      saveQueue.catch(() => {});
      return;
    }
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, stateFile);
  }
  function user(id) { return publicUser(state.users[id]); }
  function playerColor(game, userId) { return ['red', 'black'].find(color => game.seats[color] === userId); }
  function isMember(game, userId) { return Boolean(playerColor(game, userId) || game.spectators.includes(userId)); }
  function canRead(game, userId) { return isMember(game, userId) || (game.status === 'finished' && game.participants?.includes(userId)); }
  function requireGame(id, userId) {
    const game = state.games[id];
    if (!game) fail(404, 'GAME_NOT_FOUND', '棋局不存在');
    if (!canRead(game, userId)) fail(403, 'NOT_MEMBER', '请先入座或观棋');
    return game;
  }
  function freshGame(tableId = null, mode = 'pvp') {
    const game = { id: randomUUID(), tableId, mode, status: 'waiting', board: chess.createInitialBoard(), turn: 'red',
      version: 0, turnId: randomUUID(), ownerId: null, seats: { red: null, black: null }, ready: { red: false, black: false },
      timeControl: normalizeTimeControl({}), used: { red: 0, black: 0 }, turnStartedAt: null,
      history: [], lastMove: null, outcome: null, undo: null, draw: null, spectators: [], difficulty: null,
      aiThinking: false, aiSource: null, aiDetail: null, operations: {}, voice: {}, participants: [], resultSeats: null };
    state.games[game.id] = game;
    if (tableId) state.tables[tableId - 1] = game.id;
    return game;
  }
  function tableGame(tableId) {
    if (!Number.isInteger(tableId) || tableId < 1 || tableId > 6) fail(400, 'BAD_TABLE', '棋桌编号须为 1 至 6');
    const current = state.games[state.tables[tableId - 1]];
    return !current || (current.status === 'finished' && !current.seats.red && !current.seats.black) ? freshGame(tableId) : current;
  }
  function expireVoice(game, time = now()) {
    for (const [id, expiry] of Object.entries(game.voice)) if (expiry <= time) delete game.voice[id];
  }
  function snapshot(game) {
    expireVoice(game);
    const serverNow = now();
    return { id: game.id, tableId: game.tableId, mode: game.mode, status: game.status, board: game.board, turn: game.turn,
      version: game.version, turnId: game.turnId, ownerId: game.ownerId,
      seats: { red: user(game.seats.red), black: user(game.seats.black) }, ready: game.ready,
      timeControl: game.timeControl, clock: clockSnapshot(game.timeControl, game.used, game.turn,
        game.status === 'active' ? game.turnStartedAt : null, serverNow),
      history: game.history.map(entry => ({ move: entry.move, color: entry.color, notation: entry.notation, source: entry.source, at: entry.at,
        captured: entry.boardBefore?.[entry.move.to] || entry.captured || null })),
      lastMove: game.lastMove, outcome: game.outcome, resultSeats: game.resultSeats || null, undo: game.undo, draw: game.draw,
      spectators: game.spectators.map(user), difficulty: game.difficulty, aiThinking: game.aiThinking,
      aiSource: game.aiSource, aiDetail: game.aiDetail, serverNow,
      legalMoves: game.status === 'active' ? chess.getLegalMoves(game.board, game.turn) : [],
      voiceMembers: Object.keys(game.voice).map(user), ruleCoverage: chess.RULE_COVERAGE };
  }
  function lobby() {
    return Array.from({ length: 6 }, (_, index) => {
      const game = state.games[state.tables[index]];
      return { id: index + 1, status: game?.status || 'waiting',
        seats: { red: user(game?.seats.red), black: user(game?.seats.black) },
        spectatorCount: game?.spectators.length || 0, gameId: game?.id || null };
    });
  }
  function send(ws, value) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }
  function broadcast(game, lobbyChanged = false) {
    const snapshotValue = { type: 'game', game: snapshot(game) };
    const value = storage ? structuredClone(snapshotValue) : snapshotValue;
    const recipients = [...clients].filter(([, client]) => client.gameId === game.id && canRead(game, client.userId)).map(([ws]) => ws);
    const tablesValue = lobbyChanged ? { type: 'lobby', tables: lobby() } : null;
    const tables = storage ? structuredClone(tablesValue) : tablesValue;
    const publish = () => {
      for (const ws of recipients) send(ws, value);
      if (tables) for (const ws of clients.keys()) send(ws, tables);
    };
    if (storage) saveQueue.then(() => { if (storageHealthy()) publish(); }).catch(() => {});
    else publish();
  }
  function cancelAI(game) {
    pendingAI.get(game.id)?.abort(); pendingAI.delete(game.id); game.aiThinking = false;
  }
  function settle(game, time) {
    if (game.status === 'active') game.used[game.turn] += Math.max(0, time - game.turnStartedAt);
  }
  function recordResult(game, outcome) {
    game.participants = [...new Set([...(game.participants || []), ...Object.values(game.seats).filter(Boolean)])];
    game.resultSeats = { red: user(game.seats.red), black: user(game.seats.black) };
    game.outcome = { ...outcome, winnerId: outcome.winner ? game.seats[outcome.winner] : null,
      loserId: outcome.winner ? game.seats[other(outcome.winner)] : null };
  }
  function finish(game, outcome, time) {
    settle(game, time); recordResult(game, outcome); game.status = 'finished'; game.undo = null; game.draw = null;
    game.turnStartedAt = null; game.version++; cancelAI(game);
  }
  function releaseSeat(game, userId) {
    const color = playerColor(game, userId);
    if (!color) return;
    game.seats[color] = null; game.ownerId = game.seats.red || game.seats.black;
    game.ready = { red: false, black: false }; delete game.voice[userId]; game.version++;
  }
  function exitOtherGames(userId, exceptId) {
    const exited = [];
    for (const game of Object.values(state.games)) {
      const color = playerColor(game, userId);
      if (game.id === exceptId || !color) continue;
      due(game);
      if (game.status === 'active') finish(game, { winner: other(color), reason: '重新开局自动离开', rule: '自动退出' }, now());
      releaseSeat(game, userId); exited.push({ game, userId });
    }
    return exited;
  }
  function notifyExits(exited) {
    for (const { game, userId } of exited) {
      broadcast(game, true);
      for (const client of clients.values()) if (client.userId === userId && client.gameId === game.id) client.gameId = null;
    }
  }
  function move(game, candidate, source, time) {
    cancelAI(game); settle(game, time);
    const entry = chess.createHistoryEntry(game.board, candidate, game.turn);
    game.board = chess.applyMove(game.board, candidate);
    game.history.push({ ...entry, source, at: time }); game.lastMove = { from: candidate.from, to: candidate.to };
    game.turn = other(game.turn); game.version++; game.turnId = randomUUID(); game.undo = null; game.draw = null; game.turnStartedAt = time;
    const outcome = chess.getOutcome(game.board, game.turn, game.history);
    if (outcome) { recordResult(game, outcome); game.status = 'finished'; game.turnStartedAt = null; }
    persist(); broadcast(game, game.status === 'finished');
  }
  function due(game, time = now()) {
    let changed = false;
    if (game.undo && game.undo.expiresAt <= time) { game.undo = null; changed = true; }
    if (game.draw && game.draw.expiresAt <= time) { game.draw = null; changed = true; }
    for (let count = 0; game.status === 'active'; count++) {
      const deadline = getDeadline(game.timeControl, game.used[game.turn], game.turnStartedAt);
      if (deadline === null || deadline > time) break;
      if (count > 2000) fail(503, 'RECOVERING', '服务端正在恢复历史计时，请稍后重试');
      const candidate = chess.chooseAutoMove(game.board, game.turn);
      if (!candidate) { finish(game, chess.getOutcome(game.board, game.turn, game.history) ||
        { winner: other(game.turn), reason: '无合法走法', rule: '困毙' }, deadline); changed = true; break; }
      move(game, candidate, 'auto', deadline); changed = true;
    }
    if (changed) { persist(); broadcast(game, game.status === 'finished'); }
  }
  function scheduleAI(game) {
    if (closed || !storageHealthy() || game.status !== 'active' || state.users[game.seats[game.turn]]?.kind !== 'ai' || pendingAI.has(game.id)) return;
    const abort = new AbortController(); pendingAI.set(game.id, abort); game.aiThinking = true;
    const version = game.version, turnId = game.turnId, color = game.turn;
    const deadline = getDeadline(game.timeControl, game.used[color], game.turnStartedAt);
    broadcast(game);
    chooseAiMove({ board: game.board, color, difficulty: game.difficulty, history: game.history,
      config: config.ai, fetchImpl, signal: abort.signal, remainingMs: deadline === null ? Infinity : deadline - now(),
      ...(options.aiOptions || {}) }).then(result => {
      if (closed || abort.signal.aborted || !storageHealthy()) return;
      due(game);
      if (game.status !== 'active' || game.version !== version || game.turnId !== turnId) return;
      const legal = chess.getLegalMoves(game.board, game.turn).find(candidate => candidate.id === result.move?.id);
      if (legal) { game.aiSource = result.source; game.aiDetail = result.detail; move(game, legal, 'ai', now()); }
      else { finish(game, chess.getOutcome(game.board, game.turn, game.history) ||
        { winner: other(color), reason: '无合法走法', rule: '困毙' }, now()); persist(); broadcast(game, true); }
    }).catch(() => {
      if (!abort.signal.aborted && storageHealthy() && game.status === 'active' && game.version === version) {
        due(game); const legal = chess.chooseAutoMove(game.board, game.turn);
        if (game.version === version && legal) { game.aiSource = 'fallback'; game.aiDetail = 'AI 选择失败，使用本地代走'; move(game, legal, 'ai', now()); }
      }
    }).finally(() => {
      if (pendingAI.get(game.id) === abort) { pendingAI.delete(game.id); game.aiThinking = false; }
      if (!closed) scheduleAI(game);
    });
  }
  function tick() {
    if (!storageHealthy() || closed) return;
    for (const game of Object.values(state.games)) { expireVoice(game); due(game); scheduleAI(game); }
  }
  function login(userRecord) {
    const token = randomBytes(32).toString('hex');
    state.sessions[digest(token)] = { userId: userRecord.id, expiresAt: now() + config.sessionMs };
    state.users[userRecord.id] = userRecord; persist();
    return { token, user: publicUser(userRecord) };
  }
  function authenticate(token) {
    const session = token && state.sessions[digest(token)];
    if (!session || session.expiresAt <= now() || !state.users[session.userId]) fail(401, 'LOGIN_REQUIRED', '登录已失效，请重新登录');
    return session.userId;
  }
  function action(game, userId, body) {
    due(game);
    const color = playerColor(game, userId);
    if (!color) fail(403, 'NOT_PLAYER', '旁观者不能操作棋局');
    if (typeof body.operationId !== 'string' || !body.operationId || body.operationId.length > 128) fail(400, 'OPERATION_REQUIRED', '缺少操作编号');
    const key = `${userId}:${body.operationId}`;
    const fingerprint = digest(JSON.stringify(body));
    if (game.operations[key]) {
      if (game.operations[key] !== fingerprint) fail(409, 'OPERATION_REUSED', '操作编号不能用于不同操作');
      return;
    }
    if (body.version !== game.version || body.turnId !== game.turnId) fail(409, 'STALE_STATE', '棋局已更新，请按最新棋盘操作');
    if (body.type !== 'rematch' && game.status !== 'active') fail(409, 'GAME_NOT_ACTIVE', '棋局尚未开始或已经结束');
    if (body.type === 'move') {
      if (game.turn !== color) fail(409, 'NOT_YOUR_TURN', '尚未轮到你走棋');
      const legal = chess.getLegalMoves(game.board, color).find(candidate => candidate.id === body.moveId);
      if (!legal) fail(400, 'ILLEGAL_MOVE', '这一步不符合象棋规则');
      move(game, legal, 'human', now());
    } else if (body.type === 'undo-request') {
      if (game.undo) fail(409, 'UNDO_PENDING', '已有悔棋申请等待回应');
      const targetPly = game.history.findLastIndex(entry => entry.color === color);
      if (targetPly < 0) fail(400, 'NOTHING_TO_UNDO', '你还没有走棋');
      game.undo = { id: randomUUID(), requesterId: userId, expiresAt: now() + 15000, targetPly, version: game.version };
      if (game.mode === 'ai') acceptUndo(game);
    } else if (body.type === 'undo-respond') {
      if (!game.undo || game.undo.id !== body.requestId) fail(409, 'UNDO_EXPIRED', '悔棋申请已经失效');
      if (game.undo.requesterId === userId) fail(403, 'SELF_APPROVAL', '需由对方回应悔棋申请');
      if (typeof body.accept !== 'boolean') fail(400, 'BAD_RESPONSE', '请明确同意或拒绝');
      if (body.accept) acceptUndo(game); else game.undo = null;
    } else if (body.type === 'draw-claim') {
      const outcome = chess.getDrawClaimOutcome(game.board, game.turn, game.history, color);
      if (!outcome || outcome.winner !== null) fail(400, 'DRAW_NOT_AVAILABLE', '尚未满足自然限着提和条件（提和方超过十次将军须扣除）');
      finish(game, outcome, now());
    } else if (body.type === 'draw-request') {
      if (game.draw) fail(409, 'DRAW_PENDING', '已有和棋申请等待回应');
      game.draw = { id: randomUUID(), requesterId: userId, expiresAt: now() + 15000, version: game.version };
      if (game.mode === 'ai') finish(game, { winner: null, reason: '双方同意和棋（AI 按家庭策略同意）', rule: 'wxf-agreement' }, now());
    } else if (body.type === 'draw-respond') {
      if (!game.draw || game.draw.id !== body.requestId) fail(409, 'DRAW_EXPIRED', '和棋申请已经失效');
      if (game.draw.requesterId === userId) fail(403, 'SELF_APPROVAL', '需由对方回应和棋申请');
      if (typeof body.accept !== 'boolean') fail(400, 'BAD_RESPONSE', '请明确同意或拒绝');
      if (body.accept) finish(game, { winner: null, reason: '双方同意和棋', rule: 'wxf-agreement' }, now());
      else game.draw = null;
    } else if (body.type === 'resign') {
      finish(game, { winner: other(color), reason: '对方认输', rule: '认输' }, now());
    } else if (body.type === 'rematch') {
      if (game.status !== 'finished') fail(409, 'GAME_NOT_FINISHED', '当前对局未结束');
      if (!game.seats.red || !game.seats.black || (game.tableId && state.tables[game.tableId - 1] !== game.id)) {
        fail(409, 'REMATCH_UNAVAILABLE', '对方已离桌，请返回大厅重新入座');
      }
      const opponentId = game.seats[other(color)];
      if (state.users[opponentId]?.kind !== 'ai' && Object.values(state.games).some(value =>
        value.id !== game.id && value.status !== 'finished' && playerColor(value, opponentId))) {
        fail(409, 'OPPONENT_BUSY', '对方正在另一棋局，请返回大厅重新入座');
      }
      const exited = exitOtherGames(userId, game.id);
      cancelAI(game); game.board = chess.createInitialBoard(); game.history = []; game.outcome = null;
      game.resultSeats = null;
      game.lastMove = null; game.undo = null; game.draw = null; game.turn = 'red'; game.version++; game.turnId = randomUUID();
      game.used = { red: 0, black: 0 }; game.ready = { red: false, black: false }; game.status = 'waiting'; game.turnStartedAt = null;
      if (game.mode === 'ai') startGame(game);
      persist(); notifyExits(exited);
    } else fail(400, 'BAD_ACTION', '不支持的棋局操作');
    game.operations[key] = fingerprint;
    if (Object.keys(game.operations).length > 1000) delete game.operations[Object.keys(game.operations)[0]];
    persist(); broadcast(game, true); scheduleAI(game);
  }
  function acceptUndo(game) {
    const entry = game.history[game.undo.targetPly];
    cancelAI(game); settle(game, now()); game.board = entry.boardBefore;
    game.turn = entry.color; game.history = game.history.slice(0, game.undo.targetPly);
    game.lastMove = game.history.at(-1)?.move || null; game.undo = null; game.draw = null; game.version++; game.turnId = randomUUID();
    game.turnStartedAt = now();
  }
  function startGame(game) {
    game.status = 'active'; game.turnStartedAt = now(); game.turnId = randomUUID(); game.version++;
    game.ready = { red: true, black: true };
  }
  async function readBody(req) {
    let data = '', length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 1500000) fail(413, 'TOO_LARGE', '上传内容过大'); data += chunk; }
    if (!data) return {};
    try { const body = JSON.parse(data); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
    catch { fail(400, 'BAD_JSON', '请求内容不是有效 JSON 对象'); }
  }
  async function json(res, status, data, skipFlush = false) {
    const content = JSON.stringify(data);
    if (storage && status < 400 && !skipFlush) await flush();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  }
  function checkOrigin(req) {
    if (!req.headers.origin) return;
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail(403, 'BAD_ORIGIN', '请求来源不允许'); }
    const allowed = (env.ALLOWED_ORIGINS || env.PUBLIC_BASE_URL || '').split(',').filter(Boolean);
    if (!allowed.includes(origin.origin) && !(devMode && (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      (env.ALLOW_LAN_DEV === 'true' && origin.host === req.headers.host)))) {
      fail(403, 'BAD_ORIGIN', '请求来源不允许');
    }
  }
  function loginRate(req) {
    const ip = req.socket.remoteAddress, old = loginRates.get(ip);
    const entry = !old || old.startedAt + 3600000 < now() ? { startedAt: now(), count: 0 } : old;
    if (++entry.count > 120) fail(429, 'RATE_LIMIT', '登录请求过多，请稍后再试');
    loginRates.set(ip, entry);
  }
  async function route(req, res) {
    checkOrigin(req);
    const path = new URL(req.url, 'http://local').pathname;
    if (!path.startsWith('/api/')) return serveStatic(path, res);
    if (req.method === 'GET' && path === '/api/health') return json(res, storageHealthy() ? 200 : 503, { ok: storageHealthy(), devMode,
      deepseekConfigured: Boolean(config.ai.apiKey), wechatConfigured: Boolean(config.appId && config.appSecret),
      voiceConfigured: Boolean(config.voiceEnabled && config.appId && config.appSecret), storage: { kind: storage?.kind || 'local-json', healthy: storageHealthy() }, ruleCoverage: chess.RULE_COVERAGE }, true);
    storageCheck();
    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    storageCheck();
    if (req.method === 'POST' && path === '/api/login/dev') {
      if (!devMode) fail(403, 'DEV_DISABLED', '开发登录已关闭，请使用微信登录');
      loginRate(req);
      return json(res, 200, login({ id: randomUUID(), name: nameOf(body.name), kind: 'human', loginKind: 'dev' }));
    }
    if (req.method === 'POST' && path === '/api/login/wechat') {
      loginRate(req);
      if (!config.appId || !config.appSecret) fail(503, 'WECHAT_UNCONFIGURED', '请先配置微信 AppID 和 AppSecret');
      if (typeof body.code !== 'string' || body.code.length > 256 || !body.code) fail(400, 'BAD_CODE', '缺少微信登录凭证');
      const params = new URLSearchParams({ appid: config.appId, secret: config.appSecret, js_code: body.code, grant_type: 'authorization_code' });
      let remote;
      try {
        const response = await fetchImpl(`https://api.weixin.qq.com/sns/jscode2session?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(); remote = await response.json();
      } catch { fail(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂时不可用'); }
      storageCheck();
      if (remote.errcode || !remote.openid || !remote.session_key) fail(401, 'WECHAT_CODE_INVALID', '微信登录凭证已失效，请重新登录');
      let record = Object.values(state.users).find(record => record.openid === remote.openid);
      record = { ...(record || { id: randomUUID(), name: '家人', kind: 'human' }),
        loginKind: 'wechat', openid: remote.openid, sessionKey: remote.session_key };
      return json(res, 200, login(record));
    }
    const requestToken = req.headers.authorization?.replace(/^Bearer /, '');
    const userId = authenticate(requestToken);
    const chatMatch = /^\/api\/games\/([A-Za-z0-9_-]+)\/chat$/.exec(path);
    if (chatMatch && ['GET', 'POST'].includes(req.method)) {
      if (!localChat) fail(503, 'CHAT_CLOUD_FUNCTION_REQUIRED', '正式棋桌聊天请使用小程序云函数');
      const input = req.method === 'GET' ? { userIdHint: new URL(req.url, 'http://local').searchParams.get('userIdHint') || undefined } : body;
      return json(res, 200, await localChat({ ...input, operation: req.method === 'GET' ? 'list' : 'send', gameId: chatMatch[1] }, { userId }));
    }
    if (path === '/api/me' && req.method === 'GET') return json(res, 200, { user: user(userId) });
    if (path === '/api/me' && req.method === 'PATCH') {
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 24)) {
        fail(400, 'BAD_NAME', '昵称需要 1 至 24 个字符');
      }
      if (body.avatar !== undefined && (typeof body.avatar !== 'string' || !(storage ? state.avatars[body.avatar]?.ownerId === userId : /^\/avatars\/[a-f0-9-]+\.(png|jpg|webp)$/.test(body.avatar)))) {
        fail(400, 'BAD_AVATAR', '请使用头像上传接口');
      }
      if (body.name !== undefined) state.users[userId].name = body.name.trim();
      if (body.avatar !== undefined) state.users[userId].avatar = body.avatar;
      persist(); for (const game of Object.values(state.games)) if (canRead(game, userId)) broadcast(game, true);
      return json(res, 200, { user: user(userId) });
    }
    if (path === '/api/avatar' && req.method === 'POST') {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || '');
      if (!match) fail(400, 'BAD_AVATAR', '仅支持 PNG、JPEG 或 WebP 头像');
      const buffer = Buffer.from(match[2], 'base64');
      const valid = match[1] === 'png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        match[1] === 'jpeg' ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 :
        buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
      if (!valid || buffer.length > 1024 * 1024) fail(400, 'BAD_AVATAR', '头像格式无效或超过 1 MB');
      const file = `${randomUUID()}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
      if (storage) {
        let avatar;
        try { avatar = await storage.putAvatar(file, buffer); } catch { fail(503, 'STORAGE_UNAVAILABLE', '头像保存失败，请稍后再试'); }
        storageCheck();
        state.avatars[avatar] = { ownerId: userId }; persist();
        prunePendingAvatars();
        const key = digest(requestToken), pending = (pendingAvatars.get(key) || []).filter(value => value.expiresAt > now());
        pending.push({ fileID: avatar, expiresAt: now() + 600000 }); pendingAvatars.set(key, pending.slice(-3));
        return json(res, 200, { avatar });
      }
      mkdirSync(resolve(dataDir, 'avatars'), { recursive: true, mode: 0o700 });
      writeFileSync(resolve(dataDir, 'avatars', file), buffer, { mode: 0o600 });
      return json(res, 200, { avatar: `/avatars/${file}` });
    }
    if (path === '/api/avatar-url' && req.method === 'POST') {
      if (!storage || typeof body.fileID !== 'string' || !body.fileID.startsWith('cloud://')) fail(400, 'BAD_AVATAR', '请提供云头像文件 ID');
      const existing = Object.values(state.users).some(value => value.avatar === body.fileID);
      prunePendingAvatars();
      const pending = (pendingAvatars.get(digest(requestToken)) || []).some(value => value.fileID === body.fileID && value.expiresAt > now());
      if (!existing && !pending) fail(403, 'AVATAR_FORBIDDEN', '此文件不是可访问的象棋头像');
      const expiresAt = now() + 300000;
      let url;
      try { url = await storage.getAvatarURL(body.fileID); } catch { fail(503, 'STORAGE_UNAVAILABLE', '头像读取失败，请稍后再试'); }
      return json(res, 200, { url, expiresAt });
    }
    if (path === '/api/lobby' && req.method === 'GET') { tick(); return json(res, 200, { tables: lobby() }); }
    if (path === '/api/ai' && req.method === 'POST') {
      if (!Number.isInteger(body.difficulty) || body.difficulty < 1 || body.difficulty > 5) fail(400, 'BAD_DIFFICULTY', '难度须为 1 至 5');
      if (!['red', 'black'].includes(body.humanColor)) fail(400, 'BAD_COLOR', '请选择红方或黑方');
      const timeControl = normalizeTimeControl(body.timeControl ?? {});
      const exited = exitOtherGames(userId);
      const game = freshGame(null, 'ai'), aiId = `ai-${game.id}`;
      state.users[aiId] = { id: aiId, name: `狗哥 AI · ${body.difficulty} 级`, kind: 'ai' };
      game.seats[body.humanColor] = userId; game.seats[other(body.humanColor)] = aiId;
      game.ownerId = userId; game.difficulty = body.difficulty; game.timeControl = timeControl;
      startGame(game); persist(); notifyExits(exited); scheduleAI(game); return json(res, 200, { gameId: game.id });
    }
    const tableMatch = /^\/api\/tables\/(\d+)\/(join|watch|leave)$/.exec(path);
    if (tableMatch && req.method === 'POST') {
      const tableId = Number(tableMatch[1]);
      const specificLeave = tableMatch[2] === 'leave' && body.gameId !== undefined;
      let game = specificLeave ? requireGame(body.gameId, userId) : tableGame(tableId);
      if (specificLeave && game.tableId !== tableId) fail(400, 'GAME_TABLE_MISMATCH', '棋局不属于这张棋桌');
      due(game);
      const exited = [];
      if (tableMatch[2] === 'join') {
        const existingColor = playerColor(game, userId);
        if (!existingColor) {
          if (game.status === 'active') fail(409, 'GAME_STARTED', '对局已经开始，可以观棋');
          const color = body.color ?? (game.seats.red ? 'black' : 'red');
          if (!['red', 'black'].includes(color)) fail(400, 'BAD_COLOR', '请选择红方或黑方');
          if (game.seats[color]) fail(409, 'SEAT_TAKEN', '该座位已有棋手');
          exited.push(...exitOtherGames(userId, game.id));
          if (game.status === 'finished') {
            for (const seatedId of Object.values(game.seats).filter(Boolean)) {
              releaseSeat(game, seatedId); exited.push({ game, userId: seatedId });
            }
            game = freshGame(game.tableId);
          }
          game.seats[color] = userId; game.ownerId ||= userId; game.ready = { red: false, black: false };
          game.spectators = game.spectators.filter(id => id !== userId); game.version++;
        }
      } else if (tableMatch[2] === 'watch') {
        if (!isMember(game, userId)) game.spectators.push(userId);
      } else {
        const color = playerColor(game, userId);
        if (color && game.status !== 'active') releaseSeat(game, userId);
        game.spectators = game.spectators.filter(id => id !== userId); delete game.voice[userId];
        for (const client of clients.values()) if (client.userId === userId && client.gameId === game.id) client.gameId = null;
      }
      persist(); notifyExits(exited); broadcast(game, true); return json(res, 200, { gameId: game.id, ok: true });
    }
    const gameMatch = /^\/api\/games\/([^/]+)(?:\/(ready|action))?$/.exec(path);
    if (gameMatch) {
      const game = requireGame(gameMatch[1], userId); due(game);
      if (!gameMatch[2] && req.method === 'GET') { scheduleAI(game); return json(res, 200, { game: snapshot(game) }); }
      if (gameMatch[2] === 'ready' && req.method === 'POST') {
        if (game.status !== 'waiting') fail(409, 'RULES_LOCKED', '开局后不能修改规则');
        const color = playerColor(game, userId);
        if (!color) fail(403, 'NOT_PLAYER', '旁观者不能准备');
        if (body.timeControl) {
          const control = normalizeTimeControl(body.timeControl);
          if (game.ownerId !== userId && JSON.stringify(control) !== JSON.stringify(game.timeControl)) fail(403, 'OWNER_ONLY', '请确认桌主设定的计时规则');
          if (JSON.stringify(control) !== JSON.stringify(game.timeControl)) { game.timeControl = control; game.ready = { red: false, black: false }; }
        }
        game.ready[color] = true; game.version++;
        if (game.seats.red && game.seats.black && game.ready.red && game.ready.black) startGame(game);
        persist(); broadcast(game, true); return json(res, 200, { game: snapshot(game) });
      }
      if (gameMatch[2] === 'action' && req.method === 'POST') { action(game, userId, body); return json(res, 200, { game: snapshot(game) }); }
    }
    if (path === '/api/voice/sign' && req.method === 'POST') {
      const game = requireGame(body.gameId, userId);
      if (!isMember(game, userId)) fail(403, 'NOT_MEMBER', '已离开棋桌，不能加入本桌语音');
      if (game.mode !== 'pvp') fail(400, 'VOICE_PVP_ONLY', 'AI对局不提供同桌语音，请进入玩家棋桌');
      if (state.users[userId].loginKind !== 'wechat') fail(403, 'WECHAT_LOGIN_REQUIRED', '实时语音需在微信内使用真实微信账号登录');
      if (!config.voiceEnabled || !config.appId || !config.appSecret) fail(503, 'VOICE_UNCONFIGURED', '服务器尚未启用微信语音服务，请联系管理员配置；微信接口权限须另行核验');
      expireVoice(game);
      const existing = Boolean(game.voice[userId]);
      const isPlayer = Boolean(playerColor(game, userId));
      const spectators = Object.keys(game.voice).filter(id => !playerColor(game, id)).length;
      if (!existing && (Object.keys(game.voice).length >= 10 || (!isPlayer && spectators >= 8))) fail(409, 'VOICE_FULL', '本桌语音已满（为两位棋手预留席位，最多八位旁观者）');
      game.voice[userId] = now() + 45000;
      const groupId = `gouge-${game.id}`, nonceStr = randomBytes(16).toString('hex'), timeStamp = Math.floor(now() / 1000);
      const signature = voiceSignature(config.appId, groupId, nonceStr, timeStamp, state.users[userId].sessionKey);
      persist(); broadcast(game);
      return json(res, 200, { signature, nonceStr, timeStamp, groupId, openid: state.users[userId].openid, leaseSeconds: 45 });
    }
    if (path === '/api/voice/heartbeat' && req.method === 'POST') {
      const game = requireGame(body.gameId, userId);
      if (!isMember(game, userId)) fail(403, 'NOT_MEMBER', '已离开棋桌，不能续期本桌语音');
      if (game.mode !== 'pvp') fail(400, 'VOICE_PVP_ONLY', 'AI对局不提供同桌语音，请进入玩家棋桌');
      if (state.users[userId].loginKind !== 'wechat') fail(403, 'WECHAT_LOGIN_REQUIRED', '实时语音需在微信内使用真实微信账号登录');
      if (!config.voiceEnabled || !config.appId || !config.appSecret) fail(503, 'VOICE_UNCONFIGURED', '服务器尚未启用微信语音服务，请联系管理员配置；微信接口权限须另行核验');
      expireVoice(game);
      if (!game.voice[userId]) fail(409, 'VOICE_NOT_JOINED', '语音席位已释放，请重新加入');
      const serverNow = now(), expiresAt = serverNow + 45000;
      game.voice[userId] = expiresAt; persist();
      return json(res, 200, { ok: true, serverNow, expiresAt, leaseSeconds: 45 });
    }
    if (path === '/api/voice/leave' && req.method === 'POST') {
      const game = requireGame(body.gameId, userId); delete game.voice[userId]; persist(); broadcast(game); return json(res, 200, { ok: true });
    }
    fail(404, 'NOT_FOUND', '接口不存在');
  }
  function serveStatic(path, res) {
    const segment = path.startsWith('/core/') ? 'core' : path.startsWith('/avatars/') ? 'avatars' : 'web';
    if (storage && segment === 'avatars') fail(404, 'NOT_FOUND', '云头像请使用云文件 ID');
    const base = segment === 'avatars' ? resolve(dataDir, 'avatars') : resolve(ROOT, segment);
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { fail(400, 'BAD_PATH', '文件路径无效'); }
    const relative = segment === 'web' ? (decoded === '/' ? 'index.html' : decoded.slice(1)) : decoded.slice(segment.length + 2);
    const file = resolve(base, relative);
    if (!file.startsWith(`${base}${sep}`) || !existsSync(file) || !statSync(file).isFile()) fail(404, 'NOT_FOUND', '文件不存在');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    if (!types[extname(file)]) fail(404, 'NOT_FOUND', '文件不存在');
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'" });
    res.end(readFileSync(file));
  }
  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (!res.headersSent) return json(res, error.status || (error instanceof RangeError || error instanceof TypeError ? 400 : 500),
      { error: error.status || error instanceof RangeError || error instanceof TypeError ? error.message : '服务端处理失败，请稍后重试', code: error.code || 'INTERNAL_ERROR' });
    else res.end();
  }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (storage) await flush();
      storageCheck();
      checkOrigin(req); const url = new URL(req.url, 'http://local');
      if (url.pathname !== '/ws') fail(404, 'NOT_FOUND', '接口不存在');
      const userId = authenticate(url.searchParams.get('token'));
      wss.handleUpgrade(req, socket, head, ws => { wss.emit('connection', ws, userId); });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  wss.on('connection', (ws, userId) => {
    clients.set(ws, { userId, gameId: null }); send(ws, { type: 'lobby', tables: lobby() });
    ws.on('message', async bytes => {
      try {
        storageCheck();
        const body = JSON.parse(bytes.toString()), client = clients.get(ws);
        if (body.type === 'ping') { if (client.gameId) { const game = state.games[client.gameId]; if (game) { expireVoice(game); if (isMember(game, userId) && game.voice[userId]) game.voice[userId] = now() + 45000; } } send(ws, { type: 'pong', serverNow: now() }); }
        else if (body.type === 'subscribe') { const game = requireGame(body.gameId, userId); due(game); client.gameId = game.id; if (storage) await flush(); send(ws, { type: 'game', game: snapshot(game) }); }
      } catch (error) { send(ws, { type: 'error', error: error.status ? error.message : '消息格式无效', code: error.code || 'BAD_MESSAGE' }); }
    });
    ws.on('close', () => {
      clients.delete(ws);
      // HTTP续期与棋局WebSocket独立；显式离开或45秒到期才释放语音席位。
    });
  });
  for (const game of Object.values(state.games)) {
    game.voice = {}; game.aiThinking = false; game.operations ||= {}; game.draw ||= null; game.participants ||= [];
    if (game.status === 'finished' && !game.resultSeats && game.outcome) recordResult(game, game.outcome);
  }
  persist(); tick();
  const interval = options.autoTimers === false ? null : setInterval(tick, 100);
  interval?.unref();
  return { server, state, config, tick, snapshot, lobby, flush,
    listen: (port = Number(env.PORT) || 8787, host = config.host) => new Promise(resolveListen => server.listen(port, host, () => resolveListen(server.address()))),
    close: async () => { if (closed) return; closed = true; if (interval) clearInterval(interval); for (const abort of pendingAI.values()) abort.abort();
      for (const ws of clients.keys()) ws.terminate(); if (storageHealthy()) persist();
      await new Promise(resolveClose => wss.close(resolveClose));
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
      let failure;
      try { await flush(); } catch (error) { failure = error; }
      if (storage?.close) await storage.close();
      if (failure) throw failure; },
  };
}

export function createServer(options = {}) { return createApp(options); }
