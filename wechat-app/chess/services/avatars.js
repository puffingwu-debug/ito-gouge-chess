const config = require('../config');
const cache = new Map();

function currentToken() { return require('../session').getChessApp().globalData.token; }
function cacheKey(value, token) { return token + '\n' + value; }

function avatarUrl(value) {
  if (!value) return '';
  if (value.startsWith('cloud://')) {
    const entry = cache.get(cacheKey(value, currentToken()));
    return entry && entry.expiresAt > Date.now() ? entry.url : '';
  }
  if (value.charAt(0) === '/') return config.transport === 'cloud' ? '' : config.apiBase.replace(/\/$/, '') + value;
  return value;
}

function resolveAvatar(value) {
  if (!value || !value.startsWith('cloud://')) return Promise.resolve(avatarUrl(value));
  const token = currentToken(), key = cacheKey(value, token), entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.url);
  if (entry && entry.pending) return entry.pending;
  if (config.transport !== 'cloud') return Promise.reject(new Error('头像云环境尚未配置'));
  let pending;
  try {
    pending = require('./api').request('/api/avatar-url', 'POST', { fileID: value }).then(result => {
      if (currentToken() !== token) throw new Error('登录状态已变化，请重新操作');
      if (!/^https:\/\//.test(result.url) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('头像读取失败');
      cache.set(key, { url: result.url, expiresAt: Math.min(result.expiresAt, Date.now() + 240000) });
      return result.url;
    }).catch(err => { cache.delete(key); throw err; });
  } catch (err) { return Promise.reject(err); }
  cache.set(key, { pending });
  return pending;
}
module.exports = { avatarUrl, resolveAvatar };
