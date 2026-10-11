import { readdirSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = process.argv[2] || process.env.ITO_HOST_ROOT;
if (!project) throw new Error('请提供 ITO 小程序工程的绝对路径');
const root = resolve(project);
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/host');
const app = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
const pages = [...app.pages, ...(app.subPackages || []).flatMap(pack => pack.pages.map(page => `${pack.root}/${page}`))];
const scripts = new Set();
const templates = new Set();
const styles = new Set();
const configs = new Set();
function script(file) {
  if (scripts.has(file)) return;
  if (!existsSync(file)) throw new Error(`依赖不存在：${relative(root, file)}`);
  scripts.add(file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${relative(root, file)} 语法错误\n${result.stderr}`);
  for (const match of readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    if (!match[1].startsWith('.')) throw new Error(`未解析 npm 依赖：${relative(root, file)} ${match[1]}`);
    const target = resolve(dirname(file), match[1]);
    script(target.endsWith('.js') ? target : `${target}.js`);
  }
}
function unit(name) {
  const base = resolve(root, name);
  if (configs.has(base)) return;
  configs.add(base);
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    if (!existsSync(`${base}.${ext}`)) throw new Error(`页面/组件缺少文件：${name}.${ext}`);
  }
  script(`${base}.js`);
  templates.add(`${name}.wxml`);
  styles.add(`${name}.wxss`);
  const config = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  for (const component of Object.values(config.usingComponents || {})) {
    if (component.startsWith('plugin://')) continue;
    unit(relative(root, component.startsWith('/') ? resolve(root, component.slice(1)) : resolve(dirname(base), component)));
  }
}
script(resolve(root, 'app.js'));
pages.forEach(unit);
styles.add('app.wxss');
for (const name of styles) {
  const file = resolve(root, name);
  for (const match of readFileSync(file, 'utf8').matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
    const imported = resolve(dirname(file), match[1]);
    if (!existsSync(imported)) throw new Error(`样式依赖不存在：${relative(root, imported)}`);
    styles.add(relative(root, imported));
  }
}
const compilerDir = process.env.WECHAT_COMPILER_DIR || [
  '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec',
  '/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec'
].find(path => existsSync(resolve(path, 'wcc')));
if (!compilerDir) throw new Error('未找到微信 WXML/WXSS 编译器');
mkdirSync(out, { recursive: true });
for (const [binary, targets, flags] of [['wcc', templates, ['-d']], ['wcsc', styles, ['-js']]]) {
  const target = resolve(out, `${binary}.js`);
  const result = spawnSync(resolve(compilerDir, binary), [...flags, '-o', target, ...targets], {
    cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024
  });
  if (result.status !== 0 || !existsSync(target)) throw new Error(`${binary} 编译失败\n${result.stderr}\n${result.stdout}`);
}
function bytes(folder) {
  return readdirSync(folder, { withFileTypes: true }).reduce((total, item) => {
    const file = resolve(folder, item.name);
    return total + (item.isDirectory() ? bytes(file) : readFileSync(file).length);
  }, 0);
}
const report = { project: root, mainPages: app.pages.length, chessPages: app.subPackages.find(pack => pack.root === 'chess').pages.length,
  javascriptFiles: scripts.size, components: configs.size - pages.length, chessSourceBytes: bytes(resolve(root, 'chess')),
  compilation: { wcc: '通过', wcsc: '通过' }, at: new Date().toISOString() };
writeFileSync(resolve(out, 'build-report.json'), JSON.stringify(report, null, 2));
console.info(JSON.stringify(report, null, 2));
