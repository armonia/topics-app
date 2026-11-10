import clsx from 'clsx';
import type { AnonKind, AnonSegment } from './anonymize';
import { Chip } from '../primitives/Chip';

/** A placeholder as the AI reads it: monospace on a quiet tint. */
function Token({ children }: { children: string }) {
  return (
    <span className="mx-px inline-flex items-center rounded bg-violet-500/15 px-1 font-mono text-[0.92em] font-medium text-violet-800 dark:text-violet-300">
      {children}
    </span>
  );
}

/**
 * The text of a case as Topics keeps it: every value that is recognised is
 * marked, the ones that go out as placeholders in red, the ones left in clear
 * (their category is off) in amber.
 */
export function TopicsText({ segments, title }: { segments: AnonSegment[]; title: string }) {
  return (
    <p aria-label={title} className="whitespace-pre-wrap break-words text-prose leading-6 text-app-text">
      {segments.map((s, i) =>
        s.token ? (
          <mark
            key={i}
            data-tip={s.token}
            className={clsx('rounded px-0.5 text-app-text', s.masked ? 'bg-rose-500/15' : 'bg-amber-500/20')}
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

/** The same text as it leaves for the AI: the recognised values replaced by their placeholders. */
export function SentText({ segments, title }: { segments: AnonSegment[]; title: string }) {
  return (
    <p aria-label={title} className="whitespace-pre-wrap break-words text-prose leading-6 text-app-text">
      {segments.map((s, i) => (s.token && s.masked ? <Token key={i}>{s.token}</Token> : <span key={i}>{s.text}</span>))}
    </p>
  );
}

/** A text made of runs, some of them placeholders: the reply of the AI, seen from the AI or from Topics. */
export function ReplyText({ parts }: { parts: Array<{ text: string; token?: boolean; value?: boolean }> }) {
  return (
    <span>
      {parts.map((p, i) => (p.token ? <Token key={i}>{p.text}</Token> : p.value ? <b key={i} className="font-semibold">{p.text}</b> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

export interface MappingRow {
  token: string;
  kind: AnonKind;
  value: string;
  masked: boolean;
}

/** The correspondence table of a trial: placeholder, value and whether it is replaced. */
export function MappingTable({ rows, labels }: { rows: MappingRow[]; labels: { token: string; value: string; masked: string; clear: string } }) {
  return (
    <div role="table" className="overflow-x-auto rounded-lg border border-app-border">
      <div className="min-w-[420px]">
        {rows.map((r) => (
          <div key={r.token} role="row" className="grid grid-cols-[150px_minmax(0,1fr)_96px] items-center gap-3 border-b border-app-border px-3 py-1.5 last:border-b-0">
            <span role="cell"><Token>{r.token}</Token></span>
            <span role="cell" className="truncate text-prose text-app-text">{r.value}</span>
            <span role="cell"><Chip tone={r.masked ? 'green' : 'amber'}>{r.masked ? labels.masked : labels.clear}</Chip></span>
          </div>
        ))}
      </div>
    </div>
  );
}
