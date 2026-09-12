# React renderer

The desktop shell uses React 19, TypeScript and the existing Vite / Electron Forge pipeline.
Run `npm start` for the desktop development build, `npm run typecheck` for TS/TSX checks,
and `npm test` for unit regressions. `npx vite build --config vite.renderer.config.ts`
checks the renderer production bundle without rebuilding Rust.

- `main.tsx`: React root, StrictMode, error boundary and the original stylesheet order.
- `app.tsx`: application layout and keyboard shortcuts. The chat iframe stays mounted
  during navigation and Portal status changes so drafts, history and streaming survive.
- `components/`: desktop panels, controlled forms, native dialogs, Town lists, reading
  details and installation. Preserve existing classes, IDs, labels and DOM hierarchy
  when changing behavior; the CSS remains the visual contract.
- `models/`: observable domain state, IPC calls, request invalidation and draft handling.
  `Store` publishes a cached version through `useSyncExternalStore`. Publish after
  changing model fields; never manipulate component DOM from a model. Create models
  once at the root and release every subscription in the lifecycle cleanup.
- `hooks/`: the validated chat message bridge and measured native browser resizing.
  Refs are for focus, animation, scrolling, dialog methods and native view geometry.
- `town-feed.ts`: pure message identity, relationship, date and search filtering.
- `components/markdown.tsx`: the only shell HTML rendering boundary. All remote
  Markdown is sanitized before rendering; images, handlers and non-HTTP links are removed.
- `scene-store.ts`: in-memory scene observations and explicitly pinned references.

`loom.html` at the repository root is the independent upstream chat client.
`chat-index.ts`, `chat-activity.ts`, `chat-scene.ts`, `chat-links.ts` and `chat-places.ts`
are compiled by `scripts/prepare-desktop.mjs` into that isolated document. They operate
on Loom-owned DOM, never on React-owned nodes. The iframe has no preload, Node or
local IPC; keep its origin/source/revision checks when extending the shell bridge.
The Electron main process, preload and Rust Portal keep their existing contracts.

Renderer request tests are in `tests/renderer-state.test.ts`. Packaged UI coverage is
in the existing Electron suites described in [TESTING.md](../TESTING.md).
