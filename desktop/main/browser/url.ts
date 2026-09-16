// The SHELL browser's address parsing: what a person typed into `ClientBrowser`'s
// address bar, and how an address is shown back to them with credentials removed.
// portal-desktop's own module, unchanged by the Being Desktop migration.
//
// THE OTHER PARSER. `desktop/main/tools/browser/browser.ts` exports
// `normalizeBrowserUrl` for the Being-facing tool browser, and
// `desktop/main/tools/browser-links.ts` routes external links through it. The
// rules differ on purpose and the two files are kept apart (integration plan
// §3.2「要收敛的副本」): here, bare text becomes a host name, because a person is
// typing; there, anything that is not clearly an address is REFUSED, because a
// Being is asking. If they are ever merged, the stricter one wins. Note also that
// this file only hides credential parameters when showing an address, while the
// tool browser redacts them everywhere a snapshot can reach the renderer.
const credentialKey = /token|secret|password|api[-_]?key|authorization|^code$/i;

export function browserURL(input: string): string {
  if (typeof input !== 'string' || input.length > 16000) throw new Error('请输入有效的网址。');
  const value = input.trim();
  if (!value) throw new Error('请输入网址。');
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`); }
  catch { throw new Error('请输入有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('内置浏览器仅支持 HTTP 或 HTTPS 网页。');
  return url.href;
}

export function browserAddress(input: string): { address: string; secrets: string[] } {
  const url = new URL(input);
  const secrets: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (credentialKey.test(key)) { if (value) secrets.push(value); }
  }
  for (const key of [...url.searchParams.keys()]) if (credentialKey.test(key)) url.searchParams.delete(key);
  // Fragments can contain OAuth credentials. Keep them out of the desktop IPC.
  if (url.hash) { secrets.push(url.hash.slice(1)); url.hash = ''; }
  return { address: url.href, secrets };
}
