// The Being's `/api/llm/config` route, as BeingDesktop 0.8.26 reads and writes
// it. Ported line by line from src/model-config.cjs (198 lines); 2026-09-16.
//
// Loom's public `loadLlmConfig`/`llmApply` contract: GET returns presets; PATCH
// accepts model/provider/base_url/api_key and reports needs_key/rolled_back.
//
// THE TABLE BELOW IS A MIRROR, NOT A LIST THIS CLIENT OWNS. `PROVIDERS` mirrors
// Loom's `providerNames`/`inferBaseUrl` tables (loom.html 1.8.0, deployed
// 2026-09-12 revision; Heart keeps the same list in `LlmConfig::CANONICAL_URLS`)
// plus OpenRouter — docs/architecture.md §11 names it as the hard coupling point
// it is. It was ported byte for byte, including the self-hosted address and the
// order of the keys, and must be updated by re-reading Loom rather than by
// reasoning about what the values ought to be.
//
// The one thing that crosses this boundary and exists nowhere else in the client
// is an API key in the clear: the renderer hands one to `beings:model-config-save`
// and it is forwarded, in memory, to the Being. It is never written to disk,
// never logged, never put in an error message and never included in anything
// pushed back — `modelConfigDto` reads `has_api_key` and nothing else, and
// `failure()` only ever carries one of the authored MESSAGES below.
import { endpoint, publicModelUrl, type LoomConnection } from '../common/loom-connection';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  /** Loom 1.8.0 lists self-hosted presets first and applies them in one step
   * without an API key. */
  keyless?: boolean;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
  'openai-responses': { name: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1' },
  openai: { name: 'OpenAI Chat Completions', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  google: { name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com' },
  glm: { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  // Loom 1.8.0 lists self-hosted presets first and applies them in one step without an API key.
  'self-hosted': { name: '自部署', baseUrl: 'http://115.190.110.33:7860/v1', keyless: true },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
};

export const MESSAGES: Record<string, string> = {
  NOT_CONNECTED: '请先配置 Being 连接。',
  SESSION_CHANGED: 'Being 连接已变化，请重新读取模型配置。',
  BUSY: '正在保存模型配置，请稍后重新读取。',
  AUTH_REQUIRED: '模型配置授权失败，请检查 Loom 连接凭据。',
  NETWORK_ERROR: '模型配置读取失败，请检查网络与连接凭据。',
  INVALID_RESPONSE: '模型配置返回格式无效，请重新读取。',
  RESULT_UNKNOWN: '保存结果尚未确认，请重新读取当前配置后检查。',
  NEEDS_KEY: '此服务需要 API Key，请填写后重新保存。',
  ROLLED_BACK: 'Being 已回退本次模型变更，请重新读取当前配置。',
};

export type ModelConfigError = Error & { code: string };

/** `INVALID_REQUEST` deliberately has no entry in MESSAGES: `request()`'s
 * `Object.hasOwn(MESSAGES, code)` test must not recognise it, because a
 * validation failure never happens inside a request. Its text is always passed
 * in by the caller. */
export function failure(code: string, message: string = MESSAGES[code]!): ModelConfigError {
  return Object.assign(new Error(message), { code });
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Control characters and the BiDi overrides, dropped, then truncated. The
 * overrides matter because a model name is rendered next to a provider name:
 * `‮` in one of them would reverse the other. */
function plainText(value: unknown, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : '';
}

export interface ModelProvider { id: string; name: string; baseUrl: string; keyless: boolean }
export interface ModelPreset { id: string; presetId: string; name: string; provider: string; baseUrl: string; hasApiKey: boolean | null }
export interface ModelConfigValues {
  model: string;
  provider: string;
  baseUrl: string;
  /** Whether the Being holds a key for this configuration. The key itself never
   * leaves the Being, and this client never sends one back that it did not just
   * receive from the user. */
  hasApiKey: boolean | null;
  thinking: string;
  temperature: number | null;
  /** Side by Side, the Being's own waking loop. `null` when the Being did not
   * answer with the field at all — unknown is not the same as off. */
  sbsEnabled: boolean | null;
}
export interface ModelConfigDto {
  connectionId: number;
  checkedAt: string;
  config: ModelConfigValues;
  models: ModelPreset[];
  providers: ModelProvider[];
  modelsError: string;
}

function providerDetails(id: string): ModelProvider {
  return { id, name: PROVIDERS[id]?.name || id, baseUrl: PROVIDERS[id]?.baseUrl || '', keyless: PROVIDERS[id]?.keyless === true };
}

export function modelConfigDto(value: unknown, connectionId: number, checkedAt = new Date().toISOString()): ModelConfigDto {
  if (!record(value) || typeof value.model !== 'string' || typeof value.provider !== 'string') throw failure('INVALID_RESPONSE');
  const config: ModelConfigValues = {
    model: plainText(value.model, 512), provider: plainText(value.provider, 100), baseUrl: publicModelUrl(String(value.base_url ?? '')),
    hasApiKey: typeof value.has_api_key === 'boolean' ? value.has_api_key : null,
    thinking: plainText(value.thinking, 100), temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature) ? value.temperature : null,
    sbsEnabled: typeof value.sbs_enabled === 'boolean' ? value.sbs_enabled : null,
  };
  const models: ModelPreset[] = [], seen = new Set<string>();
  if (Array.isArray(value.presets)) {
    for (const preset of value.presets.slice(0, 2000)) {
      if (!record(preset) || typeof preset.model !== 'string' || typeof preset.provider !== 'string') continue;
      const id = plainText(preset.model, 512), provider = plainText(preset.provider, 100);
      const unique = JSON.stringify([provider, id]);
      if (!id || !provider || seen.has(unique)) continue;
      seen.add(unique);
      models.push({
        id, presetId: plainText(preset.id, 512), name: plainText(preset.label, 512) || id, provider,
        baseUrl: publicModelUrl(String(preset.base_url ?? '')),
        hasApiKey: typeof preset.has_key === 'boolean' ? preset.has_key : null,
      });
    }
  }
  const providerIds = [...new Set([config.provider, ...models.map(model => model.provider), ...Object.keys(PROVIDERS)].filter(Boolean))];
  return {
    connectionId, checkedAt, config, models, providers: providerIds.map(providerDetails),
    modelsError: Array.isArray(value.presets) ? '' : '此 Being 未提供支持模型列表，可填写自定义模型。',
  };
}

export interface ModelPatchInput {
  connectionId: number;
  model: string;
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}
/** The wire shape, snake_case, exactly the four fields Loom accepts. */
export interface ModelPatch { model: string; provider: string; base_url?: string; api_key?: string }

export function validateModelPatch(value: unknown): ModelPatch {
  const allowed = ['connectionId', 'model', 'provider', 'baseUrl', 'apiKey'];
  // Prototype gate, unknown-field gate, and accessor gate: an input carrying a
  // getter is refused WITHOUT being read, so a renderer compromised into sending
  // one cannot observe which fields this validator touches.
  const input = value as Record<string, unknown>;
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => !allowed.includes(key as string))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))
      || !Number.isSafeInteger(input.connectionId) || (input.connectionId as number) < 0) throw failure('INVALID_REQUEST', '模型配置格式无效，请重新读取。');
  function field(key: string, name: string, limit: number, optional = false): string {
    const item = input[key];
    if (optional && item === undefined) return '';
    // eslint-disable-next-line no-control-regex
    if (typeof item !== 'string' || item.length > limit || /[\x00-\x1f\x7f]/.test(item)) throw failure('INVALID_REQUEST', `${name}格式无效。`);
    const result = item.trim();
    if (!optional && !result) throw failure('INVALID_REQUEST', `请填写${name}。`);
    return result;
  }
  const model = field('model', '模型名称', 512), provider = field('provider', '服务商', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) throw failure('INVALID_REQUEST', '服务商格式无效。');
  const baseUrl = field('baseUrl', 'API 地址', 2048, true), apiKey = field('apiKey', 'API Key', 16384, true);
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw failure('INVALID_REQUEST', '请填写有效的 HTTP 或 HTTPS API 地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw failure('INVALID_REQUEST', 'API 地址须使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。');
    }
  }
  return { model, provider, ...(baseUrl ? { base_url: baseUrl } : {}), ...(apiKey ? { api_key: apiKey } : {}) };
}

async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw failure('INVALID_RESPONSE');
  let length = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw failure('INVALID_RESPONSE');
      chunks.push(Buffer.from(part.value));
    }
  } finally { try { await reader.cancel(); } catch { /* Completed response bodies need no cancellation. */ } }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_RESPONSE'); }
}

/** What the client knows about the Being this request belongs to. `connection`
 * is compared by identity, not by value: a re-parsed equal address is a new
 * object and therefore a new epoch, which is what makes a stalled save unable to
 * claim the result of the one after it. */
export interface ModelConfigContext {
  connection: LoomConnection | null;
  connectionId: number;
  exiting: boolean;
}

type ExpectedContext = ModelConfigContext & { connection: LoomConnection };

/** The SBS patch, measured rather than inferred.
 *
 * BeingDesktop has no SBS write path at all — its panel is read-only and points
 * the user at Loom — so this shape comes from the only two places that have it:
 * the real Loom 1.8.0 page's `toggleSbs` (`applyConfigChange({ sbs_enabled: next
 * ? 'on' : 'off' })`, which is a PATCH of /api/llm/config with the same headers
 * as any other config change), and the fake Being in tests/sbs-refresh.mjs, which
 * was written against it (`enabled = patch.sbs_enabled === 'on'`). The value is
 * the STRING 'on'/'off' on the way in and a boolean on the way back out, and
 * Loom's own comment says to trust the server's echo rather than flipping
 * optimistically. See docs/migration/i6b-model-settings.md §1.7. */
export interface SideBySidePatch { sbs_enabled: 'on' | 'off' }

export interface ModelConfigOptions {
  getContext: () => ModelConfigContext;
  fetchImpl?: typeof fetch;
}

export class ModelConfig {
  private readonly getContext: () => ModelConfigContext;
  private readonly fetchImpl: typeof fetch;
  private operation: ExpectedContext | null = null;
  private snapshot: { connection: LoomConnection; connectionId: number; baseUrl: string } | null = null;
  private revision = 0;

  constructor({ getContext, fetchImpl = globalThis.fetch }: ModelConfigOptions) {
    this.getContext = getContext;
    this.fetchImpl = fetchImpl;
  }

  /** A write is in flight for the Being that is connected now. A write left over
   * from a previous binding is not busy: it can no longer affect this one. */
  get busy(): boolean {
    const current = this.getContext();
    return Boolean(this.operation && current.connection === this.operation.connection && current.connectionId === this.operation.connectionId);
  }

  private context(expected?: ExpectedContext): ExpectedContext {
    const current = this.getContext();
    if (expected && (current.connection !== expected.connection || current.connectionId !== expected.connectionId)) throw failure('SESSION_CHANGED');
    if (!current.connection || current.exiting) throw failure('NOT_CONNECTED');
    return current as ExpectedContext;
  }

  private async request(expected: ExpectedContext, patch?: ModelPatch | SideBySidePatch): Promise<Record<string, unknown>> {
    this.context(expected);
    const mutation = patch !== undefined;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (expected.connection.secret) headers['X-Relay-Secret'] = expected.connection.secret;
      if (mutation) headers['Content-Type'] = 'application/json';
      const response = await this.fetchImpl(endpoint(expected.connection, '/api/llm/config'), {
        method: mutation ? 'PATCH' : 'GET', headers, ...(mutation ? { body: JSON.stringify(patch) } : {}),
        redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      this.context(expected);
      if (response.status === 401 || response.status === 403) throw failure('AUTH_REQUIRED');
      const value = await responseJson(response) as Record<string, unknown> | null;
      this.context(expected);
      if (mutation && value?.needs_key === true) throw failure('NEEDS_KEY');
      if (mutation && value?.rolled_back === true) throw failure('ROLLED_BACK');
      if (!response.ok || !record(value) || value.ok === false) throw failure(mutation ? 'RESULT_UNKNOWN' : 'INVALID_RESPONSE');
      if (mutation && value.ok !== true) throw failure('RESULT_UNKNOWN');
      return value;
    } catch (error) {
      // A failure that arrived after the Being changed is that change's failure,
      // not this one's: re-checking first means the caller is told SESSION_CHANGED
      // rather than a network message about a request nobody is waiting for.
      this.context(expected);
      const code = (error as ModelConfigError | null)?.code;
      if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) {
        // A mutation that failed in a way that cannot distinguish "not applied"
        // from "applied but unreadable" must say so: the user has to re-read.
        if (mutation && ['INVALID_RESPONSE', 'NETWORK_ERROR'].includes(code)) throw failure('RESULT_UNKNOWN');
        throw failure(code);
      }
      throw failure(mutation ? 'RESULT_UNKNOWN' : 'NETWORK_ERROR');
    }
  }

  private remember(value: unknown, expected: ExpectedContext): ModelConfigDto {
    this.context(expected);
    const result = modelConfigDto(value, expected.connectionId);
    this.snapshot = { connection: expected.connection, connectionId: expected.connectionId, baseUrl: result.config.baseUrl };
    return result;
  }

  async get(): Promise<ModelConfigDto> {
    if (this.busy) throw failure('BUSY');
    const expected = this.context(), revision = this.revision;
    const value = await this.request(expected);
    // A read that started before a write cannot be the answer after it.
    if (revision !== this.revision) throw failure('BUSY');
    return this.remember(value, expected);
  }

  async save(value: ModelPatchInput): Promise<ModelConfigDto> {
    const patch = validateModelPatch(value);
    const expected = this.context();
    if (value.connectionId !== expected.connectionId) throw failure('SESSION_CHANGED');
    if (this.busy) throw failure('BUSY');
    // A displayed address is redacted. Omit an unchanged address so saving a
    // model does not replace private URL credentials or query parameters.
    if (this.snapshot?.connection === expected.connection && this.snapshot.connectionId === expected.connectionId
        && patch.base_url === this.snapshot.baseUrl) delete patch.base_url;
    const operation = expected;
    this.operation = operation;
    this.revision++;
    try {
      await this.request(expected, patch);
      let current: ModelConfigDto;
      try { current = this.remember(await this.request(expected), expected); }
      catch (error) { if ((error as ModelConfigError).code === 'SESSION_CHANGED') throw error; throw failure('RESULT_UNKNOWN'); }
      const normalizeUrl = (url: string) => url.replace(/\/+$/, '');
      if (current.config.model !== patch.model || current.config.provider !== patch.provider
          || (patch.base_url && normalizeUrl(current.config.baseUrl) !== normalizeUrl(publicModelUrl(patch.base_url)))
          || (patch.api_key && current.config.hasApiKey !== true)) throw failure('RESULT_UNKNOWN');
      return current;
    } finally { if (this.operation === operation) this.operation = null; }
  }

  /** Side by Side, written the way Loom writes it.
   *
   * NEW IN THIS SHELL (integration plan §5.3): BeingDesktop only ever displayed
   * this value. It follows `save()` — same epoch checks, same busy rule, same
   * re-read to confirm — with one difference the measurement requires: what is
   * confirmed is `sbs_enabled` alone, because a PATCH that carries no model
   * cannot be verified against `patch.model`. */
  async setSideBySide(enabled: boolean, connectionId: number): Promise<ModelConfigDto> {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(connectionId) || connectionId < 0) throw failure('INVALID_REQUEST', 'Side by Side 设置无效，请重新读取。');
    const expected = this.context();
    if (connectionId !== expected.connectionId) throw failure('SESSION_CHANGED');
    if (this.busy) throw failure('BUSY');
    const operation = expected;
    this.operation = operation;
    this.revision++;
    try {
      await this.request(expected, { sbs_enabled: enabled ? 'on' : 'off' });
      let current: ModelConfigDto;
      try { current = this.remember(await this.request(expected), expected); }
      catch (error) { if ((error as ModelConfigError).code === 'SESSION_CHANGED') throw error; throw failure('RESULT_UNKNOWN'); }
      if (current.config.sbsEnabled !== enabled) throw failure('RESULT_UNKNOWN');
      return current;
    } finally { if (this.operation === operation) this.operation = null; }
  }
}
