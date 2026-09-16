// Every Being Desktop subsystem's renderer-facing contract, in one import path;
// 2026-09-16.
//
// ── THE APPEND-ONLY RE-EXPORT ─────────────────────────────────────────────────
// This is one of the six shared lines the integration units share. A subsystem
// puts its types in its own `desktop/shared/<key>-types.ts` and appends one
// `export *` line here. Nothing else in this file changes.
//
// The rule in tests/architecture.test.ts that keeps `shared` pure applies to every
// file behind these lines: type-only, no node, no electron, no main, preload or
// renderer imports. The main process asserts its own IPC return types against
// these declarations, which is what keeps the two in step.
//
// Names must not collide across the files: `export *` silently drops a duplicate
// rather than failing, so prefix each subsystem's types the way `Chat*` does.
export * from './chat-types';
// ──────────────────────────────────────────────────────────────────────────────
