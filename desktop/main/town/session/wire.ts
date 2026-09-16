// Ported line by line from BeingDesktop 0.8.26 src/town-wire.cjs on 2026-09-16.
//
// Town now uses a stable town_id namespace. Keep that identity on authors while
// adapting the wire names to the Desktop DTOs; authenticated envelopes are checked
// separately against the credential's pinned Town identity in TownClient.
//
// Measured behaviour: docs/town-sdk-integration.md "Town 身份迁移兼容（2026-09-13）"
// records that /api/bonfire/mentions and the SSE hello dropped the legacy identity
// fields, so a check for `being` / `being_id` alone misreports a healthy connection.

import { isRecord, type WireRecord } from './types';

const record = isRecord;

export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export const memberId = (value: unknown): unknown =>
  record(value) && Object.hasOwn(value, 'town_id')
    ? value.town_id
    : (value as { being_id?: unknown } | null | undefined)?.being_id;

function author(value: unknown): unknown {
  if (!record(value)) return value;
  return {
    ...value,
    ...(Object.hasOwn(value, 'town_id') ? { being: value.town_id, being_id: value.town_id } : {}),
    ...(Object.hasOwn(value, 'reply_to_town_id') ? { reply_to_being: value.reply_to_town_id } : {}),
  };
}

export function normalizeTownResponse(value: unknown, route: string, beingId: string): unknown {
  if (route === '/api/fireside/members' && Array.isArray(value)) {
    return value.map(item => (record(item) ? { ...item, being_id: memberId(item) } : item));
  }
  if (!record(value)) return value;
  const result: WireRecord = { ...value };
  if (Object.hasOwn(value, 'town_id') && ['/api/bonfire/hear', '/api/bonfire/mentions', '/api/fireside/hear'].includes(route)) result.being = beingId;
  if (['/api/bonfire/hear', '/api/fireside/hear'].includes(route) && Array.isArray(value.messages)) result.messages = value.messages.map(author);
  if (route === '/api/messages' && Array.isArray(value.messages)) {
    result.messages = value.messages.map(item => (record(item)
      ? {
        ...item,
        ...(Object.hasOwn(item, 'sender_town_id') ? { sender: item.sender_town_id } : {}),
        ...(Object.hasOwn(item, 'recipient_town_id') ? { recipient: item.recipient_town_id } : {}),
        ...(typeof item.sender_display === 'string' ? { sender_name: item.sender_display } : {}),
      }
      : item));
  }
  return result;
}

// A Town namespace is accepted only against a previously verified binding. Display names
// never participate, and a conflicting legacy field cannot be hidden by normalization.
export function matchesTownIdentity(
  value: unknown,
  { loomBeingId, townId }: { loomBeingId?: string; townId?: string },
  legacy = 'being',
): boolean {
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'town_id')) {
    return validId(value.town_id) && !!townId && value.town_id === townId
      && (!Object.hasOwn(value, legacy) || value[legacy] === loomBeingId || value[legacy] === townId);
  }
  return validId(value[legacy]) && (value[legacy] === loomBeingId || (!!townId && value[legacy] === townId));
}
