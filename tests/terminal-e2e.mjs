// The packaged client's terminal, end to end; 2026-09-16 (I3).
//
// Integration plan §6.2: this is the ONLY effective verification of node-pty's
// native rebuild and its asar-unpack rules. Neither `npm run typecheck` nor
// vitest can see the problem — the development tree has a node_modules and a
// prebuild for the Node ABI — and `npm start` cannot either, because it runs
// from that same tree. Only a PACKAGED client proves that:
//
//  · `node-pty` survived `packagerIgnore` and is inside the asar;
//  · `@electron/rebuild` produced a `pty.node` for this Electron's ABI;
//  · that binary and macOS's extensionless `spawn-helper` were unpacked to
//    `app.asar.unpacked/` (plugin-auto-unpack-natives plus `NATIVE_UNPACK`),
//    since a Mach-O inside an asar can be neither signed nor exec'd;
//  · the shell really starts, really runs a command, and its output really
//    reaches the panel through `beings:terminal-data`.
//
// Run it against `npm run package`'s output, never against `npm start`.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchDesktop } from './support/electron-lifecycle.mjs';
import { desktopExecutable } from './support/desktop.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'beings-terminal-'));
let app;
try {
  app = await launchDesktop({ executablePath: await desktopExecutable(), env: { ...process.env, PORTAL_DESKTOP_USER_DATA: directory } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', event => errors.push(event.message));
  // The client opens without a Being: the terminal is a local tool and must not
  // wait on a connection.
  await page.getByRole('button', { name: '连接我的 Being' }).waitFor();

  await page.getByRole('button', { name: '终端', exact: true }).click();
  const panel = page.locator('#terminal-panel');
  await panel.waitFor();
  // Opening an empty panel starts a session (terminal-panel.js `show`).
  await page.waitForFunction(async () => (await window.beings.terminal.state()).sessions.length === 1);
  const session = await page.evaluate(async () => (await window.beings.terminal.state()).sessions[0]);
  assert.equal(session.status, 'running', '打包后的客户端未能启动交互终端');
  assert.ok(session.pid > 0, 'PTY 没有进程号');
  assert.ok(path.isAbsolute(session.cwd), `终端工作目录不是绝对路径：${session.cwd}`);

  // xterm is mounted and sized: a fit that never ran leaves the default 80x24,
  // and the shell would wrap at the wrong column.
  await panel.locator('.xterm-screen').waitFor();
  await page.waitForFunction(async () => (await window.beings.terminal.state()).sessions[0].cols >= 2);

  // Type into xterm's own input, not through the bridge: this is the path a
  // person uses, and it is what proves `terminal.onData` → `beings:terminal-action`
  // → `pty.write` is connected.
  const input = panel.locator('.xterm-helper-textarea');
  await input.click();
  await input.type('echo being-desktop-terminal-ok');
  await input.press('Enter');

  // The shell echoed the command and then printed its output. Two occurrences
  // (the echo of the typed line, then the result) mean the PTY is a real
  // terminal rather than a pipe.
  const marker = 'being-desktop-terminal-ok';
  await page.waitForFunction(async ([id, marker]) => {
    const replay = await window.beings.terminal.read(id);
    return replay.data.split(marker).length - 1 >= 2;
  }, [session.id, marker], { timeout: 20000 });

  // And it reached the screen, which is the half `readTerminal` cannot prove:
  // the replay/live sequence protocol wrote it into xterm.
  await page.waitForFunction(
    marker => (document.querySelector('#terminal-panel .xterm-rows')?.textContent || '').includes(marker),
    marker,
  );

  // A second session, then close both: `close` must actually end the PTY, which
  // is what the client's own quit path depends on.
  await panel.getByRole('button', { name: '新建 交互终端' }).click();
  await page.waitForFunction(async () => (await window.beings.terminal.state()).sessions.length === 2);
  await page.evaluate(async () => {
    for (const item of (await window.beings.terminal.state()).sessions) await window.beings.terminal.close(item.id);
  });
  await page.waitForFunction(async () => (await window.beings.terminal.state()).sessions.length === 0);

  assert.deepEqual(errors, [], `渲染层报错：${errors.join(' / ')}`);
  console.log('终端 E2E 通过：打包客户端能启动 PTY、回显命令并关闭会话。');
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
