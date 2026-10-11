import { createApp } from './app.js';
import { createCloudStorage } from './cloud-storage.js';
export { createApp, createServer } from './app.js';

const cloudEnabled = process.env.CLOUD_STORAGE === 'true';
let storage, app;
try {
  if (cloudEnabled && process.env.DEV_MODE !== 'false') throw Object.assign(new Error(), { code: 'CLOUD_PRODUCTION_REQUIRED' });
  storage = cloudEnabled ? await createCloudStorage() : null;
  app = createApp({ storage }); await app.flush();
  const address = await app.listen();
  console.info(`狗哥下象棋已启动：http://${address.address}:${address.port}（${app.config.devMode ? '本地开发模式' : '正式模式'}）`);
} catch (error) {
  await app?.close().catch(() => {}); await storage?.close().catch(() => {});
  console.error(`象棋启动失败：${error.code || 'STARTUP_CONFIGURATION_OR_STORAGE_FAILED'}`);
  process.exit(1);
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => {
  try { await app.close(); process.exit(0); }
  catch { console.error('象棋关闭时云保存未完成'); process.exit(1); }
});
