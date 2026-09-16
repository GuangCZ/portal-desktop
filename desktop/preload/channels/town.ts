// The channels Town's direct reads, timeline and pairing add to the bridge;
// 2026-09-16.
//
// Names follow this shell's `beings:` prefix; BeingDesktop 0.8.26's own are
// `being:<camelCase>` (MIGRATION.md). The mapping is one to one with
// docs/interfaces.md §1.2「Town、篝火、围炉、卷轴、私信、Channel」and §1.3.
//
// Every channel here except none — all of them — is marked「Town 包络」in that
// table, so every method goes through `townEnveloped` rather than a bare
// `invoke`: a failure arrives as data and stays data all the way into the page's
// own world, where `desktop/preload/main-world.ts` rebuilds the Error carrying
// its `code`. `enveloped` from ./bridge does the same for the conversation
// channels, with the conversation code list; Town needs its own list and, for
// `NOT_SENT`, the candidate recipients Town offered
// (desktop/shared/town-desktop-errors.ts).
//
// `townEnveloped` used to be defined here and used to throw an Error. It moved
// into ./bridge.ts on 2026-09-17 (integration unit IN) and now throws the plain
// envelope: an Error rebuilt on this side of `contextBridge` arrives in the page
// with own properties ["message","stack"] and nothing else, so every code and
// every candidate list died here. MEASURED, twice, on Electron 44.2.0 —
// docs/migration/in-shell-errors.md §2 and docs/migration/im-integration.md §4.4.
//
// The public Town catalogue is NOT here. It stays on `beings:town` /
// `beings:town-open` and on `window.beings.town(...)` — a different surface, with
// no credential and no envelope (desktop/main/town/catalog.ts).
import { subscribe, townEnveloped } from './bridge';
import type {
  TownDesktopAPI, TownDesktopAppState, TownDesktopMemberCacheState, TownDesktopPush,
} from '../../shared/desktop-types';

export const townDesktop: TownDesktopAPI = {
  appState: () => townEnveloped('beings:town-app'),
  refreshApp: () => townEnveloped('beings:town-app-refresh'),
  timeline: feed => townEnveloped('beings:town-timeline', feed),
  refreshTimeline: feed => townEnveloped('beings:town-timeline-refresh', feed),
  loadOlder: feed => townEnveloped('beings:town-timeline-older', feed),
  read: request => townEnveloped('beings:town-read', request),
  bonfire: page => townEnveloped('beings:town-bonfire', page ?? {}),
  firesideMessages: request => townEnveloped('beings:town-fireside-messages', request),
  firesides: () => townEnveloped('beings:town-firesides'),
  firesideMembers: firesideId => townEnveloped('beings:town-fireside-members', firesideId),
  speak: request => townEnveloped('beings:town-speak', request),
  inbox: () => townEnveloped('beings:town-inbox'),
  beings: () => townEnveloped('beings:town-beings'),
  members: input => townEnveloped('beings:town-members', input),
  profileChanged: () => townEnveloped('beings:town-profile-changed'),
  scrolls: query => townEnveloped('beings:town-scrolls', query ?? {}),
  scroll: request => townEnveloped('beings:town-scroll', request),
  cached: selector => townEnveloped('beings:town-cached', selector),
  pair: input => townEnveloped('beings:town-client-pair', input),
  autoPair: () => townEnveloped('beings:town-client-auto-pair'),
  retryPairStorage: () => townEnveloped('beings:town-client-retry-storage'),
  forget: () => townEnveloped('beings:town-client-forget'),
  onState: callback => subscribe<TownDesktopAppState>('beings:town-state', callback),
  onMessages: callback => subscribe<TownDesktopPush>('beings:town-messages', callback),
  onMembersInvalidated: callback => subscribe<TownDesktopMemberCacheState>('beings:town-members-invalidated', callback),
};
