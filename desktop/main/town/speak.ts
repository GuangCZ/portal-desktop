// The one place an outgoing Town message is written; 2026-09-16.
//
// Ported from BeingDesktop 0.8.26 src/main.cjs `townSpeak` (line 390). It is a
// function rather than a method because two callers share it: TownSession's
// `writeImpl` (the bonfire path, which validates mentions first) and the fireside
// channel, which goes straight here (src/main.cjs line 1367).
//
// BeingDesktop tries the paired client first and falls back to the Being relay —
// BeingTownWriter, a Being turn with a journal — on exactly one code:
//
//     catch(error) { if(error?.code!=='AUTH_REQUIRED') throw error; }
//     return townWriter.send({...});
//
// The fallback exists because an unpaired profile could still speak through its
// Being. Integration decision §5.7 settles that it does not come across: the
// relay is not ported, and an unpaired profile is told to pair. The narrowness of
// BeingDesktop's condition is what makes that safe to do — only `AUTH_REQUIRED`
// ever reached the relay, so a real send failure was never masked by it and is
// not masked now either. `NOT_SENT` still means not sent and `RESULT_UNKNOWN`
// still means do not resend.
//
// The `relay` parameter is the seam left open for it: absent (the default) means
// the behaviour above; supplying one restores BeingDesktop's two-path write
// without touching a caller.
import type { TownSpeakReceipt } from './session/types';

/** What TownClient.speak / TownClient.sendDirectMessage need from a caller. */
export interface TownSpeakClient {
  speak(value: { kind: string; message: string; firesideId?: string; replyTo?: string }): Promise<TownSpeakReceipt>;
}

/** The request shape BeingDesktop's `townSpeak` takes, unchanged. `content` (not
 * `message`) is the caller's field name; `connectionRevision` and `requestId` are
 * carried for the relay and ignored by the direct path. */
export interface TownSpeakRequest {
  kind: string;
  content: string;
  firesideId?: string;
  connectionRevision?: unknown;
  requestId?: unknown;
  replyTo?: unknown;
}

/** The Being relay (BeingTownWriter), when one is wired. Not ported; §5.7. */
export type TownSpeakRelay = ((request: TownSpeakRequest) => Promise<unknown>) | undefined;

export const PAIRING_REQUIRED = '请用 Being 提供的六位配对码连接 Town。';

export interface TownSpeakOptions {
  client: TownSpeakClient;
  /** Left `undefined` by this unit. See the header. */
  relay?: TownSpeakRelay;
}

export function createTownSpeak({ client, relay }: TownSpeakOptions) {
  return async function townSpeak({ kind, content, firesideId = '', connectionRevision, requestId, replyTo = '' }: TownSpeakRequest): Promise<unknown> {
    try {
      return await client.speak({
        kind, message: content,
        ...(kind === 'fireside' ? { firesideId } : {}),
        ...(replyTo ? { replyTo: String(replyTo) } : {}),
      });
    } catch (error) {
      // Every other code is the send's own answer and is reported as it stands.
      if ((error as { code?: unknown } | null)?.code !== 'AUTH_REQUIRED') throw error;
      if (!relay) throw Object.assign(new Error(PAIRING_REQUIRED), { code: 'AUTH_REQUIRED' });
      return relay({ kind, content, firesideId, connectionRevision, requestId, replyTo });
    }
  };
}
