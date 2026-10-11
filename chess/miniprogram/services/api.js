const config = require('../config');

function request(path, method = 'GET', data, authenticated = true, requestToken) {
  const app = getApp();
  const token = authenticated ? (requestToken === undefined ? app.globalData.token : requestToken) : '';
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' };
    if (token) header.Authorization = 'Bearer ' + token;
    wx.request({
      url: config.apiBase.replace(/\/$/, '') + path,
      method, data, header, timeout: 20000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401 && token && app.globalData.token === token) app.clearSession();
        const error = new Error((res.data && res.data.error) || '服务请求失败（' + res.statusCode + '）');
        error.status = res.statusCode;
        error.code = res.data && res.data.code;
        reject(error);
      },
      fail(err) { reject(new Error(err.errMsg || '连接失败，请检查网络与服务地址')); }
    });
  });
}

function errorText(err) { return err.message || err.errMsg || '操作失败，请重试'; }
function avatarUrl(value) {
  return value && value.charAt(0) === '/' ? config.apiBase.replace(/\/$/, '') + value : (value || '');
}
function userView(user) { return user ? Object.assign({}, user, { avatarUrl: avatarUrl(user.avatar) }) : null; }
module.exports = { request, errorText, avatarUrl, userView };
