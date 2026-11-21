import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { deterministicReadableView, type ReadableView } from '../../../../shared/readable-view';
import { unwrapStoredToolResult } from '../../../../shared/tool-result-text';
import { setReadableViewPrefs, useReadableViewPrefs } from '../../state/readableViewPrefs';
import { parseJsonResult } from '../../lib/jsonResult';
import { useFallbackView } from '../../state/readableViewFallback';
import { useT } from '@/hooks/useT';

const TONE: Record<string, string> = {
  neutral: 'bg-app-hover text-app-text-secondary',
  success: 'bg-green-500/15 text-green-600',
  danger: 'bg-red-500/15 text-red-500',
  warning: 'bg-amber-500/15 text-amber-600',
};

function isUrl(href: string | undefined): href is string {
  return !!href && /^https?:\/\//.test(href);
}

/** One catalog view as markup: a table scrolls sideways inside its own box, so a narrow chat never overflows. */
function ReadableViewBody({ view }: { view: ReadableView }) {
  switch (view.kind) {
    case 'kv':
      return (
        <dl data-testid="readable-kv" className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-mini">
          {view.fields.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-app-text-muted">{f.label}</dt>
              <dd className="text-app-text break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded border border-app-border">
          <table data-testid="readable-table" className="w-full text-mini text-left">
            <thead className="bg-app-hover/60 text-app-text-secondary">
              <tr>{view.columns.map((c, i) => <th key={i} className="px-2 py-1 font-medium whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody>
              {view.rows.map((row, r) => (
                <tr key={r} className="border-t border-app-border">
                  {row.map((cell, c) => <td key={c} className="px-2 py-1 text-app-text align-top">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list':
      return (
        <ul data-testid="readable-list" className="space-y-0.5 text-mini">
          {view.items.map((it, i) => (
            <li key={i} className="font-mono break-all text-app-text">
              {isUrl(it.href)
                ? <a href={it.href} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">{it.text}</a>
                : it.text}
            </li>
          ))}
        </ul>
      );
    case 'chip':
      return <span data-testid="readable-chip" className={`inline-block rounded-full px-2 py-0.5 text-mini ${TONE[view.tone ?? 'neutral']}`}>{view.text}</span>;
    case 'counter':
      return (
        <div data-testid="readable-counter" className="inline-flex items-baseline gap-1.5">
          <span className="text-prose font-semibold text-app-text">{view.value}</span>
          <span className="text-mini text-app-text-muted">{view.label}</span>
        </div>
      );
    case 'error':
      return <div data-testid="readable-error" className="rounded bg-red-500/5 px-2 py-1.5 text-mini text-red-500 break-words">{view.message}</div>;
  }
}

/**
 * A JSON tool result as a laid-out view, with a Readable / Original switch.
 * `original` is the coloured text, drawn by the caller and untouched, so
 * flipping the switch never changes it. A shape the pure matcher does not know
 * asks the model fallback once; until it answers (or if it cannot) the
 * original shows, so the text is never blocked. Plain-text results render the
 * original only, with no switch.
 */
export function ReadableResult({ text, toolName, original }: { text: string; toolName: string; original: ReactNode }) {
  const tr = useT();
  const prefs = useReadableViewPrefs();
  const value = useMemo(() => parseJsonResult(unwrapStoredToolResult(text)), [text]);
  const pure = useMemo(() => (value === undefined ? null : deterministicReadableView(value)), [value]);
  const asked = useFallbackView(toolName, value, value !== undefined && !pure && prefs.fallbackEnabled, prefs.model);
  const view = pure ?? asked;
  if (!view) return <>{original}</>;
  return (
    <div className="space-y-1" data-testid="readable-result">
      <div role="group" aria-label={tr('tool.readable.switchLabel')} className="inline-flex rounded border border-app-border text-mini overflow-hidden">
        {(['readable', 'original'] as const).map((m) => (
          <button key={m} type="button" data-testid={`readable-mode-${m}`} aria-pressed={prefs.mode === m}
            className={`px-2 py-0.5 ${prefs.mode === m ? 'bg-app-hover text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
            onClick={() => setReadableViewPrefs({ mode: m })}>
            {tr(m === 'readable' ? 'tool.readable.readable' : 'tool.readable.original')}
          </button>
        ))}
      </div>
      {prefs.mode === 'readable' ? <ReadableViewBody view={view} /> : original}
    </div>
  );
}
