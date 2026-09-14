// Town IDs are opaque and case-sensitive; legacy Being names are lowercase.
export const normalizeTownIdentity = (value: string) => {
  const identity = value.trim();
  return identity.startsWith('t_') ? identity : identity.toLowerCase();
};
export const validTownIdentity = (value: unknown): value is string =>
  typeof value === 'string' && (value.startsWith('t_')
    ? /^t_[a-zA-Z0-9_-]{1,62}$/.test(value)
    : /^[a-z0-9_-]{1,64}$/.test(value));
