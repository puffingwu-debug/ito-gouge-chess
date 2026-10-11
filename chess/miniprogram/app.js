const config = require('./config');
const api = require('./services/api');

App({
  globalData: { user: null, token: '', config },
  onLaunch() {
    const session = wx.getStorageSync('gougeSession');
    if (session && session.apiBase === config.apiBase && session.development === config.development) {
      this.globalData.token = session.token;
      this.globalData.user = api.userView(session.user);
    }
  },
  async login(name) {
    let result;
    if (config.development) {
      result = await api.request('/api/login/dev', 'POST', { name: name || '家人' }, false);
    } else {
      const code = await new Promise((resolve, reject) => {
        wx.login({ success: res => res.code ? resolve(res.code) : reject(new Error('微信未返回登录凭证')), fail: reject });
      });
      result = await api.request('/api/login/wechat', 'POST', { code }, false);
    }
    this.globalData.token = result.token;
    this.globalData.user = api.userView(result.user);
    this.saveSession();
    return this.globalData.user;
  },
  async ensureLogin() {
    if (this.globalData.token && this.globalData.user) return this.globalData.user;
    return this.login();
  },
  updateUser(user) {
    this.globalData.user = api.userView(user);
    this.saveSession();
  },
  saveSession() {
    wx.setStorageSync('gougeSession', {
      token: this.globalData.token, user: this.globalData.user,
      apiBase: config.apiBase, development: config.development
    });
  },
  clearSession() {
    this.globalData.token = '';
    this.globalData.user = null;
    wx.removeStorageSync('gougeSession');
  }
});
