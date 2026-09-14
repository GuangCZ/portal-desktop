import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClientBrowser } from '../desktop/main/browser/browser';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    destroyed = false;
    navigationHistory = { getActiveIndex: () => 0, getAllEntries: () => [{}], goToIndex: vi.fn() };
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler() {}
    async loadURL() {}
    close() { this.destroyed = true; }
  }
  return { BrowserWindow: class {}, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) }, shell: { openExternal: vi.fn() },
    WebContentsView: class {
      webContents = new Contents();
      setVisible = vi.fn();
      setBounds = vi.fn();
    } };
});

function fixture() {
  const win = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; }, getContentSize: () => [1000, 800], contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
  const shell = Object.assign(new EventEmitter(), { getZoomFactor: () => 1 });
  Object.defineProperty(win, 'webContents', { get() { if (win.destroyed) throw new Error('Object has been destroyed'); return shell; } });
  const publish = vi.fn();
  const browser = new ClientBrowser(win as unknown as Electron.BrowserWindow, publish);
  return { win, browser, publish };
}

describe('browser lifecycle without starting Electron', () => {
  it('closes native contents when its window is gone and does not publish to a destroyed shell', () => {
    const { win, browser, publish } = fixture();
    browser.open('https://example.com/?token=fixture-secret');
    const view = win.contentView.addChildView.mock.calls[0][0];
    const calls = publish.mock.calls.length;
    win.destroyed = true;
    expect(() => win.emit('closed')).not.toThrow();
    expect(view.webContents.isDestroyed()).toBe(true);
    expect(publish).toHaveBeenCalledTimes(calls);
    expect(() => browser.close()).not.toThrow();
  });
  it('detaches a closed view once and ignores its late loading events', () => {
    const { win, browser } = fixture();
    browser.open('https://example.com/');
    const view = win.contentView.addChildView.mock.calls[0][0];
    browser.close(); browser.close();
    view.webContents.emit('did-start-loading');
    expect(browser.state.open).toBe(false);
    expect(browser.state.loading).toBe(false);
    expect(win.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });
});
