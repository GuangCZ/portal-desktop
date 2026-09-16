// The Being's runtime line, as BeingDesktop 0.8.26 assembles it. Ported line by
// line from src/runtime.cjs (55 lines); 2026-09-16.
//
// Three reads make one runtime: `/api/status` (is the Being reachable),
// `/api/llm/config` (which model, and whether Side by Side is configured) and
// `/api/stream/active` (is it answering someone right now). 0.8.26 issues all
// three together from `doRefresh` (src/main.cjs line 972) and keeps the result in
// `state.runtime`.
//
// WHAT THIS SHELL USES, AND WHAT IT DOES NOT. The model-settings subsystem reads
// only `/api/llm/config`: the other two belong to the conversation layer, which
// polls `/api/status` for readiness and `/api/stream/active` for the stream it is
// attached to, and duplicating those here would mean two clients asking the same
// Being the same question on two different timers. So the subsystem builds its
// state with `updateRuntimeConfig(emptyRuntime(), dto)` — the config half filled
// in, `status` left `unknown` and `activeStream.active` left `null`, which is
// exactly what BeingDesktop's own test asserts of that function ("updates
// configuration without claiming runtime or stream health", test/model-config
// .test.cjs). `readRuntime` is ported with it because it is the definition of
// the fields — `sideBySide.configured` comes from `sbs_enabled` and from nowhere
// else — and because a later unit that does own all three reads should find it
// here rather than write it again.
//
// `sideBySide.active` has no source in this shell at all. In 0.8.26 it arrived as
// a `beings:sbs-state` message from the Loom page, which the native conversation
// replaced; it stays `null` (unknown) and the settings page says so rather than
// claiming the Being is asleep.
import { publicModelUrl } from '../common/loom-connection';

export interface SideBySideState {
  /** What the Being has saved: `sbs_enabled` from `/api/llm/config`. `null` is
   * "not yet read / not answered", which is not the same as off. */
  configured: boolean | null;
  /** Whether the waking loop is running right now. Always `null` in this shell —
   * see the header. */
  active: boolean | null;
}

export interface ActiveStreamState {
  active: boolean | null;
  id?: string;
  sessionId?: string;
  phase?: string;
  tool?: string;
}

export interface RuntimeState {
  status: string;
  error: string;
  checkedAt: string | null;
  configStatus: string;
  configError: string;
  configCheckedAt: string | null;
  model: string;
  provider: string;
  baseUrl: string;
  sideBySide: SideBySideState;
  activeStream: ActiveStreamState;
}

/** The config half of a confirmed `/api/llm/config` read. `ModelConfigDto`
 * structurally, declared here so runtime.ts and config.ts stay independent. */
export interface RuntimeConfigSnapshot {
  checkedAt: string;
  config: { model: string; provider: string; baseUrl: string; sbsEnabled: boolean | null };
}

export function emptyRuntime(): RuntimeState {
  return {
    status: 'unknown', error: '', checkedAt: null, configStatus: 'unknown', configError: '', configCheckedAt: null,
    model: '', provider: '', baseUrl: '', sideBySide: { configured: null, active: null }, activeStream: { active: null },
  };
}

type Settled = PromiseSettledResult<unknown>;

export function readRuntime(results: [Settled, Settled, Settled], checkedAt: string): RuntimeState {
  const next = emptyRuntime();
  const [health, config, active] = results;
  next.checkedAt = checkedAt;
  next.configCheckedAt = checkedAt;
  next.status = health.status === 'fulfilled' ? 'connected' : 'error';
  next.error = next.status === 'error' ? '运行时状态读取失败，请检查网络与连接凭据。' : '';
  const c = config.status === 'fulfilled' && (config.value as Record<string, unknown> | null);
  if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.model === 'string' && typeof c.provider === 'string') {
    next.configStatus = 'connected';
    next.model = c.model;
    next.provider = c.provider;
    next.baseUrl = publicModelUrl(String(c.base_url ?? ''));
    next.sideBySide.configured = typeof c.sbs_enabled === 'boolean' ? c.sbs_enabled : null;
  } else {
    next.configStatus = 'error';
    next.configError = '模型与并肩配置读取失败，当前值未知；重新读取成功后更新。';
  }
  if (active.status === 'fulfilled') {
    const value = active.value as Record<string, unknown> | null;
    if (value === null) next.activeStream.active = false;
    else if (typeof value?.finished === 'boolean') next.activeStream.active = !value.finished;
    if (next.activeStream.active === true) {
      const stream = value as Record<string, unknown>;
      const safe = (item: unknown) => typeof item === 'string' ? item.slice(0, 160) : '';
      next.activeStream.id = safe(stream.stream_id);
      next.activeStream.sessionId = safe(stream.session_id);
      next.activeStream.phase = 'awaiting_first';
      next.activeStream.tool = '';
      const phases: Record<string, string> = { thinking: 'reasoning', reasoning: 'reasoning', tool_use: 'tool', tool_result: 'working', content_block_delta: 'text', message_stop: 'continuing', error: 'error' };
      for (const item of (Array.isArray(stream.events) ? stream.events : []) as Record<string, unknown>[]) {
        if (!item || !Object.hasOwn(phases, String(item.event))) continue;
        next.activeStream.phase = phases[String(item.event)];
        next.activeStream.tool = item.event === 'tool_use' ? safe((item.data as Record<string, unknown> | undefined)?.name) : '';
      }
    }
  }
  return next;
}

/** A confirmed read replaces the configuration half and nothing else: it says
 * nothing about whether the Being is reachable or streaming. */
export function updateRuntimeConfig(runtime: RuntimeState, snapshot: RuntimeConfigSnapshot): RuntimeState {
  const { config, checkedAt } = snapshot;
  return {
    ...runtime, configStatus: 'connected', configError: '', configCheckedAt: checkedAt,
    model: config.model, provider: config.provider, baseUrl: config.baseUrl,
    sideBySide: { ...runtime.sideBySide, configured: config.sbsEnabled },
  };
}
