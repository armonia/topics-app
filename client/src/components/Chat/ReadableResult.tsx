import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { deterministicReadableView, type Cell, type KvField, type ReadableView } from '../../../../shared/readable-view';
import { unwrapStoredToolResult } from '../../../../shared/tool-result-text';
import { setReadableViewPrefs, useReadableViewPrefs } from '../../state/readableViewPrefs';
import { readableDate } from '../../lib/readableDate';
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

function Chip({ text, tone = 'neutral' }: { text: string; tone?: string }) {
  return <span className={`inline-block max-w-full rounded-full px-2 py-0.5 text-mini whitespace-nowrap ${TONE[tone]}`}>{text}</span>;
}

/** A cell by its type: status chip, row of chips, readable date, dash for nothing, else plain text that never breaks mid-word. */
function CellValue({ cell }: { cell: Cell }) {
  if (cell.kind === 'status') return <Chip text={cell.text} tone={cell.tone} />;
  if (cell.kind === 'chips') return <span className="inline-flex flex-wrap gap-1">{cell.items?.map((it, i) => <Chip key={i} text={it} />)}</span>;
  if (cell.kind === 'date') return <time dateTime={cell.text} className="whitespace-nowrap">{readableDate(cell.text)}</time>;
  if (cell.kind === 'empty') return <span className="text-app-text-muted">{cell.text}</span>;
  return <>{cell.text}</>;
}

function FieldList({ fields, testId }: { fields: KvField[]; testId?: string }) {
  return (
    <dl data-testid={testId} className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 text-mini">
      {fields.map((f, i) => (
        <div key={i} className="contents">
          <dt className="text-app-text-muted">{f.label}</dt>
          <dd className="text-app-text [overflow-wrap:anywhere]"><CellValue cell={f.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One catalog view as markup. A table scrolls sideways inside its own box with
 * unbreakable cells, and under 480 px each row becomes a small card instead,
 * so no word is ever broken letter by letter.
 */
function ReadableViewBody({ view }: { view: ReadableView }) {
  switch (view.kind) {
    case 'kv':
      return <FieldList fields={view.fields} testId="readable-kv" />;
    case 'card':
      return (
        <div data-testid="readable-card" className="space-y-1.5 rounded border border-app-border bg-app-hover/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-prose font-semibold text-app-text [overflow-wrap:anywhere]">{view.title}</span>
            {view.status && <CellValue cell={view.status} />}
          </div>
          {view.labels.length > 0 && <div className="flex flex-wrap gap-1">{view.labels.map((l, i) => <Chip key={i} text={l} />)}</div>}
          {view.fields.length > 0 && <FieldList fields={view.fields} />}
        </div>
      );
    case 'table':
      return (
        <>
          <div className="hidden min-[480px]:block overflow-x-auto rounded border border-app-border">
            <table data-testid="readable-table" className="w-full text-mini text-left">
              <thead className="bg-app-hover/60 text-app-text-secondary">
                <tr>{view.columns.map((c, i) => <th key={i} className="px-2 py-1 font-medium whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {view.rows.map((row, r) => (
                  <tr key={r} className="border-t border-app-border">
                    {row.map((cell, c) => <td key={c} className={`px-2 py-1 text-app-text align-top ${cell.kind === 'chips' ? '' : 'whitespace-nowrap'}`}><CellValue cell={cell} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div data-testid="readable-table-cards" className="space-y-1.5 min-[480px]:hidden">
            {view.rows.map((row, r) => (
              <div key={r} className="rounded border border-app-border px-2 py-1.5">
                <FieldList fields={row.map((cell, c) => ({ label: view.columns[c], value: cell }))} />
              </div>
            ))}
          </div>
        </>
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
      return <span data-testid="readable-chip"><Chip text={view.text} tone={view.tone} /></span>;
    case 'counter':
      return (
        <div data-testid="readable-counter" className="inline-flex items-baseline gap-1.5">
          <span className="text-prose font-semibold text-app-text"><CellValue cell={view.value} /></span>
          <span className="text-mini text-app-text-muted">{view.label}</span>
        </div>
      );
    case 'error':
      return <div data-testid="readable-error" className="rounded bg-red-500/5 px-2 py-1.5 text-mini text-red-500 break-words">{view.message}</div>;
  }
}

/** The arguments of a call as a row of key: value chips instead of a JSON line. */
export function ArgChips({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  return (
    <div data-testid="tool-call-args" className="flex flex-wrap gap-1 text-mini">
      {entries.map(([k, v]) => {
        const text = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        return (
          <span key={k} className="inline-flex max-w-full gap-1 rounded bg-app-hover/60 px-1.5 py-0.5">
            <span className="text-app-text-muted">{k}</span>
            <span className="text-app-text truncate">{text.length > 80 ? `${text.slice(0, 79)}…` : text}</span>
          </span>
        );
      })}
    </div>
  );
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
