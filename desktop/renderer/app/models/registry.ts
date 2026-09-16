// Where a Being Desktop feature attaches its model to `AppModel`; 2026-09-16.
//
// A slot component (../slots.tsx) is handed the `AppModel` and reads its own state
// from `app.features.<key>`. This is the table that puts it there: `AppModel`
// builds every registered model in its constructor and subscribes to each of them,
// so a feature's changes re-render the shell exactly like the built-in models do.
//
// ── THE APPEND-ONLY ARRAY ─────────────────────────────────────────────────────
// One of the six shared lines the integration units share: one `import`, one entry
// in `FEATURE_MODELS`, and one `declare module` block in the feature's own model
// file to give `AppFeatureModels` its key. Nothing else here changes.
//
// This file is under `models/`, so tests/architecture.test.ts forbids it importing
// components, hooks or React. Type-only imports are all it has, and factories must
// return a plain `Store` — never a component.
import type { DesktopAPI } from '../../../shared/types';
import type { Store } from '../../shared/models/store';

/** Each feature adds its key with a `declare module '.../models/registry'` block
 * in its own file, so landing a feature never edits this one. */
export interface AppFeatureModels {}

export interface FeatureModelFactory {
  key: keyof AppFeatureModels;
  /** `app` is the `AppModel` under construction. It arrives as `unknown` because
   * `AppModel` imports this file: take the members you need through a narrow
   * structural type at the call site, and never read state from it during
   * construction — the built-in models are not all built yet. */
  create(api: DesktopAPI, app: unknown): Store;
}

export const FEATURE_MODELS: FeatureModelFactory[] = [
];
// ──────────────────────────────────────────────────────────────────────────────
