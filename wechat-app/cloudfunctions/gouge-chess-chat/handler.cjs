const { createHash } = require('node:crypto');

const APP_ID = 'wxbb23c109d761ccbd';
const REACTIONS = Object.freeze({ handshake: '🤝 握手', thumbsup: '👍 点赞', badmove: '🙈 臭棋', cry: '😭 哭鼻子', laugh: '😂 哈哈大笑', whiteflag: '🏳️ 白旗' });
const hash = value => createHash('sha256').update(value).digest('hex');
const roomId = gameId => hash(`room:${gameId}`);
const receiptId = target => hash(`receipt:${target.gameId}:${target.userIdHint}:${target.reqId}`);
class ChatError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}
const fail = (status, code, message, extra) => { throw new ChatError(status, code, message, extra); };

function authorizeMember({ identity, user, game, authority }) {
  if (!user || user.kind === 'ai' || user.openid !== identity.openid) fail(403, 'CHAT_IDENTITY_MISMATCH', '请先用当前微信身份登录象棋');
  if (!game) fail(404, 'GAME_NOT_FOUND', '棋局不存在');
  if (game.mode !== 'pvp') fail(400, 'CHAT_AI_UNSUPPORTED', '文字交流仅用于玩家棋桌');
  if (!Number.isInteger(game.tableId) || game.tableId < 1 || game.tableId > 6 || authority?.tables?.[game.tableId - 1] !== game.id) {
    fail(403, 'CHAT_ROOM_INACTIVE', '这张棋桌已换局，请进入当前棋局交流');
  }
  if (!Object.values(game.seats || {}).includes(user.id) && !game.spectators?.includes(user.id)) fail(403, 'NOT_MEMBER', '请先入座或观棋再交流');
  return { id: user.id, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 24) : '家人' };
}
function chatValue(value, gameId) {
  if (!value) return { schema: 1, gameId, seq: 0, messages: [], rates: [] };
  if (value.schema !== 1 || value.gameId !== gameId || !Number.isSafeInteger(value.seq) || value.seq < 0 || !Array.isArray(value.messages) || !Array.isArray(value.rates)) {
    fail(503, 'CHAT_STATE_INVALID', '棋桌聊天暂时不可用');
  }
  return value;
}
function snapshot(chat, extra = {}) {
  return { gameId: chat.gameId, seq: chat.seq, messages: chat.messages.map(value => ({ id: value.id, seq: value.seq, userId: value.userId,
    name: value.name, text: value.text, kind: value.kind, ...(value.kind === 'reaction' ? { reaction: value.reaction } : {}), at: value.at })), ...extra };
}
function duplicate(current, fingerprint) {
  if (!current.receipt) return null;
  if (current.receipt.fingerprint !== fingerprint) fail(409, 'REQ_ID_CONFLICT', '同一次发送编号不能改成另一条内容');
  const message = current.chat.messages.find(value => value.seq === current.receipt.seq);
  return snapshot(current.chat, { duplicate: true, ...(message ? { message } : {}) });
}
function rate(chat, userId, time) {
  const previous = chat.rates.find(value => value.userId === userId);
  if (previous && time < previous.at + 2000) fail(429, 'CHAT_RATE_LIMIT', '发送太快，请稍等两秒', { retryAfterMs: previous.at + 2000 - time });
}
function createChatHandler({ store, identity, checkText, now = Date.now }) {
  return async function handle(input, context) {
    if (!input || !['list', 'send'].includes(input.operation)) fail(400, 'BAD_CHAT_OPERATION', '聊天操作无效');
    if (typeof input.gameId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.gameId)) fail(400, 'BAD_GAME_ID', '棋局编号无效');
    if (input.userIdHint !== undefined && (typeof input.userIdHint !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.userIdHint))) fail(400, 'BAD_USER_HINT', '用户编号无效');
    const trusted = await identity(context);
    if (!trusted || trusted.appId !== APP_ID || typeof trusted.openid !== 'string' || !trusted.openid) fail(401, 'CHAT_IDENTITY_REQUIRED', '请从本小程序用微信身份打开聊天');
    const target = { gameId: input.gameId, userIdHint: input.userIdHint, identity: trusted };
    let content, fingerprint;
    if (input.operation === 'send') {
      if (typeof input.reqId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.reqId)) fail(400, 'BAD_REQ_ID', '缺少有效的发送编号，请重试');
      target.reqId = input.reqId;
      if (input.reaction !== undefined) {
        if (input.text !== undefined) fail(400, 'BAD_CHAT_CONTENT', '互动不能同时携带自由文字');
        if (typeof input.reaction !== 'string' || !Object.hasOwn(REACTIONS, input.reaction)) fail(400, 'BAD_REACTION', '请选择已有互动');
        content = { kind: 'reaction', reaction: input.reaction, text: REACTIONS[input.reaction] };
      } else {
        if (typeof input.text !== 'string') fail(400, 'BAD_CHAT_TEXT', '请输入文字');
        const text = input.text.trim();
        if (!text || Array.from(text).length > 200 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) fail(400, 'BAD_CHAT_TEXT', '文字需要 1 至 200 个字符，不能含控制符');
        content = { kind: 'text', text };
      }
      fingerprint = hash(JSON.stringify(content));
    }
    const before = await store.read(target);
    before.chat = chatValue(before.chat, target.gameId);
    target.userIdHint = before.user.id;
    if (input.operation === 'list') return snapshot(before.chat);
    const repeated = duplicate(before, fingerprint);
    if (repeated) return repeated;
    rate(before.chat, before.user.id, now());
    if (content.kind === 'text') {
      let passed;
      try { passed = typeof checkText === 'function' ? await checkText({ openid: trusted.openid, content: content.text }) : undefined; }
      catch { fail(503, 'CHAT_TEXT_UNAVAILABLE', '文字安全检查暂时不可用，请稍后重试'); }
      if (passed === false) fail(400, 'CHAT_TEXT_REJECTED', '这条文字未通过安全检查，请修改后发送');
      if (passed !== true) fail(503, 'CHAT_TEXT_UNAVAILABLE', '文字安全检查暂时不可用，请稍后重试');
    }
    return store.transact(target, current => {
      current.chat = chatValue(current.chat, target.gameId);
      const repeated = duplicate(current, fingerprint);
      if (repeated) return { result: repeated };
      const time = now(); rate(current.chat, current.user.id, time);
      if (current.chat.seq === Number.MAX_SAFE_INTEGER) fail(503, 'CHAT_STATE_INVALID', '棋桌聊天暂时不可用');
      const seq = current.chat.seq + 1;
      const message = { id: `${target.gameId}:${seq}`, seq, userId: current.user.id, name: current.user.name, ...content, at: time };
      const chat = { schema: 1, gameId: target.gameId, seq, messages: [...current.chat.messages, message].slice(-50),
        rates: [...current.chat.rates.filter(value => value.userId !== current.user.id && value.at + 2000 > time), { userId: current.user.id, at: time }] };
      const receipt = { gameId: target.gameId, userId: current.user.id, reqIdHash: hash(target.reqId), fingerprint, seq, at: time };
      return { chat, receipt, result: snapshot(chat, { message, duplicate: false }) };
    });
  };
}

function createLocalStore({ authorize, persist = () => {}, initialState = { rooms: {}, receipts: {} } }) {
  let state = structuredClone(initialState), queue = Promise.resolve();
  const run = callback => { const pending = queue.then(callback); queue = pending.catch(() => {}); return pending; };
  async function read(target) {
    const user = await authorize(target);
    const resolved = { ...target, userIdHint: user.id };
    return { user, chat: structuredClone(state.rooms[roomId(target.gameId)] || null),
      receipt: target.reqId ? structuredClone(state.receipts[receiptId(resolved)] || null) : null };
  }
  return {
    read: target => run(() => read(target)),
    transact: (target, update) => run(async () => {
      const current = await read(target), change = await update(current);
      if (change.chat) {
        const next = structuredClone(state);
        next.rooms[roomId(target.gameId)] = change.chat;
        next.receipts[receiptId({ ...target, userIdHint: current.user.id })] = change.receipt;
        await persist(next); state = next;
      }
      return change.result;
    }),
    exportState: () => structuredClone(state),
  };
}

module.exports = { APP_ID, REACTIONS, ChatError, createChatHandler, createLocalStore, authorizeMember, roomId, receiptId };
