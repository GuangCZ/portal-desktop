// Which answer a pushed draft gets, decided in one place; 2026-09-16
// (integration unit I7, review follow-up).
//
// The main process needs to know WHY a draft was refused: an occupied composer
// asks the user to send or clear what they wrote (「已有草稿，已保留原文；…」), an
// unmounted or disconnected one asks them to wait (「对话页面尚未准备好，请稍后重
// 试。」). BeingDesktop decided this inside the Loom page it injected into
// (src/town.cjs lines 130-137) and reported the reason back as a string; the
// native path decides it here and reports it through the same three words.
//
// It lives in this unit rather than in the bridge that calls it
// (app/hooks/use-conversation-bridge.ts) because it is this unit's contract and
// this unit's test: the bridge is a shared file, and a rule nobody can run on its
// own is a rule that drifts.
import type { ChannelDraftAck } from '../../shared/channel-types';

/** What `placeChannelDraft` needs from the conversation. Structural on purpose —
 * `ConversationModel` satisfies it, and so does a three-line test double. */
export interface DraftTarget {
  readonly disabled: boolean;
  readonly composer: { readonly text: string };
  placeDraft(text: string): boolean;
}

/**
 * BeingDesktop's order of refusals, kept exactly (src/town.cjs lines 133-137):
 *
 *   1. no usable input          → `missing_input`   → 「未找到可用的 Loom 输入框…」
 *   2. `field.value !== ''`     → `existing_draft`  → 「…已有草稿，已保留原文…」
 *   3. otherwise fill and focus → `prepared`
 *
 * Step 2 is a comparison against the EMPTY STRING, not a trimmed one: a composer
 * holding nothing but a newline the user typed is still the user's, and the
 * quotation that would overwrite it is not urgent enough to take it. The
 * conversation model's own `placeDraft` trims (conversation/models/conversation.ts
 * `placeDraft`), which is the right rule for the button the user just pressed
 * themselves and the wrong one for a draft arriving from elsewhere — so the
 * stricter test is made here, where the draft arrives.
 */
export function placeChannelDraft(target: DraftTarget, text: string): ChannelDraftAck {
  if (target.disabled) return 'unavailable';
  if (target.composer.text !== '') return 'occupied';
  return target.placeDraft(text) ? 'placed' : 'occupied';
}
