// Town IDs are opaque and case-sensitive; legacy Being names are lowercase.
export const normalizeTownIdentity = (value: string) => {
  const identity = value.trim();
  return identity.startsWith('t_') ? identity : identity.toLowerCase();
};
export const validTownIdentity = (value: unknown): value is string =>
  typeof value === 'string' && (value.startsWith('t_')
    ? /^t_[a-zA-Z0-9_-]{1,62}$/.test(value)
    : /^[a-z0-9_-]{1,64}$/.test(value));
// Display metadata is optional and never participates in authentication.
export const normalizeTownDisplay = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400) : '';
