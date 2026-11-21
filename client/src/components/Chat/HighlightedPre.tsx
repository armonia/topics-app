import { useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { highlightCode, subscribeHighlighter, highlighterReady } from '../../lib/syntaxHighlight';

/**
 * Monospace block with lazy syntax highlighting. hljs ESCAPES the source and
 * only wraps tokens in class-only <span>s, so the injected HTML is safe by
 * construction (same posture as MessageContent's CodeBlock). Until the
 * tokenizers land — or for unknown languages / oversize payloads — it renders
 * the plain text exactly like the previous raw <pre>.
 */
export function HighlightedPre({ code, lang, className, testId, prefix }: {
  code: string; lang: string; className: string; testId?: string;
  /** Literal chrome rendered before the code, outside highlighting ("$ "). */
  prefix?: ReactNode;
}) {
  // Third argument = same getter: nothing changes in the browser, and the
  // static render of unit tests (renderToStaticMarkup) stops throwing here.
  const ready = useSyncExternalStore(subscribeHighlighter, highlighterReady, highlighterReady);
  const html = useMemo(
    () => (lang ? highlightCode(code, lang) : null),
    // `ready` re-runs the memo once the lazy tokenizers land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang, ready],
  );
  return (
    // `tool-card-code` scopes the theme-aware hljs palette (index.css) —
    // tool card surfaces follow the app theme, unlike always-dark fences.
    <pre data-testid={testId} className={`tool-card-code ${className}`}>
      {prefix}
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : code}
    </pre>
  );
}
