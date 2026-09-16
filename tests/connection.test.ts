import { describe, expect, it } from 'vitest';
import { connectionCredential, parseConnection, redact } from '../desktop/main/chat/connection';

const connection = parseConnection('https://echo.example/alice/?token=fixture-token&relay_secret=relay-key');
describe('connection and credential boundary', () => {
  it('normalizes endpoint without exposing credentials', () => {
    expect(connection.endpoint).toBe('https://echo.example/alice');
    expect(connection.link).toBe('https://echo.example/alice/?token=fixture-token');
    expect(connection.relaySecret).toBe('relay-key');
  });
  it.each(['file:///etc/passwd', 'https://user:pass@echo.example/alice/?token=t', 'https://echo.example/?token=t', 'https://echo.example/alice/extra/?token=t', 'http://echo.example/alice/?token=t', 'https://echo.example/alice/', 'https://echo.example/alice/?token=a%26b'])(
    'rejects unsupported links: %s', value => expect(() => parseConnection(value)).toThrow());
  it('allows explicit local mock server', () => expect(parseConnection('http://127.0.0.1:9876/alice/?token=test').endpoint).toBe('http://127.0.0.1:9876/alice'));
  // BeingDesktop 0.8.x addresses may carry `api=` when Loom and the Being API
  // sit on different paths of one origin (BeingDesktop src/security.cjs).
  it('moves the API base for a same-origin api parameter without moving the Loom link', () => {
    const connection = parseConnection('https://echo.example/alice/?token=fixture-token&api=https://echo.example/alice/api/');
    expect(connection.endpoint).toBe('https://echo.example/alice/api');
    expect(connection.link).toBe('https://echo.example/alice/?token=fixture-token');
    expect(connection.relaySecret).toBe('fixture-token');
  });
  it.each(['https://echo.example/alice/?token=t&api=https://other.example/alice',
    'https://echo.example/alice/?token=t&api=https://echo.example/alice?x=1',
    'https://echo.example/alice/?token=t&api=https://user:pass@echo.example/alice',
    'https://echo.example/alice/?token=t&api=/alice/api'])(
    'refuses to send the token to another site: %s', value => expect(() => parseConnection(value)).toThrow());
  it('keeps every parameter of a stored address, dropping only the fragment', () => {
    const address = 'https://echo.example/alice/?token=fixture-token&secret=relay-fixture&api=https://echo.example/alice/api';
    expect(connectionCredential(address + '#loom')).toBe(address);
    expect(() => connectionCredential('https://echo.example/alice/')).toThrow();
  });
  it('redacts credentials and terminal control colors', () => {
    expect(redact('\x1b[31mhttps://host/a?token=abc secret=xyz fixture-token\x1b[0m', ['fixture-token'])).toBe('https://host/a?token=[redacted] secret=[redacted] [redacted]');
  });
});
