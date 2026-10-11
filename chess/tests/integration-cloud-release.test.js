import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const host = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const options = { skip: !existsSync(resolve(host, 'chess/services/deployment.js')) && 'Set ITO_HOST_ROOT to test integrated chess' };
const cloud = { transport: 'cloud', development: false, cloudEnv: 'gouge-chess-d1gubfb4x25bc5571', cloudService: 'gouge-chess' };

function check(config, flags = [], urlCheck = true) {
  const project = mkdtempSync(resolve(tmpdir(), 'chess-cloud-release-'));
  try {
    mkdirSync(resolve(project, 'chess/services'), { recursive: true });
    writeFileSync(resolve(project, 'chess/config.js'), 'module.exports = ' + JSON.stringify(config));
    copyFileSync(resolve(host, 'chess/services/deployment.js'), resolve(project, 'chess/services/deployment.js'));
    writeFileSync(resolve(project, 'project.config.json'), JSON.stringify({ appid: 'wxbb23c109d761ccbd', setting: { urlCheck } }));
    const result = spawnSync(process.execPath, ['scripts/check-release.mjs', '--project', project, ...flags], { encoding: 'utf8' });
    return { status: result.status, report: JSON.parse(result.stdout) };
  } finally { rmSync(project, { recursive: true, force: true }); }
}

test('cloud release CLI accepts static configuration without pretending to perform authenticated SDK health checks', options, () => {
  const { status, report } = check(cloud, [], false);
  assert.equal(status, 0); assert.equal(report.transport, 'cloud'); assert.equal(report.verification, 'static-only');
  assert.equal(report.checks.staticConfiguration, true); assert.equal(report.checks.backendHealth, false);
  assert.ok(report.warnings.some(warning => warning.includes('微信 SDK 实测')));
});

test('cloud release CLI rejects missing environment/service and development fallback', options, () => {
  for (const override of [{ cloudEnv: '' }, { cloudService: '' }, { development: true }]) {
    const { status, report } = check({ ...cloud, ...override }, ['--offline']);
    assert.equal(status, 1); assert.equal(report.passed, false); assert.equal(report.checks.backendHealth, false);
  }
});

test('HTTP release CLI retains HTTPS and legal-domain checks, and a cloud health override cannot point at local HTTP', options, () => {
  const local = check({ transport: 'http', development: false, apiBase: 'http://127.0.0.1:8787' }, ['--offline'], false);
  assert.equal(local.status, 1); assert.ok(local.report.errors.some(error => error.includes('合法域名')));
  const invalidHealth = check(cloud, ['--health-url', 'http://127.0.0.1:8787']);
  assert.equal(invalidHealth.status, 1); assert.ok(invalidHealth.report.errors.some(error => error.includes('--health-url')));
});
