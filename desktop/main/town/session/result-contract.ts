// Ported line by line from BeingDesktop 0.8.26 src/being-town-reader.cjs `validTown`
// (exported there as `validateTownToolResult`) on 2026-09-16.
//
// Only the pure result validator is migrated: it depends solely on the library
// contract, never on the Being relay transport itself. The relay reader
// (being-town-reader.cjs) is out of scope for this unit, so TownClient keeps
// `validateResult` as an injection point defaulting to this function — the
// integration stage can swap in BeingDesktop's own implementation unchanged.
//
// Envelope size ceiling and strict DTO validation follow docs/architecture.md §7.

import { Buffer } from 'node:buffer';
import { isPlainRecord, isSequence, TownError, type WireRecord } from './types';
import { beingsDto, detailId, libraryRoute, scrollDto, scrollListDto } from './library-contract';

const MAX_BYTES = 1024 * 1024;
const ERRORS: Record<string, string> = {
  IDENTITY_MISMATCH: 'Town 返回的身份与当前 Being 不一致。',
  INVALID_RESPONSE: 'Being 未返回可核对的 Town 工具结果，已保留上次同步内容。',
  INCOMPLETE_RESULT: 'Town 工具结果不完整，已保留上次同步内容。',
};
const record = isPlainRecord;
const sequence = isSequence;
const failure = (code: string) => new TownError(code, ERRORS[code] ?? '');

export function validateTownToolResult(value: unknown, route: string, beingId: string, query?: Record<string, unknown>): unknown {
  const source = value as WireRecord;
  if (record(value) && Object.hasOwn(source, 'being') && source.being !== beingId) throw failure('IDENTITY_MISMATCH');
  if (record(value) && (source.truncated === true || (Array.isArray(source.messages) && source.messages.some((message: unknown) => record(message) && (message.truncated === true || (typeof message.message === 'string' && sequence(message.full_length) && message.full_length > [...message.message].length)))))) throw failure('INCOMPLETE_RESULT');
  let libraryValid = false;
  if (libraryRoute(route)) {
    if (route === '/api/scrolls') scrollListDto(value, query);
    else if (route === '/api/beings') beingsDto(value);
    else scrollDto(value, detailId(route), query);
    libraryValid = true;
  }
  const valid = libraryValid || (route === '/api/bonfire/hear' ? record(value) && source.ok === true && Array.isArray(source.messages) && sequence(source.global_latest_seq)
    : route === '/api/bonfire/mentions' ? record(value) && source.being === beingId && Array.isArray(source.mentions)
      : route === '/api/fireside/list' ? record(value) && Array.isArray(source.owned) && Array.isArray(source.joined)
        : route === '/api/fireside/members' ? Array.isArray(value)
          : route === '/api/messages' ? record(value) && Array.isArray(source.messages)
            : record(value) && source.being === beingId && Array.isArray(source.messages) && sequence(source.latest_seq));
  if (!valid || (record(value) && (source.ok === false || Object.hasOwn(source, 'error'))) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw failure('INVALID_RESPONSE');
  return value;
}
