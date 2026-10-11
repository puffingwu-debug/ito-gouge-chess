# 微信原生小程序

本机当前导入目录：`/Users/kunpengwu/Desktop/Games/gouge-xiangqi`。根目录工程配置保留已有 AppID，并通过 `miniprogramRoot: 'miniprogram/'` 定位客户端源码。

微信开发者工具安装位置：`/Applications/wechatwebdevtools.app`。也可单独导入 `miniprogram` 子目录，使用其中的 `touristappid` 占位配置；两种方式各自读取所选工程根目录的配置。

## 本机开发

1. 在 `/Users/kunpengwu/Desktop/Games/gouge-xiangqi` 运行 `npm start`，服务默认监听 `http://127.0.0.1:8787`。
2. `miniprogram/config.js` 默认 `apiBase: 'http://127.0.0.1:8787'`、`development: true`。页面明确显示开发账号。`project.config.json` 的 `appid: 'touristappid'` 是占位配置，只供本地编译、界面与开发服务联调。
3. 本机根工程的 `project.private.config.json.setting.urlCheck` 已设为 `false`，允许模拟器连接本地 HTTP/WS 服务；该设置仅用于本机调试。同名 private 设置优先于公共配置，子目录配置不会自动应用于根工程。正式环境使用合法 HTTPS/WSS 域名并开启校验。
4. 点击首页「开发账号进入」。可创建 AI 对局、进入六桌大厅、选子落子、准备、旁观、请求或回应悔棋、修改资料。首页会核实最近本人对局并提供「继续对局」；正在进行的 AI 棋局离开页面后也可找回。开发账号不能调用微信真实语音，界面会给出明确错误。

本人棋局认证读取成功后，客户端保存 `gougeLastGame: {gameId,userId}`；离开或切后台不删除进行中记录。首页从服务器重新读取，已结束、403/404 或换账号时清除旧记录。退出账号前会检查最近棋局，仍在对弈或入座时引导先完成、认输或离座；网络失败时保留登录身份，避免开发账号丢失席位。没有恢复入口时不要清空微信本地缓存来处理正在进行的开发棋局。

设置中的默认时长自动保存到 `gougePreferences`，用于下一盘 AI 对局及桌主开局前的初始规则。落子声音默认关闭；启用后使用包内 `assets/move.wav`，仅在服务器确认棋谱增加时播放，重复快照、悔棋和刚恢复的历史不会播放。页面隐藏 / 卸载销毁音频上下文。语音播放偏好影响下一次加入房间后的耳机静音状态。底层加入房间先保持麦克风静音，再按当前有效的点击或按住意图开麦；修改偏好不会自动申请麦克风权限。

头像采用官方 `chooseAvatar`，昵称采用 `input type="nickname"`。昵称与头像由用户主动填写；`wx.login` 本身不读取头像或昵称。头像临时文件经 `wx.getFileSystemManager().readFile({encoding:'base64'})` 读取，提交 `/api/avatar`，再把返回的相对头像路径保存到 `/api/me`。当前服务器接受 PNG、JPEG、WebP，最大 1 MB；图片展示按 API 地址补齐绝对 URL。头像和昵称能力需要真机复核，开发者工具的昵称组件不完全等同于真机表现。

## 真机与正式环境

本机模拟器联调后，再使用自己注册的真实 AppID。不要把 AppSecret 或 DeepSeek 密钥放入小程序源码。

局域网调试时，手机与电脑应在同一可信局域网。后端需显式运行 `HOST=0.0.0.0 ALLOW_LAN_DEV=true npm start`，客户端 `apiBase` 改为电脑的局域网地址，例如 `http://你的电脑局域网IP:8787`；手机上的 `127.0.0.1` 指向手机本身。局域网开发账号模式不能验证微信登录和语音。真机是否允许调试 HTTP 连接取决于所用调试方式，正式路径应使用 HTTPS/WSS。

切到正式模式需完成以下配置：

- `project.config.json`：把 `touristappid` 换为实际 AppID，开启域名校验。
- `config.js`：设 `development: false`，`apiBase` 改为实际 HTTPS 服务地址。
- 后端环境：`DEV_MODE=false`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、HTTPS `PUBLIC_BASE_URL`；按需要配置 `DEEPSEEK_API_KEY`。服务密钥只保存在后端环境。
- 微信公众平台配置 request 合法域名和 socket 合法域名；客户端把 HTTPS 地址转换为 WSS，WebSocket 使用同一主机的 `/ws`。头像来自同一 HTTPS 服务主机；按实际发布包和后台要求核实相关图片访问域名。
- 真实登录调用 `wx.login` 获取 `code`，后端调用微信验证后返回本服务登录令牌。开发登录接口在正式模式下关闭。服务地址或模式变更后，旧客户端登录缓存不会复用。
- 依据真实应用场景确认普通小程序 / 小游戏项目形态及后台可用能力。此源码是 WXML/WXSS 原生小程序工程；未验证该象棋场景的实际账号类目、审核结论或小游戏迁移。

## 同桌实时语音

采用微信原生多人语音，不伪造连接成功。小程序后台「开发—接口设置」需实际开通对应组件权限；小游戏的入口是「游戏能力地图—实时语音」，不能把两个平台的配置视作相同。后端只有在真实微信会话及语音环境配置有效时才生成签名；`WECHAT_VOICE_ENABLED=true` 表示开发者确认已开通能力，不替代平台申请。

调用顺序：

1. 对局主屏的语音输入按钮支持点击持续开麦、再次点击关麦；未持续开麦时长按临时说话，松开立即静音。底部输出按钮可以单独加入并收听同桌声音，无需先开麦；已加入时切换收听。首次需要申请 `scope.record`。
2. 请求 `/api/voice/sign`。后端根据 `gameId` 验证席位并生成签名，微信 `session_key` 不传给前端。
3. 调用 `wx.joinVoIPChat({roomType:'voice',signature,nonceStr,timeStamp,groupId,muteConfig:{muteMicrophone:true,muteEarphone:!voiceSoundPreference}})`。成功后先保持麦克风静音；是否播放对方声音读取用户偏好，默认播放。只有当前仍有效的持续开麦或按住意图才会再请求开麦。
4. 调用 `wx.updateVoIPChatMuteConfig({muteConfig:{muteMicrophone,muteEarphone}})`；成功后才更新实际麦克风状态。按住 350 ms 后在手指仍按下时启动临时说话，短按/松手/取消均清除计时任务。WXML 同时处理 `touchstart`、`longpress`、`touchend`、`touchcancel` 和 `tap`，消费长按后的点击，避免松手变成持续开麦。授权、签名或原生加入尚未完成时松开，晚到成功也保持静音；开麦回调晚于松手静音时再补发静音。
5. 退出、切后台或页面卸载时调用 `wx.exitVoIPChat` 并释放后端预约。加入失败也释放预约；设备占用、授权失败、权限未开通等信息按微信或服务实际错误展示。

每个语音房间最多 10 人；后端把旁观语音席位限制为 8 人，为两位棋手预留位置。客户端每 20 秒发送 WebSocket `ping`，后端续期 45 秒的语音席位。连接断开、超过 45 秒未续期或收到不含自己的 `voiceMembers` 快照时，客户端退出微信语音。页面隐藏、离桌、触摸取消以及通话中断均收麦；原生退出失败会显示真实错误。棋局的后台继续与语音退出相互独立。

实际语音权限、真实微信登录、麦克风授权、多人音频质量、后台中断行为和 10 人房间均尚待后台配置与真机验证。根工程已有 AppID；当前服务健康接口返回微信与语音后端未配置。开发者工具已登录并完成 Codex 授权，这不代表小程序真实微信登录已验证；未上传代码或发布。

## 状态与计时

棋盘固定 90 个交点，合法目的地由服务器 `legalMoves` 提供。红方默认在下，黑方棋手默认翻转为自己在下；设置可固定红方在下，棋局也提供临时翻转。

每次确认的新落子播放手持移动 / 落子，吃子随后击飞离开棋盘并淡出，不再显示棋袋。视觉队列最多 3 手，不延后服务器计时或 AI 回应。自己回合点击棋盘会结束展示动画并正常选子；隐藏、翻转、断线、跳帧或悔棋时也追赶权威棋盘。

主屏保留紧凑双方信息、棋盘、当前回合、认输 / 离开与语音输入 / 输出。认输仅进行中的棋手可用，确认后判本人负。点击离开先关闭语音并返回；进行中的棋局继续计时，可回来接着下。成功创建 AI 对局或加入另一棋桌后，服务端自动退出本人旧的未完成对局并判负；等候桌只退出座位，新局校验失败及单纯旁观不会误判。

设置入口带当前 `gameId` 打开已有设置页，显示该局规则、计时详情、棋谱及其余辅助操作，同时保留个人资料和默认偏好。进入设置不离桌、不结束棋局、不重置计时；设置页接收实时状态，返回棋盘后重新同步。页面切换继续沿用隐藏时收麦规则。

棋手的「和棋」按钮提供协商申请与自然限着提和。协商申请由对方同意或拒绝，15 秒内继续计时，新落子后失效；自然限着是否满足由服务器核实。AI 使用服务端家庭模式的协商策略。旁观者没有申请或回应入口；旧快照不含 `draw` 字段时仍正常显示。

动作通过 HTTP 提交，包含 `version`、`turnId`、`operationId`。WebSocket 仅接收棋局 / 大厅状态；网络恢复后重新订阅并拉取权威快照。客户端以 `serverNow` 校时，每 250 ms 更新双时钟显示；累计用时只增加当前走棋方，自动走棋由服务器执行。悔棋申请期间继续计时，累计时间不退还。隐藏 / 卸载页面不会发送任何重置计时、自动落子或结束棋局指令；进行中离桌也不会自动认输。

## 已完成的验证

- 小程序 JS 通过 Node 语法检查，所有 JSON 可解析。
- 使用真实本地 HTTP 服务与小程序模块的模拟 `wx.request` 联调，验证开发登录、6 桌大厅、AI 创建、90 交点、选子与合法落子、昵称保存。此项验证客户端数据与实际后端契约，未验证微信运行时。
- `node --test tests/miniprogram.test.js` 的 24 项测试覆盖时钟、黑方朝向、静音加入语音 / 开麦字段、开发账号语音拒绝、加入失败释放席位、隐藏时棋局继续、和棋、恢复与身份切换、活跃局退出保护、默认计时、声音及设置页往返 / 权限 / 本局草稿，以及主屏认输、离开、收麦、终局原棋手身份及离桌棋局编号。微信接口被模拟。
- `node --test tests/voice.test.js` 的 16 项测试覆盖单击持续开关、长按临时说话、松手静音、独立静音加入收听、授权 / 加入延迟、迟到开麦、隐藏 / 断线、中断及错误反馈。微信接口仍以模拟回调验证，不代表实际设备已完成语音测试。
- `node --test tests/miniprogram-motion.test.js` 的 10 项测试覆盖无袋坐标、击飞淡出、悔棋、重复 / 跳帧快照、快速回应队列、翻转 / 隐藏取消、终局重复及动画期间及时选子；页面与微信选择器回调被模拟。
- 主任务构建使用本机微信开发者工具内置 WXML/WXSS 编译器；编译通过可确认源码语法，不能代表真机登录、语音权限或上线审核通过。
- 2026-10-08 已通过官方 `wechatide` 接口在真实模拟器验证首页、开发账号进入、AI 开局、红炮吃黑马、AI 黑车回应、双方收子袋及 AI 同意悔棋后恢复；退出开发者工具并正常启动后，工程首页仍可运行。截图及具体边界见 [验证记录](VERIFICATION.md)。
- 同日精简版已在真实模拟器验证无袋主屏、全宽语音双入口及实际设置页往返；原棋局、身份和准备状态保持。原收子袋截图属于之前版本的取证。
- 认输 / 离开版本在真实模拟器确认两个按钮各高 44px，语音入口无遮挡；本地服务更新后原桌已准备状态保持。判负行为由隔离服务 / 浏览器账号验证，未操作用户的棋局。

官方文档：[微信登录](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)、[头像昵称填写](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)、[多人音视频及人数限制](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/voip-chat.html)、[加入语音字段](https://developers.weixin.qq.com/miniprogram/dev/api/media/voip/wx.joinVoIPChat.html)、[更新静音字段](https://developers.weixin.qq.com/miniprogram/dev/api/media/voip/wx.updateVoIPChatMuteConfig.html)、[触摸与点击事件](https://developers.weixin.qq.com/miniprogram/dev/framework/view/tap.html)、[触摸事件对象](https://developers.weixin.qq.com/miniprogram/dev/framework/component-framework/event-object.html)。
