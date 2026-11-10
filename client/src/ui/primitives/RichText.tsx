import type { RichTextModel, SourceModel } from '../types';
import { Source } from './Source';

/**
 * Text whose claims carry their source inline: every `{ source }` segment is a
 * citation chip that opens the original at that page.
 */
export function RichText({ text, pageLabel, onOpenSource }: {
  text: RichTextModel;
  pageLabel: (n: number) => string;
  onOpenSource?: (source: SourceModel) => void;
}) {
  return (
    <>
      {text.map((part, i) => {
        if (typeof part === 'string') return <span key={i}>{part}</span>;
        if ('strong' in part) return <strong key={i} className="font-semibold text-app-text">{part.strong}</strong>;
        if ('mark' in part) return <mark key={i} className="rounded-sm bg-sky-500/15 px-0.5 text-app-text underline decoration-sky-500/40 underline-offset-[3px]">{part.mark}</mark>;
        return <Source key={i} source={part.source} pageLabel={pageLabel} onOpen={onOpenSource} />;
      })}
    </>
  );
}
