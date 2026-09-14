import type { Connection } from './connection';
import { upstreamRequest } from './proxy';

// Verify the saved Being endpoint and credential before starting local tools.
// A failed check does not erase configuration or prevent the client opening.
export async function verifyBeingConnection(connection: Connection | null, fetcher: typeof fetch): Promise<void> {
  if (!connection) throw new Error('尚未配置 Being，Portal 未启动。');
  const request = upstreamRequest(new Request('beings://chat/api/status'), connection);
  try {
    const response = await fetcher(request.url, { headers: request.headers, redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (response.status === 401 || response.status === 403) throw new Error('Being 凭据验证失败，Portal 未启动。请检查连接设置。');
    if (!response.ok || !response.body) throw new Error('Being 暂时无法连接，Portal 未启动。请稍后重试。');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 64_000) throw new Error('Being 状态响应无效，Portal 未启动。');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const status = JSON.parse(Buffer.concat(chunks).toString());
    if (!status || typeof (status.being_name || status.name) !== 'string' || !(status.being_name || status.name).trim()) {
      throw new Error('Being 状态响应无效，Portal 未启动。');
    }
  } catch (error) {
    // Never surface a URL containing the saved token from network errors.
    if (error instanceof Error && error.message.startsWith('Being ')) throw error;
    throw new Error('无法验证 Being 连接，Portal 未启动。请检查网络或连接设置后重试。');
  }
}
