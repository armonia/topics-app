import { FileText } from 'lucide-react';
import clsx from 'clsx';
import type { SourceModel } from '../types';

const CHIP = 'mx-0.5 inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 align-[1px] text-mini font-medium leading-4 text-sky-700 dark:text-sky-300';

/**
 * The source of a value: the original file and its page, inline in the text it
 * supports. With `onOpen` it is a button that opens the original at that page;
 * without it the same chip is plain text, so it never answers a click with
 * nothing. The label alone is what a reader needs to trust the sentence.
 */
export function Source({ source, pageLabel, onOpen, className }: {
  source: SourceModel;
  /** Formats the page in the caller's language, e.g. `p.5`. */
  pageLabel: (n: number) => string;
  onOpen?: (source: SourceModel) => void;
  className?: string;
}) {
  const text = [source.label, source.page === undefined ? null : pageLabel(source.page)].filter(Boolean).join(' · ');
  /* On a narrow screen a long label ends in «…»; the whole of it stays in the tooltip. */
  const body = <><FileText size={12} className="shrink-0" aria-hidden="true" /><span className="truncate">{text}</span></>;
  if (!onOpen) return <span className={clsx(CHIP, className)} data-tip={text}>{body}</span>;
  return (
    <button type="button" onClick={() => onOpen(source)} data-tip={text} className={clsx(CHIP, 'hover:bg-sky-500/20 hover:underline underline-offset-2', className)}>
      {body}
    </button>
  );
}
