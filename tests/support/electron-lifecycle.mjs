import { _electron as electron } from 'playwright';
import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const lockPath = path.join(os.tmpdir(), 'beings-electron-tests.lock');
async function acquire() {
  const owner = { pid: process.pid, id: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(owner)); } finally { await file.close(); }
      return async () => { try { if (JSON.parse(await readFile(lockPath, 'utf8')).id === owner.id) await unlink(lockPath); } catch { /* Already released. */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('桌面测试锁不可读取；请先检查是否还有测试运行。'); }
      try { process.kill(previous.pid, 0); } catch (failure) {
        if (failure.code === 'ESRCH') { await unlink(lockPath).catch(() => {}); continue; }
        throw failure;
      }
      throw new Error('已有桌面测试正在运行；本次不会启动第二个测试客户端。');
    }
  }
  throw new Error('未能取得桌面测试锁。');
}

export async function closeTestApplication(app, graceMs = 8000) {
  const child = app.process();
  let timer;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试客户端退出超时')), graceMs); }),
    ]);
  } catch (error) {
    // Only the process returned by this launch is eligible for cleanup.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function launchDesktop(options) {
  if (!options.env?.PORTAL_DESKTOP_USER_DATA) throw new Error('桌面测试必须使用独立临时配置。');
  // Ad-hoc macOS builds change their signature on every rebuild. Opt in to
  // Chromium's test keychain for UI checks without prompting for real secrets.
  // This switch is applied by the test launcher only, never by product code.
  if (process.platform === 'darwin' && options.env.PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN === '1') {
    options = { ...options, args: [...(options.args || []), '--use-mock-keychain'] };
    console.log('Keychain coverage: MOCK — UI fixture only; native keychain authorization is not tested.');
  }
  const release = await acquire();
  let app;
  try { app = await electron.launch(options); } catch (error) { await release(); throw error; }
  const child = app.process();
  const originalClose = app.close.bind(app);
  let cleanupPromise;
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const onSignal = () => { kill(); };
  const deadline = setTimeout(() => { console.error('桌面测试超过 5 分钟，停止该测试实例。'); process.exitCode = 1; kill(); }, 300000);
  deadline.unref();
  const cleanup = () => cleanupPromise ??= (async () => {
    clearTimeout(deadline);
    process.removeListener('exit', kill);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await release();
  })();
  process.once('exit', kill);
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  child.once('exit', () => { void cleanup(); });
  app.close = async () => { try { await closeTestApplication({ process: () => child, close: originalClose }); } finally { await cleanup(); } };
  app.on('window', page => page.setDefaultTimeout(15000));
  try { (await app.firstWindow()).setDefaultTimeout(15000); }
  catch (error) { kill(); await cleanup(); throw error; }
  return app;
}
