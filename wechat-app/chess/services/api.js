const { getChessApp } = require('../session');
const config = require('../config');
const { configurationError } = require('./deployment');
const { cloudClient } = require('./cloud');
const { avatarUrl, resolveAvatar } = require('./avatars');

function request(path, method = 'GET', data, authenticated = true, requestToken) {
  const error = configurationError(config);
  if (error) return Promise.reject(new Error(error));
  const app = getChessApp();
  const token = authenticated ? (requestToken === undefined ? app.globalData.token : requestToken) : '';
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' };
    if (token) header.Authorization = 'Bearer ' + token;
    const options = {
      method, data, header, timeout: 20000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401 && token && app.globalData.token === token) app.clearSession();
        const error = new Error((res.data && res.data.error) || '服务请求失败（' + res.statusCode + '）');
        error.status = res.statusCode;
        error.code = res.data && res.data.code;
        reject(error);
      },
      fail(err) { reject(new Error(err.errMsg || err.message || '连接失败，请检查网络与服务地址')); }
    };
    if (config.transport === 'cloud') {
      try {
        const cloud = cloudClient('callContainer');
        cloud.callContainer({ config: { env: config.cloudEnv }, service: config.cloudService, path, method, data,
          header: Object.assign({}, header, { 'X-WX-SERVICE': config.cloudService }), timeout: options.timeout, dataType: 'json'
        }).then(options.success, options.fail);
      } catch (err) { options.fail(err); }
    } else wx.request(Object.assign({ url: config.apiBase.replace(/\/$/, '') + path }, options));
  });
}

function errorText(err) { return err.message || err.errMsg || '操作失败，请重试'; }
function userView(user) { return user ? Object.assign({}, user, { avatarUrl: avatarUrl(user.avatar) }) : null; }
module.exports = { request, errorText, avatarUrl, resolveAvatar, userView };
