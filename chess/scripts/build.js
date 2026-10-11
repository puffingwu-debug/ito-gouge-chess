import { readdirSync, readFileSync, mkdirSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const excluded = new Set(['node_modules', '.data', 'data', 'dist', '.git', 'verification']);
function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(item => excluded.has(item.name) ? [] : item.isDirectory() ? walk(resolve(folder, item.name)) : [resolve(folder, item.name)]);
}
const files = walk(root);
for (const file of files.filter(path => /\.m?js$/.test(path))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`JavaScript 语法错误：${relative(root, file)}\n${result.stderr}`);
}
for (const file of files.filter(path => path.endsWith('.json'))) JSON.parse(readFileSync(file, 'utf8'));
const mini = resolve(root, 'miniprogram');
const app = JSON.parse(readFileSync(resolve(mini, 'app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  if (!existsSync(resolve(mini, `${page}.${ext}`))) throw new Error(`小程序页面缺少文件：${page}.${ext}`);
}
for (const file of files.filter(path => path.startsWith(mini) && path.endsWith('.json'))) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  for (const component of Object.values(json.usingComponents || {})) {
    if (component.startsWith('plugin://')) continue;
    const path = component.startsWith('/') ? resolve(mini, component.slice(1)) : resolve(dirname(file), component);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) if (!existsSync(`${path}.${ext}`)) throw new Error(`组件文件缺失：${path}.${ext}`);
  }
}
mkdirSync(out, { recursive: true });
cpSync(resolve(root, 'web'), resolve(out, 'web'), { recursive: true });
const compilerDir = process.env.WECHAT_COMPILER_DIR || [
  '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec',
  '/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec'
].find(path => existsSync(resolve(path, 'wcc'))) || '';
const compilation = {};
for (const [binary, extension, output] of [['wcc', '.wxml', 'miniprogram-wxml.js'], ['wcsc', '.wxss', 'miniprogram-wxss.js']]) {
  const command = resolve(compilerDir, binary);
  if (!existsSync(command)) { compilation[binary] = '未验证：本机没有微信模板编译器'; continue; }
  const targets = files.filter(path => path.startsWith(mini) && path.endsWith(extension)).map(path => relative(mini, path));
  const result = spawnSync(command, [...(binary === 'wcsc' ? ['-js'] : ['-d']), '-o', resolve(out, output), ...targets], { cwd: mini, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  if (result.status !== 0 || !existsSync(resolve(out, output))) throw new Error(`${binary} 编译失败\n${result.stderr}\n${result.stdout}`);
  compilation[binary] = '通过';
}
const report = { javascriptFiles: files.filter(path => /\.m?js$/.test(path)).length, pages: app.pages.length, compilation, at: new Date().toISOString() };
writeFileSync(resolve(out, 'build-report.json'), JSON.stringify(report, null, 2));
console.info(`构建通过：${report.javascriptFiles} 个 JS 文件，${report.pages} 个微信页面；WXML ${compilation.wcc}，WXSS ${compilation.wcsc}。`);
