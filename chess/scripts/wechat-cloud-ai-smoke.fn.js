function cloudAiSmoke(arg) {
  if (arg && arg.runInBackground === true) {
    if (globalThis.__gougeCloudAiQa && globalThis.__gougeCloudAiQa.running) return { started: false, busy: true };
    var background = { running: true, startedAt: Date.now(), report: null };
    globalThis.__gougeCloudAiQa = background;
    run().then(function(result) {
      background.report = result; background.running = false;
    }, function() {
      background.report = { ok: false, errorCode: 'SDK_FAILURE', cleanupComplete: false };
      background.running = false;
    });
    return { started: true };
  }
  return run();
  async function run() {
  var omitSocket = Boolean(arg && arg.omitSocketDisconnectCheck === true);
  var report = { ok: false, source: '微信原生 wx.cloud SDK', physicalDevice: false,
    disconnectChecked: false, socketDisconnectCheckOmitted: omitSocket,
    externalEmptyGameStoreProof: false, externalNoUnfinishedGamesProof: false,
    nativeExistingGameCheck: false, difficultyCount: 0, createdCount: 0,
    deepseekReplyCount: 0, localReplyCount: 0, cleanupComplete: false, untrackedCreationPossible: false,
    checks: { backendHealth: false, wechatLogin: false, identityConsistent: false, fiveDifficulties: false,
      humanMoves: false, aiReplies: false, resignations: false, activeBeforeRestart: false,
      disconnectKeepsActive: false, restartForfeitsPrevious: false } };
  var stage = 'configuration', token = '', userId = '', created = [], socket, creationPending = false;
  var originalApp = JSON.stringify(getApp().globalData), operation = 0, resignations = 0;
  var runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  function failure(code, status) { return { code: code, status: status }; }
  function check(condition, code) { if (!condition) throw failure(code); }
  function emptyStoreProof() {
    var proof = arg && arg.emptyGameStoreProof;
    check(proof, 'EMPTY_STORE_PROOF_REQUIRED');
    var noUnfinished = proof.unfinishedGameCount !== undefined ? proof.unfinishedGameCount === 0 : proof.gameCount === 0;
    check(proof.source === 'admin-readonly' && proof.env === arg.env && proof.service === arg.service &&
      noUnfinished && Number.isSafeInteger(proof.checkedAt), 'EMPTY_STORE_PROOF_INVALID');
    var age = Date.now() - proof.checkedAt;
    check(age >= 0 && age < 30000, 'EMPTY_STORE_PROOF_EXPIRED');
    report.externalEmptyGameStoreProof = proof.gameCount === 0;
    report.externalNoUnfinishedGamesProof = true;
  }
  function wait(milliseconds) { return new Promise(function(resolve) { setTimeout(resolve, milliseconds); }); }
  async function request(path, data, authenticated) {
    var response = await wx.cloud.callContainer({ config: { env: arg.env }, service: arg.service, path: path,
      method: data === undefined ? 'GET' : 'POST', data: data, dataType: 'json', timeout: 8000,
      header: Object.assign({ 'content-type': 'application/json', 'X-WX-SERVICE': arg.service },
        authenticated ? { Authorization: 'Bearer ' + token } : {}) });
    if (response.statusCode < 200 || response.statusCode >= 300) throw failure(response.data && response.data.code, response.statusCode);
    return response.data;
  }
  function tracked(id) { check(created.indexOf(id) >= 0, 'UNTRACKED_TEST_GAME'); }
  async function game(id) {
    tracked(id);
    var response = await request('/api/games/' + encodeURIComponent(id), undefined, true);
    check(response.game && response.game.id === id && response.game.mode === 'ai', 'TEST_GAME_MISMATCH');
    return response.game;
  }
  function ownActive(value) {
    check(value.status === 'active' && value.ownerId === userId && value.seats && value.seats.red &&
      value.seats.red.id === userId && value.seats.black && value.seats.black.kind === 'ai', 'TEST_GAME_OWNERSHIP_CHANGED');
  }
  async function action(value, type, extra) {
    tracked(value.id); ownActive(value);
    return (await request('/api/games/' + encodeURIComponent(value.id) + '/action', Object.assign({ type: type,
      version: value.version, turnId: value.turnId, operationId: 'qa-cloud-' + runId + '-' + (++operation) }, extra || {}), true)).game;
  }
  async function finishTestGame(id) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var current = await game(id);
      if (current.status === 'finished') return current;
      ownActive(current);
      try { return await action(current, 'resign'); }
      catch (error) { if (error.code !== 'STALE_STATE' || attempt === 2) throw error; }
    }
  }
  async function create(difficulty) {
    if (!created.length) { stage = 'empty-store-preflight'; emptyStoreProof(); }
    stage = 'create-ai'; creationPending = true;
    var result = await request('/api/ai', { difficulty: difficulty, humanColor: 'red',
      timeControl: { mode: 'normal', perMoveSeconds: null, totalSeconds: null } }, true);
    check(result && typeof result.gameId === 'string' && result.gameId && created.indexOf(result.gameId) < 0, 'CREATE_RESPONSE_INVALID');
    created.push(result.gameId); report.createdCount = created.length; creationPending = false;
    var current = await game(result.gameId); ownActive(current);
    check(current.difficulty === difficulty && current.turn === 'red' && current.history.length === 0 &&
      current.board.length === 90 && current.board.filter(Boolean).length === 32 && current.clock.deadline === null,
      'INITIAL_AI_STATE_INVALID');
    return current;
  }
  async function disconnectTestSocket(id) {
    tracked(id);
    stage = 'test-websocket';
    socket = (await wx.cloud.connectContainer({ config: { env: arg.env }, service: arg.service,
      path: '/ws?token=' + encodeURIComponent(token), timeout: 8000 })).socketTask;
    await new Promise(function(resolve, reject) {
      var done = false, timer;
      function finish(error) {
        if (done) return;
        done = true; clearTimeout(timer); error ? reject(error) : resolve();
      }
      timer = setTimeout(function() { finish(failure('WEBSOCKET_TIMEOUT')); }, 8000);
      socket.onOpen(function() { socket.send({ data: JSON.stringify({ type: 'subscribe', gameId: id }),
        fail: function() { finish(failure('WEBSOCKET_SEND_FAILED')); } }); });
      socket.onMessage(function(event) {
        var value;
        try { value = JSON.parse(event.data); } catch (_) { return; }
        if (value.type === 'error') return finish(failure(value.code));
        if (value.type === 'game' && value.game && value.game.id === id && value.game.status === 'active') finish();
      });
      socket.onError(function() { finish(failure('WEBSOCKET_ERROR')); });
      socket.onClose(function() { finish(failure('WEBSOCKET_CLOSED')); });
    });
    socket.close({}); socket = null;
  }
  try {
    check(arg && /^[a-z0-9-]+$/i.test(arg.env || '') && /^[a-z0-9-]+$/i.test(arg.service || ''), 'CLOUD_CONFIG_REQUIRED');
    emptyStoreProof();
    check(wx.cloud && typeof wx.cloud.init === 'function' && typeof wx.cloud.callContainer === 'function' &&
      (omitSocket || typeof wx.cloud.connectContainer === 'function'), 'SDK_UNAVAILABLE');
    var device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    report.physicalDevice = device.platform !== 'devtools';
    wx.cloud.init({ env: arg.env });
    stage = 'health';
    var health = await request('/api/health');
    check(health.ok === true && health.devMode === false && health.wechatConfigured === true && health.storage &&
      health.storage.kind === 'cloudbase' && health.storage.healthy === true, 'HEALTH_NOT_READY');
    report.checks.backendHealth = true;
    stage = 'wx.login';
    var code = await new Promise(function(resolve, reject) {
      var timer = setTimeout(function() { reject(failure('WX_LOGIN_TIMEOUT')); }, 8000);
      wx.login({ success: function(result) { clearTimeout(timer); result.code ? resolve(result.code) : reject(failure('WX_LOGIN_NO_CODE')); },
        fail: function() { clearTimeout(timer); reject(failure('WX_LOGIN_FAILED')); } });
    });
    stage = 'login';
    var login = await request('/api/login/wechat', { code: code }); code = '';
    check(login && login.token && login.user && login.user.id, 'LOGIN_RESPONSE_INVALID');
    token = login.token; userId = login.user.id; report.checks.wechatLogin = true;
    stage = 'identity';
    check((await request('/api/me', undefined, true)).user.id === userId, 'LOGIN_IDENTITY_MISMATCH');
    report.checks.identityConsistent = true;
    for (var difficulty = 1; difficulty <= 5; difficulty++) {
      var initial = await create(difficulty);
      stage = 'human-move';
      check(initial.legalMoves.some(function(move) { return move.id === '54-45' && move.from === 54 && move.to === 45; }), 'OPENING_MOVE_UNAVAILABLE');
      var moved = await action(initial, 'move', { moveId: '54-45' });
      check(moved && moved.id === initial.id && moved.history[0] && moved.history[0].source === 'human' &&
        moved.history[0].color === 'red' && moved.history[0].move.from === 54 && moved.history[0].move.to === 45, 'HUMAN_MOVE_NOT_APPLIED');
      stage = 'ai-reply';
      var deadline = Date.now() + 12000, replied = moved;
      while (replied.status === 'active' && replied.history.length === 1 && Date.now() < deadline) {
        await wait(150); replied = await game(initial.id);
      }
      ownActive(replied);
      check(replied.history.length === 2 && replied.history[1].source === 'ai' && replied.history[1].color === 'black' &&
        replied.turn === 'red' && replied.board.length === 90, 'AI_REPLY_NOT_APPLIED');
      if (replied.aiSource === 'deepseek') report.deepseekReplyCount++;
      else if (replied.aiSource === 'fallback') report.localReplyCount++;
      else throw failure('AI_SOURCE_INVALID');
      report.difficultyCount++;
      if (difficulty < 5) {
        stage = 'resign';
        var ended = await finishTestGame(initial.id);
        check(ended.status === 'finished' && ended.outcome && ended.outcome.rule === '认输' &&
          ended.outcome.winner === 'black' && ended.outcome.loserId === userId, 'RESIGN_RESULT_INVALID');
        resignations++;
      } else {
        if (!omitSocket) { await disconnectTestSocket(initial.id); report.disconnectChecked = true; }
        stage = omitSocket ? 'active-readback' : 'disconnect-readback';
        var unchanged = await game(initial.id); ownActive(unchanged);
        check(unchanged.history.length === 2 && unchanged.outcome === null,
          omitSocket ? 'GAME_ENDED_BEFORE_RESTART' : 'DISCONNECT_ENDED_GAME');
        report.checks.activeBeforeRestart = true;
        report.checks.disconnectKeepsActive = report.disconnectChecked;
        var replacement = await create(5);
        stage = 'restart-readback';
        var previous = await game(initial.id);
        check(previous.status === 'finished' && previous.outcome && previous.outcome.rule === '自动退出' &&
          previous.outcome.reason === '重新开局自动离开' && previous.outcome.winner === 'black' &&
          previous.outcome.loserId === userId && previous.seats.red === null && previous.resultSeats &&
          previous.resultSeats.red.id === userId && previous.outcome.winnerId === previous.resultSeats.black.id,
          'RESTART_FORFEIT_INVALID');
        report.checks.restartForfeitsPrevious = true;
        stage = 'resign-replacement';
        var last = await finishTestGame(replacement.id);
        check(last.status === 'finished' && last.outcome && last.outcome.rule === '认输' && last.outcome.loserId === userId,
          'RESIGN_RESULT_INVALID');
        resignations++;
      }
    }
    report.checks.fiveDifficulties = report.difficultyCount === 5;
    report.checks.humanMoves = report.difficultyCount === 5;
    report.checks.aiReplies = report.difficultyCount === 5;
    report.checks.resignations = resignations === 5;
    report.ok = Object.keys(report.checks).every(function(key) {
      return (key === 'disconnectKeepsActive' && omitSocket) || report.checks[key];
    });
  } catch (error) {
    report.failedStage = stage;
    report.errorCode = error && /^[A-Z_][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SDK_FAILURE';
    if (error && Number.isSafeInteger(error.errCode)) report.errCode = error.errCode;
    if (error && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) report.status = error.status;
    report.untrackedCreationPossible = creationPending && !(error && error.status >= 400 && error.status < 500);
  }
  if (socket) { try { socket.close({}); } catch (_) {} }
  report.cleanupComplete = !report.untrackedCreationPossible;
  for (var index = 0; index < created.length; index++) {
    try { check((await finishTestGame(created[index])).status === 'finished', 'TEST_CLEANUP_FAILED'); }
    catch (_) { report.cleanupComplete = false; }
  }
  if (!report.cleanupComplete) report.ok = false;
  token = ''; userId = '';
  report.hostAppUnchanged = JSON.stringify(getApp().globalData) === originalApp;
  if (!report.hostAppUnchanged) report.ok = false;
  return report;
  }
}
