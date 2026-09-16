// Added for the BeingDesktop 0.8.26 port on 2026-09-16.
// The only module of this migration unit that touches Electron: it binds the
// real WebContentsView / session / BrowserWindow to the ElectronBrowserHost
// shapes that browser.ts consumes. BeingDesktop passed these three values in
// from src/main.cjs boot() (see docs/migration/u5-terminal-browser.md), so the
// integration phase can either call this factory or keep passing them by hand.
// Not unit-tested: it contains no logic beyond the binding.

import { WebContentsView, session } from 'electron';
import { DesktopBrowser } from './browser';
import type { BrowserHostWindow, BrowserSessionFactory, BrowserViewConstructor, ElectronBrowserHost } from './host';
import type { BrowserSnapshot } from './types';

/** Binds the live Electron APIs to the injected host DesktopBrowser expects. */
export function createElectronBrowserHost(getWindow: () => Electron.BrowserWindow | null | undefined): ElectronBrowserHost {
  return {
    WebContentsView: WebContentsView as unknown as BrowserViewConstructor,
    session: session as unknown as BrowserSessionFactory,
    getWindow: () => getWindow() as unknown as BrowserHostWindow | null | undefined,
  };
}

/** Convenience wiring for the integration phase: the Electron-backed browser. */
export function createElectronBrowser(
  getWindow: () => Electron.BrowserWindow | null | undefined,
  onChange: (snapshot: BrowserSnapshot) => void = () => {},
): DesktopBrowser {
  return new DesktopBrowser({ ...createElectronBrowserHost(getWindow), onChange });
}
