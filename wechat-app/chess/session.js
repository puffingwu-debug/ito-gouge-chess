const config = require('./config');

let initialized = false;
let loginAttempt = 0;
let pendingLogin = null;
const chessApp = {
  globalData: { user: null, token: '', config },
  async login(name) {
    const attempt = ++loginAttempt;
    const api = require('./services/api');
    let result;
    if (config.development) {
      result = await api.request('/api/login/dev', 'POST', { name: name || '家人' }, false);
    } else {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: res => res.code ? resolve(res.code) : reject(new Error('微信未返回登录凭证')), fail: reject });
      });
      if (attempt !== loginAttempt) throw new Error('登录已取消，请重新登录');
      result = await api.request('/api/login/wechat', 'POST', { code }, false);
    }
    if (attempt !== loginAttempt) throw new Error('登录已取消，请重新登录');
    this.globalData.token = result.token;
    this.globalData.user = api.userView(result.user);
    this.saveSession();
    return this.globalData.user;
  },
  async ensureLogin() {
    if (this.globalData.token && this.globalData.user) return this.globalData.user;
    if (!pendingLogin) {
      const pending = this.login();
      pendingLogin = pending;
      const clear = () => { if (pendingLogin === pending) pendingLogin = null; };
      pending.then(clear, clear);
    }
    return pendingLogin;
  },
  updateUser(user, token) {
    if (!token || token !== this.globalData.token || !this.globalData.user || user.id !== this.globalData.user.id) return false;
    const api = require('./services/api');
    this.globalData.user = api.userView(user);
    this.saveSession();
    return true;
  },
  saveSession() {
    const user = this.globalData.user && Object.assign({}, this.globalData.user);
    if (user && config.transport === 'cloud') delete user.avatarUrl;
    const session = {
      token: this.globalData.token, user,
      development: config.development, transport: config.transport || 'http'
    };
    if (session.transport === 'cloud') Object.assign(session, { cloudEnv: config.cloudEnv, cloudService: config.cloudService });
    else session.apiBase = config.apiBase;
    wx.setStorageSync('gougeSession', session);
  },
  clearSession() {
    loginAttempt++;
    pendingLogin = null;
    this.globalData.token = '';
    this.globalData.user = null;
    wx.removeStorageSync('gougeSession');
  }
};

function getChessApp() {
  if (!initialized) {
    initialized = true;
    const session = wx.getStorageSync('gougeSession');
    const transport = config.transport || 'http';
    const sameTarget = session && (session.transport || 'http') === transport && (transport === 'cloud'
      ? session.cloudEnv === config.cloudEnv && session.cloudService === config.cloudService
      : session.apiBase === config.apiBase);
    if (sameTarget && session.development === config.development) {
      const api = require('./services/api');
      chessApp.globalData.token = session.token;
      chessApp.globalData.user = api.userView(session.user);
    }
  }
  return chessApp;
}

module.exports = { getChessApp };
