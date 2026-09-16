// The `being://app` resource resolver, ported line by line from BeingDesktop
// 0.8.26 src/security.cjs on 2026-09-16.
//
// Everything else src/security.cjs owns — `parseConnection`, `sessionPartition`,
// `endpoint`, `publicModelUrl` and `allowedNavigation` — moved to
// `desktop/main/common/loom-connection.ts` in the I0 seam stage, because
// `town/channel/` carried a second, byte-equivalent copy of the same functions.
// Only `protocolFile` stayed: it belongs to the Loom document's own custom
// protocol, which this shell serves through `app/protocol.ts`'s `beings://desktop`
// handler instead. It has no caller in the shell yet; it was kept so the tool
// browser unit (I2/I3) would have the checked path resolution ready rather than
// writing a third one.
//
// MEASURED IN I2 (2026-09-16): the tool bridge does NOT need it. The tool browser
// loads remote http(s) pages through `DesktopBrowser`, and the only local
// document the shell serves is `beings://desktop`, which `app/protocol.ts`
// resolves with its own checked join. This file therefore stays as it is — not
// deleted, because `tests/tools-security.test.ts` is a real test of a real
// traversal guard and I3's terminal unit cannot see this branch to say whether it
// wants it. Whoever finds it still unused after I3 lands may delete both.
import path from 'node:path';

export function protocolFile(root: string, rawUrl: string): string {
  const u = new URL(rawUrl);
  if (u.protocol !== 'being:' || u.hostname !== 'app') throw new Error('Unknown app resource');
  const relative = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid resource path');
  return resolved;
}
