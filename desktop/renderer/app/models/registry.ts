// Where a Being Desktop feature attaches its model to `AppModel`; 2026-09-16.
//
// A slot component (../slots.tsx) is handed the `AppModel` and reads its own state
// from `app.features.<key>`. This is the table that puts it there: `AppModel`
// builds every registered model in its constructor, then subscribes to and starts
// each of them from its own `start()`, so a feature's changes re-render the shell
// and a feature's subscriptions live and die with the shell's — exactly like the
// built-in models do.
//
// ── THE APPEND-ONLY ARRAY ─────────────────────────────────────────────────────
// One of the six shared lines the integration units share: one `import`, one entry
// in `FEATURE_MODELS`, and one `declare module` block in the feature's own model
// file to give `AppFeatureModels` its key. Nothing else here changes.
//
// This file is under `models/`, so tests/architecture.test.ts forbids it importing
// components, hooks or React. Type-only imports are all it has, and a factory must
// return a `Store` — optionally one with a `start()` — never a component.
import type { DesktopAPI } from '../../../shared/types';
import type { Store } from '../../shared/models/store';
import { ShellStateModel } from '../../settings/models/shell-state';

/** Each feature adds its key with a `declare module '.../models/registry'` block
 * in its own file, so landing a feature never edits this one. */
export interface AppFeatureModels {}

/** A registered model is a `Store`, and may own a lifecycle on top of it.
 *
 * `start()` is called once from `AppModel.start()` — after the subscription, with
 * the built-in models already built — and MUST return the function that undoes it.
 * That is where an `api.onX(...)` subscription, a timer or a request loop belongs;
 * the cleanup joins the shell's own, so it is torn down with everything else. It
 * is the same contract the built-in `TownModel.start()` follows, and it is the
 * only place a feature model gets one: a subscription opened in the constructor
 * has nothing to close it. */
export type FeatureModel = Store & { start?(): () => void };

export interface FeatureModelFactory {
  key: keyof AppFeatureModels;
  /** `app` is the `AppModel` under construction. It arrives as `unknown` because
   * `AppModel` imports this file: take the members you need through a narrow
   * structural type at the call site, and never read state from it during
   * construction — the built-in models are not all built yet. Anything that has to
   * happen against a live shell belongs in the model's `start()`, not here. */
  create(api: DesktopAPI, app: unknown): FeatureModel;
}

export const FEATURE_MODELS: FeatureModelFactory[] = [
  { key: 'shellState', create: (api, app) => new ShellStateModel(api, app) },
];
// ──────────────────────────────────────────────────────────────────────────────
