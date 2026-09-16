// Ported line by line from BeingDesktop 0.8.26 src/town-result-source.cjs on 2026-09-16.
// Required by messagesDto; the Being relay reader that sets the marker is migrated
// separately (docs/town-sdk-integration.md "替换范围": relay reads are retired but
// the compatibility module is kept).

// This marker is assigned only by the local reader, never by remote JSON.
const relayed = new WeakSet<object>();

export function markBeingRelay<T extends object>(value: T): T { relayed.add(value); return value; }

export function relaySource(value: unknown): { source?: string } {
  return typeof value === 'object' && value !== null && relayed.has(value) ? { source: 'being_relay' } : {};
}
