import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const project = value('--project');
if (!project) throw new Error('用法：node scripts/check-release.mjs --project <小程序工程绝对路径> [--offline] [--health-url <HTTPS健康检查域名>] [--report <报告路径>]');
const root = resolve(project);
const require = createRequire(import.meta.url);
const config = require(resolve(root, 'chess/config.js'));
const { releaseErrors } = require(resolve(root, 'chess/services/deployment.js'));
const errors = releaseErrors(config);
const warnings = [];
const cloudTransport = config.transport === 'cloud';
const healthBase = value('--health-url') || (!cloudTransport && config.apiBase);
if (value('--health-url') && releaseErrors({ development: false, apiBase: healthBase }).length) errors.push('--health-url 必须使用 HTTPS 公网域名。');
const readJson = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const publicConfig = readJson('project.config.json');
let privateConfig = {};
try { privateConfig = readJson('project.private.config.json'); }
catch (err) { if (err.code !== 'ENOENT') throw err; }
if (!/^wx[0-9a-f]{16}$/.test(publicConfig.appid || '')) errors.push('请配置真实小程序 AppID。');
if ((privateConfig.setting?.urlCheck ?? publicConfig.setting?.urlCheck) === false) {
  if (cloudTransport) warnings.push('云托管使用微信 SDK 通道，不依赖自有请求域名；仍须完成开启域名校验的真机验收。');
  else errors.push('正式预览须开启合法域名校验，不能以跳过校验的本机结果作为上线验收。');
}
const report = { at: new Date().toISOString(), project: root, transport: cloudTransport ? 'cloud' : 'http', verification: 'static-only', errors, warnings,
  checks: { staticConfiguration: errors.length === 0, backendHealth: false },
  limitations: ['本检查不代替真实微信登录、WebSocket 对战、文字聊天和 Android/iOS 真机验收。'] };
if (!errors.length && !args.includes('--offline') && healthBase) {
  report.verification = 'https-health';
  try {
    const response = await fetch(healthBase.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const health = await response.json();
    if (health.ok !== true) errors.push('象棋服务健康检查未通过。');
    if (health.devMode !== false) errors.push('服务器仍启用了开发账号，请设置 DEV_MODE=false。');
    if (health.wechatConfigured !== true) errors.push('服务器尚未配置真实微信登录。');
    warnings.push('文字聊天须通过微信云函数实测；对战健康接口不能代替聊天验收。');
    if (health.deepseekConfigured !== true) warnings.push('DeepSeek 尚未配置，AI 使用本地棋力引擎。');
    report.checks.backendHealth = health.ok === true && health.devMode === false && health.wechatConfigured === true;
  } catch (err) { errors.push('公网 HTTPS 后端检查失败：' + err.message); }
} else if (cloudTransport && !args.includes('--offline')) {
  warnings.push('云托管在线健康检查需通过微信 SDK 实测；本报告仅静态校验，backendHealth=false，不能宣称线上服务已就绪。');
} else if (args.includes('--offline')) {
  warnings.push('未执行公网健康检查，此结果仅验证源码配置。');
}
report.passed = errors.length === 0;
if (value('--report')) {
  const path = resolve(value('--report'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}
console.info(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
