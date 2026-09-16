// The three helpers every subsystem's channel file uses; 2026-09-16.
// Lifted out of desktop-channels.ts by the I0 seam stage; `townEnveloped` moved
// here from ./town.ts on 2026-09-17 (integration unit IN) so that both channel
// families share one decision about where the Error is rebuilt.
//
// Kept apart from the channel files so each of those is a plain object literal
// and nothing more, which is what makes `channels/index.ts` an append-only line
// per integration unit.
import { ipcRenderer } from 'electron';
import { chatErrorFromEnvelope, chatErrorPayload, isChatErrorEnvelope } from '../../shared/chat-errors';
import { isTownErrorEnvelope, townErrorFromEnvelope, townErrorPayload } from '../../shared/town-desktop-errors';

/** Subscribe to a main-process push. Returns the unsubscribe function the
 * renderer's effects expect. */
export function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ── WHERE THE ERROR IS REBUILT ────────────────────────────────────────────────
//
// Normally: nowhere here. The envelope is rejected as a PLAIN OBJECT, crosses
// `contextBridge` whole, and `desktop/preload/main-world.ts` turns it into an
// Error inside the page's own world. Rebuilding it here instead is what used to
// throw the code away — MEASURED on Electron 44.2.0, an Error leaving the
// preload keeps only `message` and `stack` (that file's header carries the whole
// measurement; docs/migration/in-shell-errors.md §2).
//
// The exception is the fallback below, for a build of Electron without
// `contextBridge.executeInMainWorld` (it is marked experimental in
// electron.d.ts). There, an Error rebuilt here is what 0.8.26 shipped: the
// sentence still reaches the user and only the code is lost, which is strictly
// better than handing the renderer a plain object — `publicErrorMessage`
// (desktop/shared/errors.ts) would print「[object Object]」for one of those.
let rebuildHere = false;

/** Called by preload.ts only when the page's world could not be given the
 * decoder. One-way and set before the page can call anything. */
export function rebuildEnvelopesInPreload(): void {
  rebuildHere = true;
}

/** Whether this preload is running on the fallback path. Exported for the test
 * that pins the default, not for the channel files. */
export const envelopesAreRebuiltInPreload = (): boolean => rebuildHere;

/** Invoke a channel that answers a failure with data rather than an Error,
 * because a `code` cannot survive the trip (desktop/shared/chat-errors.ts).
 *
 * Every subsystem whose IPC layer marks a channel「Town 包络」uses this, not only
 * the conversation channels — the envelope shape is one contract for all of them. */
export async function enveloped<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isChatErrorEnvelope(result)) return result as T;
  throw rebuildHere ? chatErrorFromEnvelope(result) : chatErrorPayload(result);
}

/** The same for a Town channel: Town's own code catalogue, and — for `NOT_SENT` —
 * the candidate recipients Town offered beside the message
 * (desktop/shared/town-desktop-errors.ts). */
export async function townEnveloped<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isTownErrorEnvelope(result)) return result as T;
  throw rebuildHere ? townErrorFromEnvelope(result) : townErrorPayload(result);
}
