import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const hostRoot = resolve(process.env.ITO_HOST_ROOT || '/Users/kunpengwu/Desktop/Desktop/2026年PV销售/00 BIPV项目工程 AI文件夹/ITO玻璃方阻热力值绘图/ITO方阻热力分析_微信小程序源码包');
const hostOptions = { skip: !existsSync(hostRoot) && 'ITO host is not installed; set ITO_HOST_ROOT' };

function harness() {
  const calls = [];
  const app = { globalData: { sheets: [{ name: 'ITO测试' }], settings: { scaleMin: 7, scaleMax: 16 } } };
  let authorization;
  let definition;
  const wx = {
    requirePrivacyAuthorize(options) { calls.push('privacy'); authorization = options; },
    chooseMedia(options) { calls.push('chooseMedia'); options.success({ tempFiles: [{ tempFilePath: '/test/photo.jpg' }] }); },
    showToast(options) { calls.push(['toast', options.title]); },
    showModal(options) { calls.push(['modal', options.title]); },
    showLoading() { calls.push('loading'); },
    hideLoading() {},
    openSetting() { calls.push('openSetting'); },
    createOffscreenCanvas() {
      calls.push('canvas');
      return { getContext: () => ({ fillRect() {}, fillText() {}, createLinearGradient: () => ({ addColorStop() {} }) }) };
    },
    canvasToTempFilePath(options) { options.success({ tempFilePath: '/test/heatmap.jpg' }); },
    saveImageToPhotosAlbum(options) { calls.push(['saveImage', options.filePath]); options.success(); }
  };
  const cache = new Map();
  function load(name) {
    let file = resolve(hostRoot, name);
    if (!extname(file)) file += '.js';
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, exports: module.exports, wx, getApp: () => app,
      Page(value) { definition = value; },
      require: value => load(resolve(dirname(file), value)),
      setTimeout
    }, { filename: file });
    return module.exports;
  }
  function page(name) {
    load(name);
    return {
      ...definition, data: structuredClone(definition.data),
      setData(patch) { Object.assign(this.data, patch); },
      selectAllComponents() { return [{ exportImage(done) { done(null); } }]; }
    };
  }
  return { calls, wx, app, page, load, get authorization() { return authorization; } };
}

test('photo selection waits for privacy approval and resumes OCR only after acceptance', hostOptions, async () => {
  const h = harness();
  const page = h.page('pages/input/input.js');
  page.runOCR = path => h.calls.push(['ocr', path]);
  const pending = page.takePhoto();
  assert.deepEqual(h.calls, ['privacy']);
  h.authorization.success({});
  await pending;
  assert.deepEqual(h.calls, ['privacy', 'chooseMedia', ['ocr', '/test/photo.jpg']]);
  assert.equal(page.data.imgUrl, '/test/photo.jpg');
});

test('declining photo privacy does not select, read, or upload an image', hostOptions, async () => {
  const h = harness();
  const page = h.page('pages/input/input.js');
  page.runOCR = () => assert.fail('OCR must not run after a privacy rejection');
  const pending = page.takePhoto();
  h.authorization.fail({ errMsg: 'requirePrivacyAuthorize:fail user deny' });
  await pending;
  assert.equal(h.calls.includes('chooseMedia'), false);
  assert.equal(page.data.imgUrl, '');
  assert.equal(page.data.ocrLoading, false);
});

test('heatmap export waits for privacy approval before generating or saving images', hostOptions, async () => {
  const h = harness();
  const page = h.page('pages/result/result.js');
  page.data.shown = [{ name: 'ITO测试', stats: { avg: 10, max: 11, min: 9, nonUniformity: 20, uniformity: 80 } }];
  const pending = page.saveImages();
  assert.deepEqual(h.calls, ['privacy']);
  h.authorization.success({});
  await pending;
  assert.equal(h.calls.includes('canvas'), true);
  assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'saveImage'), ['saveImage', '/test/heatmap.jpg']);
});

test('declining export privacy does not generate, save, or open album permission settings', hostOptions, async () => {
  const h = harness();
  const page = h.page('pages/result/result.js');
  page.data.mode = 'single';
  const pending = page.saveImages();
  h.authorization.fail({ errMsg: 'requirePrivacyAuthorize:fail user deny' });
  await pending;
  assert.equal(h.calls.includes('canvas'), false);
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'saveImage'), false);
  assert.equal(h.calls.includes('openSetting'), false);
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'modal'), false);
  assert.equal(page.data.mode, 'single');
});

test('missing privacy API stops photo and album operations and requests a WeChat update', hostOptions, async () => {
  const h = harness();
  delete h.wx.requirePrivacyAuthorize;
  await h.page('pages/input/input.js').takePhoto();
  await h.page('pages/result/result.js').saveImages();
  assert.deepEqual(h.calls, [
    ['toast', '请升级微信后再使用此功能'],
    ['toast', '请升级微信后再使用此功能']
  ]);
});

test('privacy helper preserves the original platform rejection', hostOptions, async () => {
  const h = harness();
  const { authorizePrivacy } = h.load('utils/privacy.js');
  const pending = authorizePrivacy();
  const error = { errMsg: 'requirePrivacyAuthorize:fail user deny', errCode: 112 };
  h.authorization.fail(error);
  await assert.rejects(pending, actual => actual === error);
});

test('exporting an empty result does not request personal information access', hostOptions, async () => {
  const h = harness();
  h.app.globalData.sheets = [];
  await h.page('pages/result/result.js').saveImages();
  assert.deepEqual(h.calls, [['toast', '没有可导出的热力图']]);
});
