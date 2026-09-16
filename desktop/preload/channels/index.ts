// Every Being Desktop subsystem's slice of the renderer bridge, in one object;
// 2026-09-16.
//
// ── THE APPEND-ONLY OBJECT ────────────────────────────────────────────────────
// This is one of the six shared lines the integration units share. Landing a
// subsystem's channels is exactly two appended lines — one `import`, one property
// in `desktopChannels` with a trailing comma. Nothing else in this file changes,
// and `preload.ts` never changes again: it spreads this object.
//
// Each property's shape is declared on `DesktopAPI` (desktop/shared/types.ts), so
// a channel file that drifts from its contract fails typecheck here rather than
// at runtime in the renderer.
import { chat } from './chat';
import { terminal } from './terminal';
import { toolBrowser } from './tool-browser';
import { tools } from './tools';
import { orchestration } from './orchestration';
import { shellState } from './shell-state';
import { townDesktop } from './town';
import { channel } from './channel';

export const desktopChannels = {
  chat,
  terminal,
  toolBrowser,
  tools,
  orchestration,
  shellState,
  townDesktop,
  channel,
};
// ──────────────────────────────────────────────────────────────────────────────

export type DesktopChannels = typeof desktopChannels;
