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
module.exports = { ownColor, recentFor, remember, forget };
