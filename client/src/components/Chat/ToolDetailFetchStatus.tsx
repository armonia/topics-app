/**
 * The status line of the lazy body fetch of a tool row.
 *
 * A trimmed row pulls its full output the first time it opens. While that
 * runs, and if it fails, the card alone would show a command with no output,
 * which reads as "the command printed nothing". This line keeps the two apart:
 * loading says it is coming, error says it is not and why.
 */
import { Loader2 } from 'lucide-react';
import { useT } from '../../hooks/useT';

export type ToolDetailFetchState = 'idle' | 'loading' | 'done' | 'error';

export function ToolDetailFetchStatus({ state, error }: { state: ToolDetailFetchState; error?: string }) {
  const tr = useT();
  if (state === 'loading') {
    return (
      <div data-testid="tool-detail-loading" className="mt-1 flex items-center gap-1.5 text-mini text-app-text-muted">
        <Loader2 size={11} className="animate-spin" />
        <span>{tr('chat.tool.detailLoading')}</span>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div data-testid="tool-detail-error" className="mt-1 text-mini text-red-500">
        {tr('chat.tool.detailFailed')}
        {error ? <span className="ml-1 font-mono opacity-80">({error})</span> : null}
      </div>
    );
  }
  return null;
}
