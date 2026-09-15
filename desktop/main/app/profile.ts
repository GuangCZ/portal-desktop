import { existsSync } from 'node:fs';
import path from 'node:path';

// Ported from BeingDesktop 0.8.26 (src/main.cjs `app.setName('Being Desktop')`
// plus every `app.getPath('userData')` reader); 2026-09-16.
// The profile directory name is the Electron application name, so this client
// must open BeingDesktop 0.8.x data in place: settings.json, desktop-id.json,
// chat-cache/, town-client/ and the recovery journals all live here.
export const PROFILE_DIRECTORY = 'Being Desktop';
export const PREVIOUS_PROFILE_DIRECTORY = 'portal-desktop';

/** BEING_DATA_DIR is BeingDesktop's name for an isolated profile;
 * PORTAL_DESKTOP_USER_DATA stays an alias so existing test profiles keep
 * pointing at the same directory. */
export function profileOverride(environment: NodeJS.ProcessEnv = process.env) {
  return environment.BEING_DATA_DIR || environment.PORTAL_DESKTOP_USER_DATA || undefined;
}

export function clientUserData(appData: string | (() => string), override?: string, exists = existsSync) {
  if (override) return path.resolve(override);
  const directory = typeof appData === 'function' ? appData() : appData;
  const current = path.join(directory, PROFILE_DIRECTORY);
  const previous = path.join(directory, PREVIOUS_PROFILE_DIRECTORY);
  // The product/executable rename must not turn an upgrade into a fresh setup.
  // Prefer an explicitly configured current profile, otherwise keep using the
  // previous profile in place so encrypted credentials and recovery journals are
  // neither copied while live nor silently abandoned.
  if (!exists(current) && exists(previous)) return previous;
  return current;
}
