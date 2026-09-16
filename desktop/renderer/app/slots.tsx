// Where a Being Desktop feature attaches itself to the shell; 2026-09-16.
//
// The shell renders four regions it does not own: dockable panels beside the
// conversation (the tool browser, the console, the terminal, worker detail,
// feature tasks), sidebar sections, topbar actions, and full-page sheets behind
// `#place-sheet` (Town, Portal, the orchestration settings page).
//
// ── THE APPEND-ONLY ARRAYS ────────────────────────────────────────────────────
// These four arrays are two of the six shared lines the integration units share.
// Landing a surface is exactly two appended lines — one `import`, one array entry
// with a trailing comma. `page.tsx`, `sidebar.tsx` and `topbar.tsx` already read
// them and never change again.
//
// Sorting is by `order`, ascending, then by `key`, so an entry's position in the
// array carries no meaning and two branches appending at the end never fight.
// Pick an `order` in hundreds (100, 200, …) to leave room between neighbours.
//
// A slot component is mounted unconditionally once its predicate says so; it owns
// its own visibility, empty state and errors. The shell will not render a frame,
// a title bar or a placeholder for it.
import type { ComponentType, ReactNode } from 'react';
import { toolsAction, toolsPanel } from '../tools/slot';
import type { AppModel } from './models/app';

/** A dockable panel in the workspace body, after the tool browser. */
export interface PanelSlot {
  key: string;
  title: string;
  icon?: ReactNode;
  order: number;
  Panel: ComponentType<{ app: AppModel }>;
  /** The panel decides when it is on screen; the shell only mounts it. Called on
   * every shell render, so it must be cheap and must not change state. */
  visible: (app: AppModel) => boolean;
}

/** A section of the conversation sidebar. `placement` picks which of the three
 * existing regions it joins: the action buttons at the top, the scrolling session
 * list, or the Being footer. */
export interface SidebarSlot {
  key: string;
  order: number;
  placement: 'head' | 'scroll' | 'foot';
  Section: ComponentType<{ app: AppModel }>;
}

/** A control in the topbar's action row, before the overflow menu. */
export interface TopbarSlot {
  key: string;
  order: number;
  Action: ComponentType<{ app: AppModel }>;
}

/** A full page inside `#place-sheet`. `view` is the value of `app.view` it
 * answers for — the same string `app.navigate(view)` sets. */
export interface SheetSlot {
  key: string;
  view: string;
  Sheet: ComponentType<{ app: AppModel }>;
}

export const PANEL_SLOTS: PanelSlot[] = [
  toolsPanel,
];

export const SIDEBAR_SLOTS: SidebarSlot[] = [
];

export const TOPBAR_SLOTS: TopbarSlot[] = [
  toolsAction,
];

export const SHEET_SLOTS: SheetSlot[] = [
];
// ──────────────────────────────────────────────────────────────────────────────

/** The one ordering every region uses. `key` breaks a tie so the result does not
 * depend on which branch happened to be appended first. */
const byOrder = <T extends { key: string; order: number }>(a: T, b: T) => a.order - b.order || a.key.localeCompare(b.key);

export const visiblePanels = (app: AppModel): PanelSlot[] =>
  PANEL_SLOTS.filter(slot => slot.visible(app)).sort(byOrder);

export const sidebarSections = (placement: SidebarSlot['placement']): SidebarSlot[] =>
  SIDEBAR_SLOTS.filter(slot => slot.placement === placement).sort(byOrder);

export const topbarActions = (): TopbarSlot[] => [...TOPBAR_SLOTS].sort(byOrder);

/** Sheets for the current view. More than one may answer for a view; they render
 * in array order, since a sheet has no `order` of its own. */
export const viewSheets = (view: string): SheetSlot[] => SHEET_SLOTS.filter(slot => slot.view === view);
