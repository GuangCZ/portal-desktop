// Ported from BeingDesktop 0.8.26 src/native-worker-results.cjs on 2026-09-16.

import type { NativeWorkerResult, WorkerResultSource } from './types';

// Worker history already owns persistence and identity. Project only display fields.
export function nativeWorkerResults(workers: readonly WorkerResultSource[], sessionId: string): NativeWorkerResult[] {
  return workers.filter((worker) => worker.sessionId === sessionId && (worker.presentation || worker.review?.summary))
    .map((worker) => ({
      workerId: worker.id, sessionId, title: worker.title,
      at: worker.endedAt || worker.updatedAt, preview: Boolean(worker.presentation),
      status: worker.review?.summary ? worker.review.status! : 'ready',
      summary: worker.review?.summary || '结果已生成，可以在 Desktop 内置浏览器中打开。',
      evidence: worker.review?.evidence || '',
    }));
}
