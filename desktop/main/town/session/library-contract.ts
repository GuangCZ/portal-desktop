// Ported line by line from BeingDesktop 0.8.26 src/town-library-contract.cjs on 2026-09-16.
//
// Read contracts checked against /api/scrolls/help, /api/beings/help and a public
// /api/scrolls/{id} response on 2026-09-07. Never infer human identities from IDs.
//
// Security envelope (docs/architecture.md §7): strict DTO validation, no upstream
// prose reaches the renderer, and pagination is cross-checked against the request.

import { isPlainRecord, isSequence, TownError, type TownBeingEntry, type TownScrollDetail, type TownScrollList, type TownScrollSummary, type WireRecord } from './types';
import { memberId } from './wire';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESERVED_SCROLL_IDS = new Set(['help', 'search', 'graph', 'match']);
const VISIBILITY = new Set(['private', 'shared', 'public']);
const record = isPlainRecord;
const sequence = isSequence;
const invalid = (message: string) => new TownError('INVALID_RESPONSE', message);
const badRequest = () => new TownError('INVALID_REQUEST', 'Town 阅读参数无效。');
const display = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g, '').slice(0, limit) : '';

export function scrollId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && !RESERVED_SCROLL_IDS.has(value);
}

export function detailId(route: unknown): string | null {
  if (typeof route !== 'string' || !route.startsWith('/api/scrolls/')) return null;
  const id = route.slice('/api/scrolls/'.length);
  return scrollId(id) ? id : null;
}

export function libraryRoute(route: unknown): boolean {
  return route === '/api/beings' || route === '/api/scrolls' || detailId(route) !== null;
}

export function libraryQuery(route: string, value: unknown = {}): Record<string, string> {
  if (!libraryRoute(route) || !record(value)) throw badRequest();
  const allowed = route === '/api/beings' ? [] : route === '/api/scrolls' ? ['offset', 'limit', 'visibility'] : ['offset', 'limit'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key as string], 'value'))) throw badRequest();
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'visibility') {
      if (!VISIBILITY.has(item as string)) throw badRequest();
      result[key] = item as string;
    } else {
      const number = typeof item === 'string' && /^(0|[1-9]\d*)$/.test(item) ? Number(item) : item;
      if (!sequence(number) || (key === 'limit' && (number < 1 || number > (route === '/api/scrolls' ? 200 : 10000))) || (key === 'offset' && number > 4294967295)) throw badRequest();
      result[key] = String(number);
    }
  }
  return result;
}

function summaryDto(value: unknown): TownScrollSummary {
  const id = memberId(value);
  if (!record(value) || !scrollId(value.id) || typeof value.title !== 'string' || typeof id !== 'string' || !ID.test(id) || !VISIBILITY.has(value.visibility as string) || !sequence(value.revision) || value.revision < 1) throw invalid('卷轴文档格式发生变化，请刷新后重试。');
  return {
    id: value.id, title: display(value.title, 400), beingId: id,
    beingName: display(value.display_name, 100) || id,
    visibility: value.visibility as string, kind: display(value.kind, 30), lifecycle: display(value.lifecycle, 30),
    tags: Array.isArray(value.tags) ? [...new Set(value.tags.filter((tag: unknown) => typeof tag === 'string').slice(0, 50).map((tag: unknown) => display(tag, 100)))] : [],
    createdAt: display(value.created_at, 64), updatedAt: display(value.updated_at, 64), revision: value.revision,
  };
}

export function scrollListDto(value: unknown, query: Record<string, unknown> = {}): TownScrollList {
  if (!record(value) || value.ok === false || Object.hasOwn(value, 'error') || !Array.isArray(value.scrolls) || !sequence(value.total) || !sequence(value.offset) || !sequence(value.limit) || value.limit < 1 || value.limit > 200 || value.scrolls.length > value.limit || value.scrolls.length > value.total || value.offset !== Number(query.offset ?? 0) || value.limit !== Number(query.limit ?? 50)) throw invalid('卷轴列表格式发生变化，请刷新后重试。');
  const scrolls = value.scrolls.map(summaryDto);
  if (new Set(scrolls.map(scroll => scroll.id)).size !== scrolls.length || scrolls.length !== Math.min(value.limit, Math.max(0, value.total - value.offset))) throw invalid('卷轴列表不完整，请刷新后重试。');
  return { scrolls, total: value.total, offset: value.offset, limit: value.limit, hasMore: value.offset + value.scrolls.length < value.total };
}

export function scrollDto(value: unknown, id: string | null, query: Record<string, unknown> = {}): { scroll: TownScrollDetail } {
  const scroll = summaryDto(value);
  const source = value as WireRecord;
  if (scroll.id !== id || source.ok === false || Object.hasOwn(source, 'error') || typeof source.content !== 'string' || !sequence(source.total_length) || !sequence(source.offset) || !sequence(source.limit) || source.limit < 1 || source.limit > 10000 || typeof source.has_more !== 'boolean' || source.offset !== Number(query.offset ?? 0) || source.limit !== Number(query.limit ?? 10000)) throw invalid('卷轴正文格式发生变化，请刷新后重试。');
  const length = [...source.content].length;
  if (length > source.limit || source.offset + length > source.total_length || source.has_more !== (source.offset + length < source.total_length) || (source.has_more && length !== source.limit)) throw invalid('卷轴正文不完整，请刷新后重试。');
  return { scroll: { ...scroll, content: display(source.content, 20000), totalLength: source.total_length, offset: source.offset, limit: source.limit, nextOffset: source.offset + length, hasMore: source.has_more } };
}

export function beingsDto(value: unknown): TownBeingEntry[] {
  const list = Array.isArray(value) ? value : record(value) && Array.isArray(value.beings) ? value.beings : null;
  const source = value as WireRecord;
  if (!list || list.length > 2000 || (record(value) && (source.ok === false || Object.hasOwn(source, 'error') || (source.has_more !== undefined && source.has_more !== false) || (source.hasMore !== undefined && source.hasMore !== false) || (source.total !== undefined && (!sequence(source.total) || source.total !== list.length)) || (source.offset !== undefined && source.offset !== 0)))) throw invalid('Town 居民目录不完整，请刷新后重试。');
  const seen = new Set<string>();
  return list.map((entry: unknown) => {
    const id = memberId(entry);
    if (!record(entry) || typeof id !== 'string' || !ID.test(id) || typeof entry.display_name !== 'string' || seen.has(id)) throw invalid('Town 居民目录格式发生变化，请刷新后重试。');
    seen.add(id);
    return { id, name: display(entry.display_name, 100) || id, description: display(entry.about, 500), status: display(entry.status, 50), human: null };
  });
}
