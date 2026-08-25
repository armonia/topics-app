/**
 * Chat rows for the AGENT-FLEET tools.
 *
 * They live in their own file rather than in `ToolCards.tsx` for a measurable
 * reason: adding them took that file from 794 to 834 lines and broke the
 * `check:bloat` threshold. Raising the threshold was not the cure. These four
 * cards share nothing with the others except the place they used to sit in.
 *
 * Why they exist: measured 2026-08-25 against the real transcripts on this
 * machine, these tools were emitted by the CLI and rendered as blocks of raw
 * JSON. See `PARITY-01`.
 */
import { ClampedPre, ResultPre } from './ToolCards';

/** `SendMessage`: who wrote to whom. The body sits below, like every long row;
 *  the recipient goes on top, because that is what you scan for when rereading. */
export function AgentMessageCard({ to, message, result }: {
  to: string; summary?: string; message?: string; result?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-app-text-muted">a</span>
        <span className="font-mono text-app-text">{to}</span>
      </div>
      {message && <ClampedPre text={message} />}
      {result && <ResultPre text={result} />}
    </div>
  );
}

/** `ListAgents` / `TaskOutput` / `TaskStop`. One card, because the row states
 *  the same shape of thing: which operation, on whom, and what came back. */
export function AgentControlCard({ op, target, result }: {
  op: 'list' | 'output' | 'stop'; target?: string; result?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono text-app-text">{op}</span>
        {target && <span className="font-mono text-app-text-secondary break-all">{target}</span>}
      </div>
      {result && <ClampedPre text={result} />}
    </div>
  );
}

/** `Artifact`: publishing a page is neither a write nor a fetch. The URL is the
 *  thing the reader wants to be able to open. */
export function ArtifactCard({ action, title, url, filePath, result }: {
  action: string; title?: string; url?: string; filePath?: string; result?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono text-app-text">{action}</span>
        {title && <span className="text-app-text-secondary">{title}</span>}
        {filePath && <span className="font-mono text-app-text-muted break-all">{filePath}</span>}
      </div>
      {url && (
        <a href={url} target="_blank" rel="noreferrer"
           className="block break-all font-mono text-[11px] text-app-accent hover:underline">{url}</a>
      )}
      {result && <ResultPre text={result} />}
    </div>
  );
}

/** `AskUserQuestion`: the one tool whose entire purpose is to be read by a
 *  person. Rendering it as JSON hid exactly that. */
export function AskUserCard({ questions, result }: {
  questions: Array<{ question: string; header?: string; options?: string[] }>; result?: string;
}) {
  return (
    <div className="space-y-1.5">
      {questions.map((q, i) => (
        <div key={i} className="space-y-1">
          {q.header && <div className="text-[10px] uppercase tracking-wide text-app-text-muted">{q.header}</div>}
          <div className="text-[11px] text-app-text">{q.question}</div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {q.options.map((o, j) => (
                <span key={j} className="rounded border border-app-border px-1.5 py-0.5 text-[10px] text-app-text-secondary">{o}</span>
              ))}
            </div>
          )}
        </div>
      ))}
      {result && <ResultPre text={result} />}
    </div>
  );
}
