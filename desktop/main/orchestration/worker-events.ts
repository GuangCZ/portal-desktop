// Ported from BeingDesktop 0.8.26 src/worker-events.cjs on 2026-09-16.
// Adapter event mappings are measured, not inferred: see docs/orchestration.md "Agent adapters"
// (Claude Code stream measured 2026-09-11 on 2.1.245).

import { sanitizeText } from '../common/sanitize';
import type { NormalizedEvent } from './types';

export const clean = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return sanitizeText(text) + (text.length > 2000 ? '\n[内容已截断]' : '');
};

// Text of a tool_result: the CLI sends a string or a list of content blocks.
const resultText = (content: unknown): unknown => Array.isArray(content)
  ? content.map((part) => typeof part?.text === 'string' ? part.text : part?.type === 'image' ? '[图片]' : '').filter(Boolean).join('\n')
  : content;

type AgentEvent = Record<string, any>;

// One line can carry several events (an assistant message with text and tool calls); callers
// accept an event or an array of them.
export function normalizeEvent(agent: string, value: unknown): NormalizedEvent | NormalizedEvent[] | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as AgentEvent;
  const type = event.type;
  if (agent === 'claude') {
    // Measured 2026-09-11 (Claude Code 2.1.245, `-p --output-format stream-json --verbose`):
    // system/init opens the session; assistant messages carry text and tool_use blocks; user
    // messages carry tool_result blocks keyed by tool_use_id; system/permission_denied precedes a
    // refused tool's failed result; the final result reports is_error even with subtype success.
    if (type === 'system') {
      if (event.subtype === 'init') return { kind: 'session', sessionId: clean(event.session_id) };
      if (event.subtype === 'permission_denied') return { kind: 'status', text: clean(`${event.tool_name || '工具'} 需要审批，无人值守执行已拒绝`) };
      if (event.subtype === 'api_retry') return { kind: 'status', text: `模型请求重试 ${Number(event.attempt) || 0}/${Number(event.max_retries) || 0}` };
      return null;
    }
    const content: AgentEvent[] = Array.isArray(event.message?.content) ? event.message.content : [];
    if (type === 'assistant') {
      const events: NormalizedEvent[] = [];
      const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
      if (text) events.push({ kind: 'message', text: clean(text) });
      for (const part of content) if (part?.type === 'tool_use') events.push({ kind: 'tool', callId: clean(part.id), name: clean(part.name || 'tool'), status: 'running', text: clean(part.input ?? ''), output: '' });
      return events.length ? events : null;
    }
    if (type === 'user') {
      const events: NormalizedEvent[] = content.filter((part) => part?.type === 'tool_result').map((part) => ({ kind: 'tool', callId: clean(part.tool_use_id), name: '', status: part.is_error === true ? 'failed' : 'completed', text: '', output: clean(resultText(part.content) ?? '') }));
      return events.length ? events : null;
    }
    if (type === 'result') return { kind: 'result', success: event.is_error !== true && event.subtype === 'success', text: clean(event.result ?? ''), sessionId: clean(event.session_id) };
    if (type === 'error') return { kind: 'error', text: clean(event.message || event.error?.message || 'Worker 执行失败。') };
    return null;
  }
  if (agent === 'codex' && type === 'error' && /^Reconnecting\.\.\.\s+\d+\/\d+\b/.test(event.message || '')) return { kind: 'status', text: clean(event.message) };
  if (type === 'error' || type === 'turn.failed') return { kind: 'error', text: clean(event.message || event.error?.message || 'Worker 执行失败。') };
  if (agent === 'codex') {
    if (type === 'thread.started') return { kind: 'session', sessionId: clean(event.thread_id) };
    if (type === 'turn.completed') return { kind: 'result', success: true };
    const item = event.item;
    if (item && ['item.started', 'item.updated', 'item.completed'].includes(type)) {
      if (item.type === 'agent_message') return { kind: 'message', text: clean(item.text) };
      if (item.type === 'reasoning') return { kind: 'status', text: '正在分析任务' };
      return {
        kind: 'tool', callId: clean(item.id), name: clean(item.tool || item.type), status: item.status || (type === 'item.completed' ? 'completed' : 'running'),
        text: clean(item.command || item.changes || item.arguments || ''), output: clean(item.aggregated_output || item.result || item.error || ''),
      };
    }
  }
  if (agent === 'cursor') {
    if (type === 'system') return { kind: 'session', sessionId: clean(event.session_id) };
    if (type === 'assistant') return { kind: 'message', text: clean(event.message?.content?.filter((part: AgentEvent) => part.type === 'text').map((part: AgentEvent) => part.text).join('\n')) };
    if (type === 'tool_call') {
      const [name, call] = Object.entries<AgentEvent>(event.tool_call || {})[0] || ['tool', {}];
      return { kind: 'tool', callId: clean(event.call_id), name: clean(call.name || name), status: event.subtype === 'completed' ? (call.result?.error ? 'failed' : 'completed') : 'running', text: clean(call.args || call.arguments), output: clean(call.result) };
    }
    if (type === 'result') return { kind: 'result', success: event.is_error !== true && event.subtype === 'success', text: clean(event.result), sessionId: clean(event.session_id) };
  }
  if (agent === 'grok') {
    if (type === 'thought') return { kind: 'status', text: '正在分析任务' };
    if (type === 'text') return { kind: 'message', text: clean(event.data), append: true };
    if (type === 'tool_call' || type === 'tool_call_update') return { kind: 'tool', callId: clean(event.toolCallId), name: clean(event.toolName || event.title || ''), status: event.status || 'running', text: clean(event.rawInput), output: clean(event.rawOutput || event.content) };
    if (type === 'end') return { kind: 'result', success: event.stopReason === 'end_turn', text: '', sessionId: clean(event.sessionId) };
  }
  return null;
}
