import { createHash, randomUUID } from 'node:crypto';

const parts = ['users', 'sessions', 'games', 'avatars'];
const emptyState = () => ({ users: {}, sessions: {}, games: {}, avatars: {}, tables: Array(6).fill(null) });
const error = (code, message) => Object.assign(new Error(message), { code });
const documentId = key => createHash('sha256').update(key).digest('hex');
function checked(result) {
  if (result?.code) throw error('CLOUD_DATABASE_ERROR', '云数据库操作失败');
  return result;
}
function document(result) {
  const data = checked(result)?.data;
  return (Array.isArray(data) ? data[0] : data) || null;
}
function records(state) {
  const values = new Map();
  for (const kind of parts) for (const [key, value] of Object.entries(state[kind] || {})) {
    values.set(`${kind}:${key}`, { kind, key, json: JSON.stringify(value) });
  }
  return values;
}

export async function createCloudStorage(options = {}) {
  const env = options.env || process.env, now = options.now || Date.now;
  if (!env.CLOUDBASE_ENV_ID) throw error('CLOUD_CONFIG_REQUIRED', '云持久化须配置 CLOUDBASE_ENV_ID');
  const cloud = options.app || (await import('@cloudbase/js-sdk')).default.init({
    env: env.CLOUDBASE_ENV_ID, region: env.CLOUDBASE_REGION || 'ap-shanghai', timeout: 8000, throw: true,
    ...(env.CLOUDBASE_APIKEY ? { accessKey: env.CLOUDBASE_APIKEY } : {}),
  });
  const db = cloud.database(), collectionName = env.CLOUDBASE_STATE_COLLECTION || 'gouge_chess_state';
  const owner = randomUUID(), leaseMs = options.leaseMs || 60000;
  let fence, version, leaseUntil, fatal = null, closed = false, timer;
  let queue = Promise.resolve(), cache = new Map(), tables;
  const healthy = () => !closed && !fatal && now() < leaseUntil;
  const verify = value => {
    if (!value || value.owner !== owner || value.fence !== fence || value.leaseUntil <= now()) {
      throw error('CLOUD_LEASE_LOST', '云对局实例租约已失效');
    }
  };
  const transaction = callback => db.runTransaction(tx => callback(tx.collection(collectionName)));
  const enqueue = callback => {
    queue = queue.then(() => {
      if (!healthy()) throw error('CLOUD_LEASE_LOST', '云对局实例租约已失效');
      return callback();
    }).catch(failure => { fatal = failure; throw failure; });
    queue.catch(() => {});
    return queue;
  };
  const initialState = emptyState();
  const authority = await transaction(async collection => {
    let current;
    try { current = document(await collection.doc('authority').get()); }
    catch (failure) { if (failure.code !== 'DOCUMENT_NOT_FOUND') throw failure; current = null; }
    if (current?.owner && current.leaseUntil > now()) throw error('CLOUD_INSTANCE_ACTIVE', '另一象棋实例仍在运行，请先停止旧实例');
    if (current && current.schema !== 1) throw error('CLOUD_SCHEMA_INVALID', '云状态版本不支持');
    const next = { schema: 1, kind: 'authority', owner, fence: (current?.fence || 0) + 1,
      version: current?.version || 0, leaseUntil: now() + leaseMs, tables: current?.tables || initialState.tables };
    checked(await collection.doc('authority').set(next));
    return next;
  });
  ({ fence, version, leaseUntil, tables } = authority);

  async function renew() {
    return enqueue(async () => {
      const renewed = await transaction(async collection => {
        const current = document(await collection.doc('authority').get()); verify(current);
        const until = now() + leaseMs;
        checked(await collection.doc('authority').update({ leaseUntil: until }));
        return until;
      });
      leaseUntil = renewed;
    });
  }
  async function release() {
    await transaction(async collection => {
      const current = document(await collection.doc('authority').get());
      if (current?.owner === owner && current.fence === fence) checked(await collection.doc('authority').update({ owner: '', leaseUntil: 0 }));
    });
  }
  try {
    for (let offset = 0; ; offset += 100) {
      const result = checked(await db.collection(collectionName).orderBy('_id', 'asc').skip(offset).limit(100).get());
      if (!Array.isArray(result.data)) throw error('CLOUD_STATE_INVALID', '云状态读取格式无效');
      for (const record of result.data) {
        if (record._id === 'authority') continue;
        if (!parts.includes(record.kind) || typeof record.key !== 'string' || typeof record.json !== 'string') {
          throw error('CLOUD_STATE_INVALID', '云状态记录无效');
        }
        initialState[record.kind][record.key] = JSON.parse(record.json);
      }
      if (now() > leaseUntil - leaseMs / 2) await renew();
      if (result.data.length < 100) break;
    }
    initialState.tables = tables;
    cache = records(initialState);
    if (!healthy()) throw error('CLOUD_LEASE_LOST', '云状态恢复时租约已失效');
  } catch (failure) {
    await release().catch(() => {}); throw failure;
  }
  if (options.autoRenew !== false) {
    timer = setInterval(() => {
      if (healthy() && now() >= leaseUntil - leaseMs * 2 / 3) renew().catch(() => {});
    }, Math.min(20000, leaseMs / 3));
    timer.unref();
  }
  return {
    kind: 'cloudbase', initialState, healthy, renew,
    save: state => enqueue(async () => {
      const next = records(state), changes = [...next].filter(([key, value]) => cache.get(key)?.json !== value.json);
      const removed = [...cache.keys()].filter(key => !next.has(key));
      if (!changes.length && !removed.length && JSON.stringify(tables) === JSON.stringify(state.tables)) return;
      if (changes.length + removed.length > 98) throw error('CLOUD_TRANSACTION_TOO_LARGE', '一次状态变更超过云事务容量，不能部分提交');
      const saved = await transaction(async collection => {
        const current = document(await collection.doc('authority').get()); verify(current);
        if (current.version !== version) throw error('CLOUD_VERSION_CONFLICT', '云状态版本冲突，须重新恢复');
        for (const [key, value] of changes) checked(await collection.doc(documentId(key)).set(value));
        for (const key of removed) checked(await collection.doc(documentId(key)).remove());
        const until = now() + leaseMs;
        checked(await collection.doc('authority').update({ version: version + 1, leaseUntil: until, tables: state.tables }));
        return { version: version + 1, leaseUntil: until };
      });
      ({ version, leaseUntil } = saved); cache = next; tables = [...state.tables];
    }),
    putAvatar: async (name, buffer) => {
      if (!healthy()) throw error('CLOUD_LEASE_LOST', '云对局实例租约已失效');
      const result = checked(await cloud.uploadFile({ cloudPath: `gouge-avatars/${name}`, fileContent: buffer }));
      if (typeof result.fileID !== 'string' || !result.fileID.startsWith('cloud://')) throw error('CLOUD_AVATAR_INVALID', '云头像上传未返回文件 ID');
      return result.fileID;
    },
    getAvatarURL: async fileID => {
      if (!healthy()) throw error('CLOUD_LEASE_LOST', '云对局实例租约已失效');
      const result = checked(await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 300 }] }));
      const file = result.fileList?.find(value => value.fileID === fileID && value.code === 'SUCCESS');
      if (!file?.tempFileURL?.startsWith('https://')) throw error('CLOUD_AVATAR_UNAVAILABLE', '云头像读取失败');
      return file.tempFileURL;
    },
    close: async () => {
      if (closed) return;
      clearInterval(timer); await queue.catch(() => {}); closed = true;
      await release();
    },
  };
}
