const cloud = require('wx-server-sdk');
const { createHash } = require('node:crypto');
const { createChatHandler, authorizeMember, ChatError, roomId, receiptId } = require('./handler.cjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false });
const db = cloud.database();
const STATE_COLLECTION = 'gouge_chess_state', CHAT_COLLECTION = 'gouge_chess_chat';
const stateId = (kind, id) => createHash('sha256').update(`${kind}:${id}`).digest('hex');
async function get(doc) {
  try { const result = await doc.get(); return (Array.isArray(result.data) ? result.data[0] : result.data) || null; }
  catch (error) { if (error.code === 'DOCUMENT_NOT_FOUND') return null; throw error; }
}
function record(value, kind, id) {
  if (!value) return null;
  if (value.kind !== kind || value.key !== id || typeof value.json !== 'string') throw new ChatError(503, 'CHAT_STATE_INVALID', '棋桌资料暂时不可用');
  const parsed = JSON.parse(value.json);
  if (parsed.id !== id) throw new ChatError(503, 'CHAT_STATE_INVALID', '棋桌资料暂时不可用');
  return parsed;
}
async function resolveUser(target) {
  if (target.userIdHint) return target.userIdHint;
  for (let offset = 0; ; offset += 100) {
    const result = await db.collection(STATE_COLLECTION).where({ kind: 'users' }).orderBy('_id', 'asc').skip(offset).limit(100).get();
    if (!Array.isArray(result.data)) throw new ChatError(503, 'CHAT_STATE_INVALID', '棋桌资料暂时不可用');
    for (const value of result.data) {
      const user = record(value, 'users', value.key);
      if (user.openid === target.identity.openid && user.kind !== 'ai') return user.id;
    }
    if (result.data.length < 100) throw new ChatError(403, 'CHAT_IDENTITY_MISMATCH', '请先用当前微信身份登录象棋');
  }
}
async function current(tx, target, userId) {
  const source = tx.collection(STATE_COLLECTION);
  const authority = await get(source.doc('authority'));
  const user = record(await get(source.doc(stateId('users', userId))), 'users', userId);
  const game = record(await get(source.doc(stateId('games', target.gameId))), 'games', target.gameId);
  if (authority?.schema !== 1) throw new ChatError(503, 'CHAT_STATE_INVALID', '棋桌资料暂时不可用');
  const member = authorizeMember({ identity: target.identity, user, game, authority });
  const collection = tx.collection(CHAT_COLLECTION);
  const chat = await get(collection.doc(roomId(target.gameId)));
  const receipt = target.reqId ? await get(collection.doc(receiptId({ ...target, userIdHint: member.id }))) : null;
  return { user: member, chat, receipt };
}
const store = {
  read: async target => {
    const userId = await resolveUser(target);
    return db.runTransaction(tx => current(tx, target, userId));
  },
  transact: async (target, update) => {
    const userId = await resolveUser(target);
    return db.runTransaction(async tx => {
      const value = await current(tx, target, userId), change = await update(value);
      if (change.chat) {
        const collection = tx.collection(CHAT_COLLECTION);
        await collection.doc(roomId(target.gameId)).set({ data: change.chat });
        await collection.doc(receiptId({ ...target, userIdHint: value.user.id })).set({ data: change.receipt });
      }
      return change.result;
    });
  },
};
const handle = createChatHandler({ store,
  identity: () => { const value = cloud.getWXContext(); return { appId: value.APPID, openid: value.OPENID }; },
  checkText: async ({ openid, content }) => {
    const checked = await cloud.openapi.security.msgSecCheck({ version: 2, scene: 4, openid, content });
    if (checked?.errCode !== 0 || typeof checked.result?.suggest !== 'string') throw new Error('text check unavailable');
    return checked.result.suggest === 'pass';
  },
});
exports.main = async event => {
  try { return await handle(event); }
  catch (error) {
    if (error instanceof ChatError) return { ok: false, status: error.status, code: error.code, error: error.message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
    return { ok: false, status: 503, code: 'CHAT_UNAVAILABLE', error: '棋桌聊天暂时不可用，请稍后重试' };
  }
};
