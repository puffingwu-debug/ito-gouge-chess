# 狗哥下象棋部署审阅材料

本目录提供单台服务器的部署参考。**尚未开通服务器或域名、未安装 Docker、未执行容器部署，也未验证公网证书或微信正式登录。** 开通收费资源和上线操作需取得用户授权后另行实施。复制本目录或上传小程序代码不会自动部署象棋后台。

## 适用范围

仅用于一台具有持久磁盘、能够常驻运行的 Linux 服务器。当前对局在一个 Node 进程内裁决，用户、会话、棋局和头像保存到 `/data`。Compose 为服务使用固定容器名与命名卷，后端端口仅在容器网络暴露；外部只通过 Caddy 的 80/443 进入。

**此包不能直接原样用于无持久盘、自动多实例或按请求启动的云托管/云函数。** 容器临时盘会丢数据，多进程会产生不同棋局与计时。若选择云托管，须先迁移共享持久存储、会话及对局裁决，并验证 HTTP/WebSocket 传输、实例路由、后台计时与重启恢复；这项迁移不包含在本材料中。单纯增加粘性会话不能解决多实例状态一致性。

## 待取得的配置

1. 用户同意的服务器、域名、预算和使用期限；域名解析到该服务器，并按微信后台及所选服务地区完成相应域名资格要求。
2. Docker Engine 与 Compose；公网 TCP 80、443 可达，供 HTTPS 证书签发及服务访问。服务器能访问微信登录服务；使用 DeepSeek 时还需能访问其 API。
3. 宿主同一小程序的真实 AppID、AppSecret；密钥只填在服务器私密环境文件。语音默认关闭，实际开通平台权限和真机验证后再启用。
4. 微信后台的 request 合法域名 `https://实际域名` 与 socket 合法域名 `wss://实际域名`；核实同源头像访问。发布端恢复域名/证书校验。

镜像采用官方 `node:22-alpine` 与 `caddy:2-alpine` 的现有主版本标签，不假定某个补丁版本。它们会随官方更新；部署验收时记录实际镜像摘要并验证升级。项目 `npm start` 使用的参数要求 Node 至少 22.9；容器直接通过 `node server/index.js` 启动，环境由 Compose 注入。

## 资源获批后的操作参考

以下命令在获批服务器的项目根目录执行，本轮未执行：

```sh
cp deploy/production.env.example deploy/.env.production
chmod 600 deploy/.env.production
# 用本地编辑器填写实际域名和微信凭证，不把密钥发到聊天。
docker compose --env-file deploy/.env.production -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.yml up -d --build
```

`CHESS_DOMAIN` 只填域名，`WECHAT_APP_ID` 与 `WECHAT_APP_SECRET` 留空时 Compose 拒绝启动。后端固定 `DEV_MODE=false`，关闭开发账号登录；缺少生产配置时后端自身也拒绝启动。DeepSeek 可留空使用本地 AI，不能据此宣称已验证 DeepSeek。不要运行会把解析后密钥打印出来的 `docker compose config`；上例使用 `--quiet`。

Docker 构建只允许包清单、`core/`、`server/`、`web/`，不传入 `.env`、现有 `.data`、微信工程或验收截图。`deploy/.env.production` 已由本目录 Git 忽略规则排除，仍须在任何 ZIP/上传流程中明确排除，不能仅依赖 Git 忽略。

Caddy 根据真实域名取得并维护 HTTPS 证书，将所有 HTTP 路径及 `/ws` WebSocket 升级转发到同一个后端。未配置访问日志，避免记录 `/ws?token=...` 的登录令牌；后续代理/监控也应屏蔽该查询参数。Caddy 配置目录挂载为只读，证书目录使用独立持久卷。服务重启会中断连接，客户端需重新同步；棋局与截止时间由持久化恢复。

服务验收通过后，另行修改宿主的 `chess/config.js`：`apiBase` 使用实际 HTTPS 地址，`development` 改为 `false`，并重新编译、真机验证和上传。此材料未修改宿主或本机 8787 的配置及棋局。

## 数据与维护

`gouge-xiangqi_chess_data` 卷包含用户资料、私密微信会话、对局和头像，应限制备份访问并验证恢复。备份在维护窗口停止棋局服务后复制完整卷，恢复前同样停止服务，不能让两个 Node 进程同时写该卷。停机不会暂停已保存的棋局时钟，重启会处理到期回合，维护应安排在没有进行中对局时。不要用 `docker compose down -v` 删除持久卷。服务器替换时须迁移并复核棋局卷及 Caddy 证书卷；不把备份随源码分享。

## 已验证与未验证

`node --test tests/deploy.test.js` 的 3 项测试通过：在临时目录和随机端口验证生产配置缺失时拒绝启动、健康接口、开发登录关闭、经 HTTP 代理的来源与 WebSocket 订阅、拒绝不允许的来源、会话/棋局重启恢复和状态文件权限。代理使用真实 Node HTTP/升级转发替身，微信服务使用边界替身；不验证 Caddy/TLS，也不发送真实微信凭证。本轮 `npm test` 369/369 通过，`npm run build` 通过（含 5 页 WXML/WXSS 编译）；Compose YAML 经 Ruby Psych 解析通过，未运行 Docker Compose。

尚未验证：Docker 镜像构建与容器卷权限、Compose 实际启动、Caddy 配置加载、真实 DNS/HTTPS/WSS、备份恢复、微信真实登录/语音、DeepSeek 凭证调用、手机联机及发布审核。不能将本机 Node 测试通过视为已部署或可直接发布。

参考：[Node 官方镜像](https://hub.docker.com/_/node)、[Caddy 官方镜像](https://hub.docker.com/_/caddy)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[WebSocket 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Node 环境文件参数](https://nodejs.org/api/cli.html#--env-file-if-existsfile)、[微信网络要求](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)。
