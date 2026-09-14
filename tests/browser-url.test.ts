import { describe, it, expect } from 'vitest';
import { browserURL, browserAddress } from '../desktop/main/browser/url';
describe('embedded browser addresses', () => {
  it('accepts web addresses and rejects privileged schemes', () => {
    expect(browserURL('beings.town')).toBe('https://beings.town/');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'beings://desktop/', 'data:text/html,x', 'https://user:pass@example.com/']) expect(() => browserURL(url)).toThrow();
  });
  it('keeps credentials out of shell state without losing ordinary query parameters', () => {
    expect(browserAddress('https://example.com/?token=fixture&tab=chat#private')).toEqual({ address: 'https://example.com/?tab=chat', secrets: ['fixture', 'private'] });
  });
});
