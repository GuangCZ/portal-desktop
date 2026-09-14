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
