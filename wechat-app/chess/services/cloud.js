const config = require('../config');

let initializedEnv = '';
function cloudClient(method) {
  if (!wx.cloud || typeof wx.cloud.init !== 'function' || typeof wx.cloud[method] !== 'function') throw new Error('当前微信版本不支持云托管，请升级微信后重试');
  if (initializedEnv !== config.cloudEnv) {
    wx.cloud.init({ env: config.cloudEnv });
    initializedEnv = config.cloudEnv;
  }
  return wx.cloud;
}
module.exports = { cloudClient };
