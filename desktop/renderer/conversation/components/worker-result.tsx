// A finished Worker's result, where the task was delegated. Ported from
// BeingDesktop 0.8.26 renderer/chat-app.js `workerResult` (line 372) and its
// rules in test/chat-worker-results-ui.cjs; 2026-09-16.
//
// The card sits inside an ordinary Being bubble, so it keeps the conversation's
// own meta line and its place in time. Everything it draws is text: a Worker's
// summary was written by a CLI this machine ran, and React renders it as a text
// node — no markdown, no HTML, nothing that could become active markup.
import { useState } from "react";
import type { ChatWorkerResult } from "../../../shared/desktop-types";
import { workerStatusLabel } from "../models/worker-results";

export function WorkerResultCard({ result, onOpen }: {
  result: ChatWorkerResult;
  onOpen: (result: ChatWorkerResult) => void | Promise<void>;
}) {
  const [opening, setOpening] = useState(false);
  return (
    <section className="chat-worker-result" data-worker-id={result.workerId}>
      <div className="chat-worker-status">{workerStatusLabel(result.status)}</div>
      <h3>{result.title}</h3>
      <div className="chat-worker-summary">{result.summary}</div>
      {/* Only where there is something to preview. A button that opened nothing
          would be a promise the orchestration layer never made. */}
      {result.preview && (
        <button
          type="button"
          className="chat-worker-open"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            try { await onOpen(result); } finally { setOpening(false); }
          }}
        >
          打开预览
        </button>
      )}
      {!!result.evidence && (
        <details className="chat-worker-evidence">
          <summary>查看验证依据</summary>
          <div>{result.evidence}</div>
        </details>
      )}
    </section>
  );
}
