import argparse
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('project')
parser.add_argument('--port', type=int, default=8787)
parser.add_argument('--report', required=True)
args = parser.parse_args()
source = ('function(){return new Promise(function(resolve){wx.request({'
          'url:"http://127.0.0.1:%d/api/health",'
          'success:function(r){resolve({status:r.statusCode,ok:r.data.ok})},'
          'fail:function(e){resolve({error:e.errMsg})}})})}') % args.port
result = subprocess.run([
    '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide', '-c', 'Codex',
    'automation_evaluate', '--project', args.project, '--fn-source', source
], capture_output=True, text=True, timeout=45)
start = result.stdout.find('{\n')
if start < 0:
    raise RuntimeError(result.stdout + result.stderr)
response = json.loads(result.stdout[start:])
if not response.get('ok'):
    raise RuntimeError(response)
probe = response['result']['result']['result']
passed = probe.get('status') == 200 and probe.get('ok') is True
Path(args.report).write_text(json.dumps({'passed': passed, 'probe': probe}, ensure_ascii=False, indent=2))
print(json.dumps({'passed': passed, 'probe': probe}, ensure_ascii=False))
raise SystemExit(0 if passed else 1)
