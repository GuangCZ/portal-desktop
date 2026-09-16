// Kept as a path for one release; 2026-09-16.
//
// The I0 seam stage split this file into `channels/bridge.ts` (the two helpers)
// and `channels/chat.ts` (the conversation channels), so that `preload.ts` needs
// one import and one spread rather than a block per subsystem, and so that five
// integration units can add their channels without touching each other's lines.
// New code imports from `./channels`; this re-export exists so a branch cut before
// the split still builds after a rebase.
export { chat } from './channels/chat';
export { enveloped, subscribe } from './channels/bridge';
