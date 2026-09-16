// The two helpers every subsystem's channel file uses; 2026-09-16.
// Lifted out of desktop-channels.ts by the I0 seam stage, unchanged.
//
// Kept apart from the channel files so each of those is a plain object literal
// and nothing more, which is what makes `channels/index.ts` an append-only line
// per integration unit.
import { ipcRenderer } from 'electron';
import { chatErrorFromEnvelope, isChatErrorEnvelope } from '../../shared/chat-errors';

/** Subscribe to a main-process push. Returns the unsubscribe function the
 * renderer's effects expect. */
export function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Invoke a channel that answers a failure with data rather than an Error,
 * because a `code` cannot survive the trip (desktop/shared/chat-errors.ts).
 * This is the other half: BeingDesktop's src/preload.cjs lines 60-76, which turns
 * the envelope back into an Error the renderer branches on.
 *
 * Every subsystem whose IPC layer marks a channel「Town 包络」uses this, not only
 * the conversation channels — the envelope shape is one contract for all of them. */
export async function enveloped<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (isChatErrorEnvelope(result)) throw chatErrorFromEnvelope(result);
  return result as T;
}
