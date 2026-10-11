const message = '线上象棋服务尚未配置，请联系管理员更新版本';

function address(config) {
  const value = config && config.apiBase;
  if (typeof value !== 'string' || value !== value.trim()) return null;
  const match = /^([a-z]+):\/\/(\[[^\]]+\]|[^:/?#\s@]+)(?::([0-9]+))?(?:[/?#]|$)/i.exec(value);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return null;
  return { scheme: match[1].toLowerCase(), host: match[2].toLowerCase() };
}

function localhost(host) { return host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain'; }

function releaseErrors(config) {
  const errors = [];
  if (!config || config.development !== false) errors.push('development 必须为 false，正式版本需要真实微信登录');
  if (config && config.transport === 'cloud') {
    if (typeof config.cloudEnv !== 'string' || !/^[a-z0-9-]+$/i.test(config.cloudEnv)) errors.push('cloudEnv 必须填写真实云开发环境 ID');
    if (typeof config.cloudService !== 'string' || !/^[a-z0-9-]+$/i.test(config.cloudService)) errors.push('cloudService 必须填写已部署的云托管服务名');
    return errors;
  }
  if (config && config.transport && config.transport !== 'http') errors.push('transport 仅支持 http 或 cloud');
  const parsed = address(config);
  const domain = parsed && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/i.test(parsed.host);
  if (!parsed || parsed.scheme !== 'https' || !domain || localhost(parsed.host)) errors.push('apiBase 必须是 HTTPS 域名，不能使用 localhost 或 IP 地址');
  return errors;
}

function configurationError(config) {
  if (config && config.transport === 'cloud' && releaseErrors(Object.assign({}, config, { development: false })).length) return message;
  if (typeof wx === 'undefined' || !wx.getAccountInfoSync) return '';
  const info = wx.getAccountInfoSync();
  const env = info && info.miniProgram && info.miniProgram.envVersion;
  if (env === 'trial' || env === 'release') return releaseErrors(config).length ? message : '';
  if (config && config.transport === 'cloud') return '';
  const parsed = address(config);
  const loopback = parsed && (localhost(parsed.host) || /^127(?:\.|$)/.test(parsed.host) || parsed.host === '0.0.0.0' || parsed.host === '[::1]' || parsed.host === '[::]' || parsed.host === '[0:0:0:0:0:0:0:1]');
  if (env === 'develop' && loopback) {
    const device = wx.getDeviceInfo ? wx.getDeviceInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
    if (device.platform !== 'devtools') return message;
  }
  return '';
}

module.exports = { releaseErrors, configurationError };
