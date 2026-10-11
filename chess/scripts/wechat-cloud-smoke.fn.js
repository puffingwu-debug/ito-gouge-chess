function cloudSmoke(arg) {
  var report = { ok: false, source: '微信原生 wx.cloud SDK', physicalDevice: false,
    checks: { backendHealth: false, wechatLogin: false, identityConsistent: false, websocketLobby: false, websocketPong: false } };
  var stage = 'configuration', socket, token = '', loginCode = '';
  var originalApp = JSON.stringify(getApp().globalData);
  function failure(code, status) { return { code: code, status: status }; }
  function request(path, data, authenticated) {
    return wx.cloud.callContainer({ config: { env: arg.env }, service: arg.service, path: path,
      method: data === undefined ? 'GET' : 'POST', data: data, dataType: 'json', timeout: 8000,
      header: Object.assign({ 'content-type': 'application/json', 'X-WX-SERVICE': arg.service },
        authenticated ? { Authorization: 'Bearer ' + token } : {})
    }).then(function(response) {
      if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.data && response.data.code, response.statusCode);
      return response.data;
    });
  }
  return Promise.resolve().then(function() {
    if (!arg || !arg.env || !arg.service) throw failure('CLOUD_CONFIG_REQUIRED');
    if (!wx.cloud || !wx.cloud.init || !wx.cloud.callContainer || !wx.cloud.connectContainer) throw failure('SDK_UNAVAILABLE');
    var device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    report.physicalDevice = device.platform !== 'devtools';
    wx.cloud.init({ env: arg.env });
    stage = 'health';
    return request('/api/health');
  }).then(function(health) {
    if (health.ok !== true || health.devMode !== false || health.wechatConfigured !== true ||
        health.storage.kind !== 'cloudbase' || health.storage.healthy !== true) throw failure('HEALTH_NOT_READY');
    report.checks.backendHealth = true;
    report.voiceConfigured = health.voiceConfigured === true;
    report.deepseekConfigured = health.deepseekConfigured === true;
    stage = 'wx.login';
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() { reject(failure('WX_LOGIN_TIMEOUT')); }, 8000);
      wx.login({ success: function(response) { clearTimeout(timer); response.code ? resolve(response.code) : reject(failure('WX_LOGIN_NO_CODE')); },
        fail: function() { clearTimeout(timer); reject(failure('WX_LOGIN_FAILED')); } });
    });
  }).then(function(code) {
    loginCode = code;
    stage = 'login';
    return request('/api/login/wechat', { code: loginCode });
  }).then(function(login) {
    if (!login.token || !login.user || !login.user.id) throw failure('LOGIN_RESPONSE_INVALID');
    token = login.token;
    report.checks.wechatLogin = true;
    stage = 'identity';
    return request('/api/me', undefined, true).then(function(response) {
      if (!response.user || response.user.id !== login.user.id) throw failure('LOGIN_IDENTITY_MISMATCH');
      report.checks.identityConsistent = true;
    });
  }).then(function() {
    stage = 'websocket';
    return wx.cloud.connectContainer({ config: { env: arg.env }, service: arg.service,
      path: '/ws?token=' + encodeURIComponent(token), timeout: 8000 });
  }).then(function(connection) {
    socket = connection.socketTask;
    return new Promise(function(resolve, reject) {
      var done = false, timer;
      function finish(error) {
        if (done) return;
        done = true; clearTimeout(timer);
        error ? reject(error) : resolve();
      }
      timer = setTimeout(function() { finish(failure('WEBSOCKET_TIMEOUT')); }, 10000);
      socket.onOpen(function() { socket.send({ data: JSON.stringify({ type: 'ping' }), fail: function() { finish(failure('WEBSOCKET_SEND_FAILED')); } }); });
      socket.onMessage(function(event) {
        var message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'error') return finish(failure(message.code));
        if (message.type === 'lobby' && Array.isArray(message.tables) && message.tables.length === 6) report.checks.websocketLobby = true;
        if (message.type === 'pong' && Number.isFinite(message.serverNow)) report.checks.websocketPong = true;
        if (report.checks.websocketLobby && report.checks.websocketPong) finish();
      });
      socket.onError(function(event) {
        var error = failure('WEBSOCKET_ERROR'), message = String(event && event.errMsg || '');
        report.socketErrorFields = Object.keys(event || {}).slice(0, 12);
        var detail = message || String(event && event.message || '');
        if (token) detail = detail.split(token).join('[SESSION]');
        if (loginCode) detail = detail.split(loginCode).join('[LOGIN_CODE]');
        report.socketErrorMessage = detail.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL]').slice(0, 250);
        var status = /(?:response code|status code|http status)[: ]+(\d{3})/i.exec(message);
        var network = /\bERR_[A-Z_]+\b/.exec(message);
        if (status) error.status = Number(status[1]);
        if (network) error.networkCode = network[0];
        if (event && Number.isSafeInteger(event.errCode)) error.errCode = event.errCode;
        finish(error);
      });
      socket.onClose(function() { finish(failure('WEBSOCKET_CLOSED')); });
    });
  }).then(function() { report.ok = true; }, function(error) {
    report.failedStage = stage;
    report.errorCode = error && /^[A-Z_][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SDK_FAILURE';
    if (error && Number.isSafeInteger(error.errCode)) report.errCode = error.errCode;
    if (error && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) report.status = error.status;
    if (error && /^ERR_[A-Z_]{1,80}$/.test(error.networkCode)) report.networkCode = error.networkCode;
  }).then(function() {
    if (socket) socket.close({});
    token = ''; loginCode = '';
    report.hostAppUnchanged = JSON.stringify(getApp().globalData) === originalApp;
    return report;
  });
}
