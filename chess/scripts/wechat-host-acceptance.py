import argparse
import json
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('project')
parser.add_argument('--profile-only', action='store_true')
args = parser.parse_args()
project = Path(args.project)
root = Path(__file__).resolve().parent.parent
evidence = root / 'verification'
cli = '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide'
keys = ['gougeSession', 'gougeLastGame', 'gougePreferences', 'gougeBoardSide', 'gougeGamePerspective', 'gougeGameControl']
checks = []
report = {'checks': checks, 'transport': 'real native wx.request + WebSocket, isolated local backend',
          'systemDialogReply': 'wx.showModal test injection', 'physicalDevices': False, 'profileSubmit': 'native form submit event injection; real HTTP persistence'}

def call(tool, *options):
    result = subprocess.run([cli, '-c', 'Codex', tool, '--project', str(project), *options],
                            capture_output=True, text=True, timeout=45)
    start = result.stdout.find('{\n')
    if start < 0:
        raise RuntimeError(result.stdout + result.stderr)
    response = json.loads(result.stdout[start:])
    if result.returncode or not response.get('ok'):
        raise RuntimeError(response)
    return response['result']

def evaluate(body, payload=None):
    options = ['--fn-source', 'function(arg){' + body + '}']
    if payload is not None:
        argument_file.write_text(json.dumps([payload], ensure_ascii=False))
        argument_file.chmod(0o600)
        options += ['--args-file', str(argument_file)]
    result = call('automation_evaluate', *options).get('result') or {}
    return result.get('result')

def wait_for(expression):
    report['lastWait'] = expression
    return evaluate('return new Promise(function(resolve,reject){var start=Date.now();function tick(){'
                    'var all=getCurrentPages(),p=all[all.length-1];if(p&&(' + expression + ')){resolve(true);return;}'
                    'if(Date.now()-start>12000){reject(new Error("native state wait timed out"));return;}'
                    'setTimeout(tick,80)}tick()})')

def check(label, condition=True):
    if not condition:
        raise AssertionError(label)
    checks.append(label)
    print(label, flush=True)

def tap(selector):
    call('automation_element_action', '--selector', selector, '--action', 'tap', '--wait-for-selector', selector)

def data(path):
    return call('automation_page_action', '--action', 'getData', '--data-path', path)['data']

def modal(confirm):
    call('automation_wx_api', '--action', 'mock', '--method', 'showModal',
         '--result', json.dumps({'confirm': confirm, 'cancel': not confirm}))

def screenshot(name):
    call('simulator_screenshot', '--path', str(evidence / name), '--optimize', 'false')

def ensure_home():
    for attempt in range(2):
        try:
            screenshot('ito-native-boot.png')
            page = call('automation_runtime_info', '--action', 'currentPage')['currentPage']
            if page['path'] == 'pages/index/index':
                return
        except Exception:
            if attempt:
                raise
        call('close_project_window')
        time.sleep(1)
        call('open_project_window', '--window-mode', 'fullMode')
    raise RuntimeError('Native home page did not launch')

def api(path, token=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

def remote_action(token, game_id, kind, **extra):
    game = api('/api/games/' + game_id, token)['game']
    return api('/api/games/' + game_id + '/action', token,
               {'type': kind, 'version': game['version'], 'turnId': game['turnId'], 'operationId': str(uuid.uuid4()), **extra})['game']

config_file = project / 'chess/config.js'
original_config = config_file.read_text()
if original_config.count('http://127.0.0.1:8787') != 1:
    raise RuntimeError('Expected exactly one local development API address before isolated testing')
original_storage = None
recovery_file = None
server = None
failure = None
with tempfile.TemporaryDirectory(prefix='ito-native-acceptance-') as temporary:
    argument_file = Path(temporary) / 'arguments.json'
    try:
        original_storage = evaluate('var present=wx.getStorageInfoSync().keys;return {ito:JSON.stringify(getApp().globalData),'
                                    'otherItems:present.filter(function(key){return arg.indexOf(key)<0}).sort().map(function(key){return {key:key,value:wx.getStorageSync(key)}}),items:arg.map(function(key){return {key:key,present:present.indexOf(key)>=0,value:wx.getStorageSync(key)}})}', keys)
        recovery_file = Path(tempfile.gettempdir()) / ('ito-native-storage-recovery-' + str(uuid.uuid4()) + '.json')
        recovery_file.touch(mode=0o600)
        recovery_file.write_text(json.dumps(original_storage, ensure_ascii=False))
        server_source = ('import {createApp} from "./server/app.js";const app=createApp({env:{DEV_MODE:"true",HOST:"127.0.0.1"},'
                         'dataDir:process.argv[1]});const a=await app.listen(0);console.log(JSON.stringify({port:a.port}));'
                         'process.on("SIGTERM",async()=>{await app.close();process.exit(0)});')
        server = subprocess.Popen(['node', '--input-type=module', '-e', server_source, str(Path(temporary) / 'data')],
                                  cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        address = json.loads(server.stdout.readline())
        base = 'http://127.0.0.1:' + str(address['port'])
        report['isolatedPort'] = address['port']
        call('close_project_window')
        config_file.write_text(original_config.replace('http://127.0.0.1:8787', base))
        time.sleep(1)
        call('open_project_window', '--window-mode', 'fullMode')
        ensure_home()
        evaluate('arg.forEach(function(key){wx.removeStorageSync(key)});return true', keys)
        tap('.chess-card'); tap('.login')
        wait_for('p.data.user && !p.data.busy')
        check('原生开发登录成功，首页无域名错误', not data('error'))
        session = evaluate('return wx.getStorageSync("gougeSession")')
        if session['apiBase'] != base:
            raise RuntimeError('Native API configuration does not match isolated backend')
        token = session['token']
        if not args.profile_only:
            tap('button.ai'); tap('[data-id="1"]'); tap('button.start')
            wait_for('p.data.game && p.data.game.status==="active" && p.data.connection==="已连接"')
            game = data('game')
            check('AI真实开局，90交点32棋子', len(data('cells')) == 90 and sum(bool(piece) for piece in game['board']) == 32)
            tap('[data-index="54"]'); check('选择棋子出现合法落点', data('selected') == 54 and any(cell['index'] == 45 and cell['destination'] for cell in data('cells')))
            tap('[data-index="45"]')
            wait_for('p.data.game && p.data.game.history.length===2 && !p.data.game.aiThinking')
            check('原生落子及真实AI回应，两手同步', data('game')['history'][0]['move']['from'] == 54)
            screenshot('ito-native-ai-game.png')
            ai_id = data('game')['id']
            tap('#game-settings-btn'); wait_for('p.data.game && p.data.game.id===' + json.dumps(ai_id))
            tap('#settings-undo-btn'); wait_for('p.data.game && p.data.game.history.length===0 && !p.data.gameBusy')
            check('AI同意悔棋后撤回双方两手')
            tap('#return-game-btn'); wait_for('p.data.game && p.data.game.id===' + json.dumps(ai_id))
            check('对局设置往返保持同一棋局', data('game')['id'] == ai_id)
            modal(False); tap('#game-resign-btn'); check('取消认输保留进行中棋局', api('/api/games/' + ai_id, token)['game']['status'] == 'active')
            modal(True); tap('#game-resign-btn'); wait_for('p.data.game && p.data.game.status==="finished"')
            check('确认认输判本方负', data('game')['outcome']['winner'] == 'black')
            tap('#game-leave-btn'); wait_for('p.route==="chess/pages/index/index"')
            tap('button.family'); wait_for('p.data.tables && p.data.tables.length===6 && p.data.connection==="已连接"')
            check('原生大厅六桌及WebSocket连接')
            tap('[data-id="1"][data-action="join"][data-color="red"]')
            wait_for('p.data.game && p.data.game.status==="waiting"')
            game_id = data('game')['id']
            black = api('/api/login/dev', body={'name': '原生验收黑方'})['token']
            api('/api/tables/1/join', black, {'color': 'black'})
            wait_for('p.data.game && p.data.game.seats.black')
            tap('#game-ready-btn'); api('/api/games/' + game_id + '/ready', black, {})
            wait_for('p.data.game && p.data.game.status==="active"')
            check('双方准备后原生玩家局开始')
            tap('[data-index="54"]'); tap('[data-index="45"]'); wait_for('p.data.game && p.data.game.history.length===1')
            game = api('/api/games/' + game_id, black)['game']
            pawn = next(move for move in game['legalMoves'] if move['from'] == 27 and move['to'] == 36)
            remote_action(black, game_id, 'move', moveId=pawn['id'])
            wait_for('p.data.game && p.data.game.history.length===2')
            tap('[data-index="45"]'); tap('[data-index="36"]'); wait_for('p.data.game && p.data.game.history.length===3')
            check('玩家双方同步与真实吃子', sum(bool(piece) for piece in data('game')['board']) == 31)
            screenshot('ito-native-pvp-capture.png')
            tap('#game-settings-btn'); wait_for('p.data.game && p.data.game.id===' + json.dumps(game_id))
            tap('#settings-undo-btn'); wait_for('p.data.game && p.data.game.undo')
            pending = api('/api/games/' + game_id, black)['game']['undo']
            remote_action(black, game_id, 'undo-respond', requestId=pending['id'], accept=False)
            wait_for('p.data.game && !p.data.game.undo && !p.data.gameBusy')
            check('对方拒绝悔棋时保留走子', len(data('game')['history']) == 3)
            tap('#settings-undo-btn'); wait_for('p.data.game && p.data.game.undo')
            pending = api('/api/games/' + game_id, black)['game']['undo']
            remote_action(black, game_id, 'undo-respond', requestId=pending['id'], accept=True)
            wait_for('p.data.game && p.data.game.history.length===2 && !p.data.gameBusy')
            check('对方同意后回退吃子并恢复棋子', sum(bool(piece) for piece in data('game')['board']) == 32)
            tap('#return-game-btn'); wait_for('p.data.game && p.data.game.id===' + json.dumps(game_id))
            modal(False); tap('#game-leave-btn'); check('取消离开保留原生棋盘', data('game')['id'] == game_id)
            modal(True); tap('#game-leave-btn'); wait_for('p.route==="chess/pages/index/index" && p.data.recentGame')
            check('离开仍保留活跃棋局', api('/api/games/' + game_id, black)['game']['status'] == 'active')
            tap('.resume-panel button'); wait_for('p.data.game && p.data.game.id===' + json.dumps(game_id))
            check('继续对局恢复同一棋局')
            tap('#game-leave-btn'); wait_for('p.route==="chess/pages/index/index"')
            tap('button.ai'); tap('button.start'); wait_for('p.data.game && p.data.game.mode==="ai"')
            old = api('/api/games/' + game_id, black)['game']
            check('离开后成功新开局，旧局自动判本方负', old['status'] == 'finished' and old['outcome']['winner'] == 'black')
            tap('#game-resign-btn'); wait_for('p.data.game && p.data.game.status==="finished"')
            tap('#game-leave-btn'); wait_for('p.route==="chess/pages/index/index"')
            red_other = api('/api/login/dev', body={'name': '旁观验收红方'})['token']
            black_other = api('/api/login/dev', body={'name': '旁观验收黑方'})['token']
            watched_id = api('/api/tables/2/join', red_other, {'color': 'red'})['gameId']
            api('/api/tables/2/join', black_other, {'color': 'black'})
            api('/api/games/' + watched_id + '/ready', red_other, {})
            api('/api/games/' + watched_id + '/ready', black_other, {})
            tap('button.family'); wait_for('p.data.tables && p.data.tables.length===6')
            tap('[data-id="2"][data-action="watch"]'); wait_for('p.data.game && p.data.spectator')
            spectator_before = data('game')
            tap('[data-index="54"]'); tap('[data-index="45"]')
            spectator_after = data('game')
            check('原生观棋模式禁止落子', not data('myColor') and data('selected') == -1 and not data('error') and spectator_before['board'] == spectator_after['board'] and spectator_before['version'] == spectator_after['version'] and spectator_before['history'] == spectator_after['history'])
            tap('#voice-input-btn'); wait_for('p.data.voice.error')
            check('开发账号语音限制有明确提示', '开发账号' in data('voice')['error'] and not data('voice')['microphone'])
            tap('#game-leave-btn'); wait_for('p.route==="chess/pages/index/index"')
            check('观棋离开释放对应棋局旁观席', all(user['id'] != session['user']['id'] for user in api('/api/games/' + watched_id, red_other)['game']['spectators']))
        tap('button.settings'); wait_for('p.data.name && !p.data.busy')
        screenshot('ito-native-profile-before.png')
        call('automation_element_action', '--selector', '#profile-name-input', '--wait-for-selector', '#profile-name-input', '--action', 'input', '--value', '原生验收棋友')
        screenshot('ito-native-profile-input.png')
        name_size = call('automation_element_action', '--selector', '#profile-name-input', '--action', 'size')
        check('原生昵称输入绑定正常且输入框完整显示', data('name') == '原生验收棋友' and name_size['width'] >= 250)
        call('automation_element_action', '--selector', 'form', '--action', 'trigger', '--type', 'submit', '--detail', json.dumps({'value': {'name': '原生验收棋友'}}))
        wait_for('p.data.saved && !p.data.busy'); screenshot('ito-native-profile-save.png')
        check('原生昵称表单提交保存并由后端返回', api('/api/me', token)['user']['name'] == '原生验收棋友')
        tap('button.logout'); wait_for('p.route==="chess/pages/index/index" && !p.data.user')
        check('象棋退出后返回象棋菜单且删除持久会话', evaluate('return wx.getStorageInfoSync().keys.indexOf("gougeSession")<0'))
        tap('#chess-return-tools'); wait_for('p.route==="pages/index/index"')
        check('完整对局后返回原工具首页')
    except Exception as error:
        failure = str(error)
        report['error'] = failure
        report['failedWait'] = report.get('lastWait')
        print('验收失败：' + failure, flush=True)
        try:
            screenshot('ito-native-failure.png')
        except Exception:
            pass
    finally:
        try:
            call('close_project_window')
            config_file.write_text(original_config)
            time.sleep(1)
            call('open_project_window', '--window-mode', 'fullMode')
            if original_storage is not None:
                evaluate('arg.items.forEach(function(item){if(item.present)wx.setStorageSync(item.key,item.value);else wx.removeStorageSync(item.key)});return true', original_storage)
                restored = evaluate('var present=wx.getStorageInfoSync().keys;return {ito:JSON.stringify(getApp().globalData),otherItems:present.filter(function(key){return arg.indexOf(key)<0}).sort().map(function(key){return {key:key,value:wx.getStorageSync(key)}}),items:arg.map(function(key){return {key:key,present:present.indexOf(key)>=0,value:wx.getStorageSync(key)}})}', keys)
                report['storageRestored'] = restored['items'] == original_storage['items']
                report['itoDataUnchanged'] = restored['ito'] == original_storage['ito']
                report['unrelatedStorageUnchanged'] = restored['otherItems'] == original_storage['otherItems']
                report['storageMismatchKeys'] = [a['key'] for a, b in zip(original_storage['items'], restored['items']) if a != b]
                check('测试后恢复原象棋会话，ITO数据与其他存储不变', report['storageRestored'] and report['itoDataUnchanged'] and report['unrelatedStorageUnchanged'])
            report['apiConfigRestored'] = config_file.read_text() == original_config
            ensure_home()
            screenshot('ito-delivery-home.png')
        except Exception as error:
            report['restoreError'] = str(error)
            failure = failure or str(error)
            print('恢复检查失败：' + str(error), flush=True)
        finally:
            config_file.write_text(original_config)
            if recovery_file:
                if report.get('storageRestored') and report.get('itoDataUnchanged') and report.get('unrelatedStorageUnchanged') and report.get('apiConfigRestored'):
                    recovery_file.unlink()
                else:
                    report['recoveryFile'] = str(recovery_file)
        if server:
            server.terminate()
            server.wait(timeout=15)
        report['passed'] = failure is None
        (evidence / 'wechat-host-functional-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(1 if failure else 0)
