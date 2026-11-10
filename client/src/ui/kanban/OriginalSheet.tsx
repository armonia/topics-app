import type { ReactNode } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import clsx from 'clsx';
import type { OriginalModel, QuoteMarkModel } from './model';

/** The typeface a kind of paper is printed in: letters and calls read as prose, forms and invoices as a printout. */
const FACE: Record<OriginalModel['kind'], string> = {
  mail: 'font-serif',
  photo: 'font-sans',
  screen: 'font-sans',
  form: 'font-mono',
  invoice: 'font-mono',
  tender: 'font-serif',
  sheet: 'font-mono',
  letter: 'font-serif',
  call: 'font-sans italic',
};

interface Span {
  start: number;
  end: number;
  mark: QuoteMarkModel;
}

/**
 * Where each passage sits: the first line that carries its words verbatim, and
 * the place in that line. Passages that overlap one already placed are left
 * out, so a line is cut into plain runs and marked runs that never cross.
 */
function placeMarks(lines: string[], marks: QuoteMarkModel[]): Span[][] {
  const out: Span[][] = lines.map(() => []);
  for (const mark of marks) {
    const row = lines.findIndex((l) => l.includes(mark.quote));
    if (row < 0) continue;
    const start = lines[row].indexOf(mark.quote);
    const span = { start, end: start + mark.quote.length, mark };
    if (out[row].some((s) => s.start < span.end && span.start < s.end)) continue;
    out[row].push(span);
  }
  for (const row of out) row.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * An original as it was received, on a sheet of paper: its lines as written,
 * with the words each value was read from marked. The active value's words
 * are marked strongly; a mark is a button that makes its value the active one.
 * The paper stays white in the dark theme too, as a page does in a viewer.
 * A photo shows its frame first and its description under it.
 */
export function OriginalSheet({ original, marks, active, onMark, size = 'inline', photoLabel, markLabel }: {
  original: OriginalModel;
  marks: QuoteMarkModel[];
  active?: string;
  onMark?: (id: string) => void;
  size?: 'inline' | 'page';
  photoLabel: string;
  /** The accessible name of a mark: which value it gives. */
  markLabel?: (mark: QuoteMarkModel) => string;
}) {
  const placed = placeMarks(original.lines, marks);
  const page = size === 'page';
  const render = (line: string, spans: Span[]): ReactNode[] => {
    const parts: ReactNode[] = [];
    let at = 0;
    spans.forEach((s, i) => {
      if (s.start > at) parts.push(line.slice(at, s.start));
      const on = s.mark.id === active;
      const cls = clsx(
        'rounded-[3px] px-0.5 text-zinc-900 transition-colors',
        on ? 'bg-amber-300 ring-2 ring-amber-500/80' : 'bg-amber-200/70 hover:bg-amber-300/80',
      );
      parts.push(onMark ? (
        <button
          key={`m${i}`}
          type="button"
          data-quote={s.mark.id}
          aria-pressed={on}
          data-tip={markLabel?.(s.mark) ?? s.mark.label}
          onClick={() => onMark(s.mark.id)}
          className={clsx(cls, 'inline cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60')}
        >
          {line.slice(s.start, s.end)}
        </button>
      ) : (
        <mark key={`m${i}`} data-quote={s.mark.id} className={cls}>{line.slice(s.start, s.end)}</mark>
      ));
      at = s.end;
    });
    if (at < line.length) parts.push(line.slice(at));
    return parts;
  };
  return (
    <article
      aria-label={original.name}
      className={clsx(
        'mx-auto w-full rounded-[3px] bg-white text-zinc-800 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.06]',
        page ? clsx(original.kind === 'screen' ? 'max-w-[1040px]' : 'max-w-[720px]', 'px-10 py-12 max-sm:px-5 max-sm:py-7') : 'px-5 py-5',
      )}
    >
      {original.image && (
        <figure className="mb-4 overflow-hidden rounded-sm ring-1 ring-black/[0.08]">
          <img src={original.image} alt={original.name} className="block h-auto w-full" loading="lazy" decoding="async" />
        </figure>
      )}
      {original.kind === 'photo' && !original.image && (
        <figure className={clsx('mb-4 flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-sm bg-zinc-200 text-zinc-500', page ? 'max-h-[380px]' : 'max-h-[200px]')}>
          <ImageIcon size={page ? 36 : 26} aria-hidden="true" />
          <figcaption className="font-sans text-mini">{photoLabel}</figcaption>
        </figure>
      )}
      <div className={clsx('flex flex-col', FACE[original.kind], page ? 'gap-3 text-body-lg leading-7' : 'gap-2 text-prose leading-6', original.kind === 'form' || original.kind === 'invoice' ? 'text-prose' : '')}>
        {original.lines.map((line, i) => (
          <p
            key={i}
            className={clsx(
              'whitespace-pre-wrap [overflow-wrap:anywhere]',
              i === 0 && original.kind !== 'photo' && original.kind !== 'screen' && 'font-semibold text-zinc-900',
            )}
          >
            {render(line, placed[i])}
          </p>
        ))}
      </div>
    </article>
  );
}
