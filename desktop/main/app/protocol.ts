import { protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// `beings://chat` — the sandboxed Loom document and the request proxy behind it
// — was retired on 2026-09-16 (see MIGRATION.md). The conversation core now runs
// in the main process and reaches the Being over IPC, so the only host this
// protocol still answers for is the shell itself.
export function registerLocalProtocol(assets: string) {
  protocol.handle('beings', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'desktop' || request.method !== 'GET') return new Response('Not found', { status: 404 });

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(assets, relative);
    if (!file.startsWith(assets + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      return new Response(await readFile(file), {
        headers: {
          'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export function configureLocalSession() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}
