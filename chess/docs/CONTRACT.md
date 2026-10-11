# 实现契约

## 目录职责
core/ 规则、搜索和纯计时逻辑；server/ 权威服务；web/ 浏览器本地试玩；miniprogram/ 原生微信小程序。

## 棋盘
90 项数组。索引 y*9+x，x=0..8，y=0..9，黑方在上，红方在下。
空位 null。棋子 {id:string,color:'red'|'black',type:'K'|'A'|'E'|'H'|'R'|'C'|'P'}。
走法 {id:'from-to',from:number,to:number}。

公开 history 每步新增 captured: piece|null，由服务端原始 boardBefore[move.to] 还原。棋袋按吃子方与历史顺序派生，不在客户端独立保存；悔棋删去对应历史，重赛为空。动画只响应核实的一手新增，最多展示 3 手；跳帧、悔棋、隐藏或用户开始选子时追赶最新权威棋盘，时钟始终读取最新快照。

core/xiangqi.js 导出 createInitialBoard(), getLegalMoves(board,color), applyMove(board,move), isInCheck(board,color), createHistoryEntry(board,move,color), getOutcome(board,turn,history), rankMoves(board,color,difficulty,options), chooseAutoMove(board,color)。
getOutcome 返回 null 或 {winner:'red'|'black'|null,reason:string,rule:string}。
createHistoryEntry 必须含 boardBefore,boardAfter,move,color；可添加 check/chase 等裁决元数据。
rankMoves 同步返回降序合法候选 {id,from,to,score} 数组。options 支持 budgetMs/maxNodes，不能无限搜索。

core/clock.js 导出 normalizeTimeControl(input), getDeadline(control,usedMs,turnStartedAt), clockSnapshot(control,used,turn,turnStartedAt,now)。
timeControl={mode:'normal'|'rapid',perMoveSeconds:60|null,totalSeconds:600|null,overtimeSeconds:20,rapidSeconds:15}。
getDeadline 返回毫秒时间戳或 null。used={red:毫秒,black:毫秒}。
clockSnapshot={red:{usedMs,totalRemainingMs,phase},black:{usedMs,totalRemainingMs,phase},deadline,remainingMs}。phase='total'|'overtime'|'per-move'|'unlimited'|'rapid'。

## HTTP JSON API
错误 {error:中文说明,code:标识}。Authorization: Bearer TOKEN。
- GET /api/health -> {ok,devMode,deepseekConfigured,wechatConfigured,voiceConfigured,ruleCoverage?}
- POST /api/login/dev {name} -> {token,user}，仅 DEV_MODE=true。
- POST /api/login/wechat {code} -> {token,user}
- GET /api/me -> {user}
- PATCH /api/me {name,avatar?} -> {user}；头像可使用 POST /api/avatar {dataUrl} -> {avatar}。
- GET /api/lobby -> {tables:[{id:1..6,status,seats:{red:user|null,black:user|null},spectatorCount,gameId}]}
- POST /api/ai {difficulty:1..5,humanColor,timeControl} -> {gameId}。先验证参数；成功创建新局时，自动退出本人旧棋局。
- POST /api/tables/:n/join {color?} -> {gameId}。先验证目标座位；成功进入另一局时，自动退出本人旧棋局。重进原局不触发。
- POST /api/tables/:n/watch {} -> {gameId}
- POST /api/tables/:n/leave {gameId?} -> {ok}。客户端携带当前显示的棋局编号，只退出该局，避免旧记录页误退同桌新棋局。进行中棋手返回后仍保留席位及计时；等候、已结束及旁观成员可退出。省略 gameId 的旧客户端按当前桌处理。
- GET /api/games/:id -> {game:SNAPSHOT}
- POST /api/games/:id/ready {timeControl?} -> {game:SNAPSHOT}。ownerId 指定的玩家可设规则，另一玩家确认。
- POST /api/games/:id/action {type,version,turnId,operationId,...} -> {game:SNAPSHOT}
  type='move' (moveId), 'undo-request', 'undo-respond' (requestId,accept), 'draw-request', 'draw-respond' (requestId,accept), 'draw-claim', 'resign', 'rematch'。
- POST /api/voice/sign {gameId} -> {signature,nonceStr,timeStamp,groupId,openid}，真实微信会话才可。
- POST /api/voice/leave {gameId} -> {ok}

## SNAPSHOT
{id,tableId:null|1..6,mode:'ai'|'pvp',status:'waiting'|'active'|'finished',board,turn:'red'|'black',version,turnId,ownerId,seats:{red:user|null,black:user|null},ready:{red:boolean,black:boolean},timeControl,clock,history:[{move,color,notation?,source:'human'|'ai'|'auto',at,captured:棋子|null}],lastMove:null|{from,to},outcome:null|{winner,reason,rule},undo:null|{id,requesterId,expiresAt,targetPly},draw:null|{id,requesterId,expiresAt},spectators:[user],difficulty,aiThinking,aiSource,aiDetail,serverNow,legalMoves:[{id,from,to}],voiceMembers?:[user]}。
公开 user={id,name,avatar?,kind?:'ai'|'human'}，不暴露微信 session_key/openid。
当前行动玩家和旁观者可获取 legalMoves（旁观者仍无操作权限）。

成功开新局时，旧 active 棋局先结算用时、取消 AI 与协商请求，以对手获胜结束，并释放本人席位及语音预约；旧 waiting 棋局只释放席位并重置双方准备。新局校验失败、重进原局及单纯观棋不触发判负。旧棋局保留历史读取权限；finished 的 `resultSeats` 保存原双方公开身份，`outcome.winnerId/loserId` 保存对应用户编号，实际席位与操作权限仍以 `seats` 为准。已有结局的桌接纳新棋手时使用新棋局编号，避免覆盖旧棋谱与身份。

## WebSocket
URL /ws?token=TOKEN。
客户端 {type:'subscribe',gameId}；服务端 {type:'game',game:SNAPSHOT}。
连接成功/大厅变更发送 {type:'lobby',tables}。
客户端可发 {type:'ping'}，服务端 {type:'pong',serverNow}。
动作走 HTTP，ws 仅推送状态。前端每秒本地计算显示，服务端处理截止及恢复。

## 计时/悔棋
独立累计思考时间，总额度在当前手用尽当刻启动 overtimeSeconds，普通本手截止不重置，取早者。
悔棋申请 15 秒，继续计时；版本变化即失效；回到申请者最近一手之前，包括随后对方一手；接受前结算当前玩家用时，不退累计时间，回滚后开始新手。
所有走棋/同意操作先处理到期回合。旧版本、旧回合、重复操作不能再次生效。

## 美术
纸色 #f6f0e5、木色 #d8b889、朱红 #a8322e、墨黑 #252c26、松绿 #2f5648。
宋体棋字/标题，系统中文无衬线正文；移动优先，触控至少44px；低动效，清楚可读。
