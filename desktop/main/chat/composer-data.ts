// What the composer offers behind `/` and `@`; 2026-09-16.
//
// `normalizeComposerData` is ported line for line from BeingDesktop 0.8.26
// src/loom-composer.cjs lines 8-49 (`BUILTIN_KITS`, `clean`, `normalize`), and
// `composerData` from src/main.cjs lines 1334-1349 (`getChatComposerData`) with
// its `memberOptions` guard from line 1266.
//
// The normalization is a projection for an untrusted surface: ids are matched
// against a character class rather than escaped, control characters are removed
// rather than encoded, every string is capped, and both lists are capped at 1000
// entries. A Kit name and a Being's display name both arrive from outside this
// machine and are rendered next to the user's own words, so nothing here may
// depend on the renderer to make them safe.
//
// Two readings are deliberately settled rather than awaited together: a Kit
// directory that cannot be read must not hide the member directory, and neither
// must hide the built-in abilities. Each failure becomes its own sentence and the
// other half still arrives — BeingDesktop's `Promise.allSettled`, unchanged.
import type { ChatComposerData, ChatComposerEntry } from '../../shared/desktop-types';

/** The two abilities the Being has without any Kit installed. They lead the list
 * and are always「installed」: nothing can uninstall them.
 *
 * Frozen, and compared by identity below exactly as the original does — that
 * identity check is what marks an entry built-in, so a Kit called `search` from
 * the directory can never claim the flag. */
const BUILTIN_KITS = Object.freeze([
  Object.freeze({ id: 'being-search', name: 'search', description: '网络搜索 · 搜索互联网并读取网页正文。', builtin: 'search' }),
  Object.freeze({ id: 'being-browse', name: 'browse', description: '网页读取 · 读取公开网页，支持 JavaScript 渲染。', builtin: 'browse' }),
]);

/** One entry as either directory hands it over, before normalization. */
export interface ComposerSource {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  description?: unknown;
  bio?: unknown;
  installed?: unknown;
  builtin?: unknown;
}

export interface ComposerInput {
  kits?: readonly ComposerSource[];
  members?: readonly ComposerSource[];
  kitsError?: string;
  membersError?: string;
}

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const clean = (text: unknown, limit: number): string =>
  typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';

function normalize(items: readonly ComposerSource[] | undefined, kind: 'kit' | 'member'): ChatComposerEntry[] {
  const result: ChatComposerEntry[] = [], ids = new Set<string>(), handles = new Set<string>();
  for (const item of Array.isArray(items) ? items.slice(0, 1000) : []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) continue;
    const id = item.id;
    const name = clean(item.name || item.display_name || id, 100);
    // A member is addressed by its id — a display name is not an address, and
    // resolving one here would be a local replica of Town's name parser. A Kit is
    // addressed by a handle made from its name, with its id appended when two
    // names collide, and dropped when even that collides.
    let handle = kind === 'member' ? id : name.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_.-]/gu, '') || id;
    if (kind === 'kit' && handles.has(handle.toLocaleLowerCase())) handle = `${handle}-${id}`;
    if (kind === 'kit' && handles.has(handle.toLocaleLowerCase())) continue;
    ids.add(id);
    handles.add(handle.toLocaleLowerCase());
    const isBuiltin = kind === 'kit' && (BUILTIN_KITS as readonly ComposerSource[]).includes(item);
    result.push({
      id, name, handle, description: clean(item.description || item.bio, 220), kind,
      installed: item.installed === true || isBuiltin,
      // DEVIATION, and it is a missing input rather than a decision: BeingDesktop
      // embeds bundled artwork here, looked up by Grove market id through
      // renderer/kit-catalog.js. This shell has no such catalogue and its Kit
      // installer keeps no market id (main/kits/install.ts writes
      // `.beings-install.json` with a sha256 and a timestamp, not an id), so there
      // is nothing to look one up by. The menu falls back to the first letter of
      // the name, which is what BeingDesktop draws when a lookup misses.
      icon: '',
      builtin: isBuiltin && typeof item.builtin === 'string' ? item.builtin : '',
    });
  }
  return result;
}

export function normalizeComposerData(value: ComposerInput = {}): Omit<ChatComposerData, 'connectionRevision' | 'revision' | 'expiresAt'> {
  return {
    kits: normalize([
      ...BUILTIN_KITS,
      ...(Array.isArray(value.kits) ? value.kits.filter(item => item?.installed === true).slice(0, 1000) : []),
    ], 'kit'),
    members: normalize(value.members, 'member'),
    kitsError: clean(value.kitsError, 200),
    membersError: clean(value.membersError, 200),
  };
}

/** The raw shapes the two directories produce. `localKits` answers a `KitLibrary`
 * and `TownSession.getMembers` a `{members}`; both are read structurally so this
 * module depends on neither unit. */
export interface ComposerKitLibrary { kits: readonly { name: string; description: string; command: readonly string[]; problem?: string }[] }
export interface ComposerMemberDirectory { members: readonly { id: string; name: string; description: string }[] }

export interface ComposerDataOptions {
  /** `localKits(store.settings)`. */
  readKits: () => Promise<ComposerKitLibrary>;
  /** `TownSession.getMembers({force})`, or null when Town is not installed. */
  readMembers: ((options: { force: boolean }) => Promise<ComposerMemberDirectory>) | null;
  /** `{revision, expiresAt}` from the member cache, so the renderer knows when its
   * copy went stale without asking again. Zeroes when Town is not installed. */
  memberCacheState: () => { revision: number; expiresAt: number };
  /** The chat subsystem's connection revision, and whether a Being is bound. The
   * revision is echoed back by a public mention so a message composed against the
   * previous Being is refused rather than published under the new identity. */
  connection: () => { connected: boolean; revision: number };
}

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

/** `{force?: boolean}` and nothing else. BeingDesktop's `memberOptions`, line for
 * line: an unknown key, a non-plain object or a non-boolean `force` is refused
 * rather than dropped, so a stale renderer cannot silently lose the flag. */
export function memberOptions(value: unknown): { force: boolean } {
  if (value !== undefined && (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => key !== 'force')
    || ((value as { force?: unknown }).force !== undefined && typeof (value as { force?: unknown }).force !== 'boolean')))
    throw invalid('成员刷新参数无效。');
  return { force: (value as { force?: unknown } | undefined)?.force === true };
}

export function composerData(options: ComposerDataOptions) {
  return async (input?: unknown): Promise<ChatComposerData> => {
    const request = memberOptions(input);
    const before = options.connection();
    if (!before.connected) throw new Error('请先连接 Being。');
    const readMembers = options.readMembers;
    // Wrapped so a reader that throws synchronously is settled like one that
    // rejects: either way the other directory must still arrive.
    const [kits, members] = await Promise.allSettled([
      (async () => options.readKits())(),
      (async () => readMembers ? readMembers(request) : { members: [] as ComposerMemberDirectory['members'] })(),
    ]);
    const after = options.connection();
    if (!after.connected || after.revision !== before.revision)
      throw Object.assign(new Error('Being 连接已变化。'), { code: 'SESSION_CHANGED' });
    return {
      ...normalizeComposerData({
        // Every local Kit is installed by definition — it is on disk. One whose
        // manifest could not be read carries `problem` and an empty command, which
        // is `listInstalledComposerKits`'s own rejection (a Kit with no command is
        // not a Kit Portal can run), so it is left out rather than offered.
        kits: kits.status === 'fulfilled'
          ? kits.value.kits.filter(kit => !kit.problem && kit.command.length).map(kit => ({ id: kit.name, name: kit.name, description: kit.description, installed: true }))
          : [],
        members: members.status === 'fulfilled' ? members.value.members : [],
        kitsError: kits.status === 'rejected' ? '已安装 Kit 暂时无法读取。' : '',
        membersError: members.status === 'rejected' ? 'Being 成员暂时无法加载。' : '',
      }),
      connectionRevision: before.revision,
      ...options.memberCacheState(),
    };
  };
}
