import type { ClientBrowser } from '../browser/browser';
import type { SecretStorage, SettingsStore } from '../app/settings';
import type { TownClient, TownCredentials } from './client';
import { TOWN_ORIGIN, townRoute } from './client';
import type { TownLive } from './live';
import type { TownPost, TownQuery } from '../../shared/types';

type RegisterHandler = (channel: string, callback: (...args: any[]) => unknown) => void;

export interface TownIpcOptions {
  handle: RegisterHandler;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  town: TownClient;
  townLive: TownLive;
  townCredentials: TownCredentials;
  store: SettingsStore;
  secretStorage: SecretStorage;
  getWarning: () => string | undefined;
  clearWarning: () => void;
  open: (url: string) => void;
}

export function registerTownIpc(options: TownIpcOptions) {
  const { handle, exclusive, town, townLive, townCredentials, store, secretStorage } = options;
  handle('beings:town', async (query: TownQuery) => {
    const generation = townLive.state.generation;
    const result = await town.query(query);
    if (generation !== townLive.state.generation) return { ok: false, code: 'auth', message: 'Town 身份已变更，请刷新。' };
    if (result.ok) townLive.remember(query, result.data);
    else if (result.code === 'auth' && townCredentials.token && query.kind !== 'my-scrolls' && townRoute(query).private) townLive.rejectAuth();
    return result;
  });
  handle('beings:town-live', () => townLive.state);
  handle('beings:town-reconnect', () => townLive.restart());
  handle('beings:town-send', (input: TownPost) => {
    const generation = townLive.state.generation;
    return exclusive(async () => {
      if (generation !== townLive.state.generation || townLive.state.phase !== 'connected' || !townLive.state.beingId) return { ok: false, code: 'auth', message: 'Town 身份尚未确认或已变更，请重新打开发送窗口。' };
      const result = await town.send(input);
      if (!result.ok && result.code === 'auth') townLive.rejectAuth();
      return result;
    });
  });
  handle('beings:town-auth', () => ({ configured: Boolean(townCredentials.token), beingId: townLive.state.beingId, pairedBeingId: townCredentials.beingId || undefined, display: townCredentials.display || undefined, suggestedBeingId: store.settings.being, warning: options.getWarning() }));
  handle('beings:town-pair', (input: { beingId: string; code: string }) => exclusive(async () => {
    if (!secretStorage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法安全保存配对凭据。');
    const paired = await town.pair(input);
    await townCredentials.save(paired.token, paired.beingId, paired.display);
    options.clearWarning(); townLive.restart();
  }));
  handle('beings:town-token', (token: string) => exclusive(async () => { await townCredentials.save(token); options.clearWarning(); townLive.restart(); }));
  handle('beings:town-open', async (route: string) => {
    if (typeof route !== 'string' || !/^\/(?:api\/(?:[a-z]+\/help|grove\/[a-zA-Z0-9_-]+\/download)|(?:embers|scrolls|seeds)\/[a-zA-Z0-9_-]{1,160})?$/.test(route)) throw new Error('不支持的 Town 链接。');
    options.open(TOWN_ORIGIN + route);
  });
}
