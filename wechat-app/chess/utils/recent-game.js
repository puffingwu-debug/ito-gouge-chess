let pendingCreated = Promise.resolve();

function ownColor(game, userId) {
  return ['red', 'black'].find(color => game.seats && game.seats[color] && game.seats[color].id === userId) || '';
}
function recentFor(userId) {
  const recent = wx.getStorageSync('gougeLastGame');
  if (!recent) return null;
  if (recent.userId !== userId) {
    wx.removeStorageSync('gougeLastGame');
    return null;
  }
  return recent;
}
function forget(gameId) {
  const recent = wx.getStorageSync('gougeLastGame');
  if (!gameId || (recent && recent.gameId === gameId)) wx.removeStorageSync('gougeLastGame');
}
function remember(game, userId) {
  if (!ownColor(game, userId)) return;
  if (game.status === 'finished') return forget(game.id);
  const recent = recentFor(userId);
  if (!recent || recent.gameId !== game.id) wx.setStorageSync('gougeLastGame', { gameId: game.id, userId });
}
function rememberCreated(gameId, userId, token) {
  const { getChessApp } = require('../session');
  const api = require('../services/api');
  const app = getChessApp();
  const currentSession = () => !!token && app.globalData.token === token && !!app.globalData.user && app.globalData.user.id === userId;
  // Validate successful creations serially so an older snapshot cannot replace a later game.
  const pending = pendingCreated.then(async () => {
    if (!currentSession()) return false;
    const result = await api.request('/api/games/' + encodeURIComponent(gameId));
    const game = result.game;
    if (!currentSession() || !game || game.id !== gameId || game.status === 'finished' || !ownColor(game, userId)) return false;
    remember(game, userId);
    return true;
  });
  pendingCreated = pending.catch(() => {});
  return pending;
}
module.exports = { ownColor, recentFor, remember, forget, rememberCreated };
