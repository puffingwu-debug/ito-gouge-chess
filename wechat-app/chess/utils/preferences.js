const { defaultControl } = require('./time');
function getPreferences() {
  const saved = wx.getStorageSync('gougePreferences') || {};
  return {
    timeControl: Object.assign({}, defaultControl, saved.timeControl || {}),
    moveSound: saved.moveSound === true,
    voiceSound: saved.voiceSound !== false
  };
}
function savePreferences(patch) {
  const preferences = Object.assign({}, getPreferences(), patch);
  wx.setStorageSync('gougePreferences', preferences);
  return preferences;
}
module.exports = { getPreferences, savePreferences };
