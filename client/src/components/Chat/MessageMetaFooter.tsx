interface Props {
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costCents?: number | null;
}

/**
 * Tiny footer strip shown below an assistant message.
 *
 * Each field is optional — if none are present the footer renders nothing
 * (returns null) so old/unmetered messages stay clean.
 *
 * The format mirrors the reference screenshot: `<duration>s · <tokens> tokens · $<cost>`.
 */
export function MessageMetaFooter({ latencyMs, promptTokens, completionTokens, costCents }: Props) {
  const total = (promptTokens ?? 0) + (completionTokens ?? 0);
  const parts: string[] = [];

  if (typeof latencyMs === 'number' && latencyMs > 0) {
    const seconds = latencyMs / 1000;
    parts.push(seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`);
  }
  if (total > 0) {
    parts.push(`${total.toLocaleString()} tokens`);
  }
  if (typeof costCents === 'number' && costCents > 0) {
    const usd = costCents / 100;
    parts.push(usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);
  }

  if (parts.length === 0) return null;

  return (
    <div data-testid="message-meta-footer" className="mt-2 text-[10px] text-app-text-muted flex items-center gap-1.5 flex-wrap">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-app-text-muted/60">·</span>}
          <span>{p}</span>
        </span>
      ))}
    </div>
  );
}
