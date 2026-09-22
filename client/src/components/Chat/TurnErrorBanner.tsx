import { useMemo, useState } from 'react';
import { TriangleAlert, Copy, Check } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { copyText } from '../../lib/clipboard';
import { readableVerdict } from './errorVerdict';

/**
 * The turn's verdict, as an element of its OWN.
 *
 * It used to be the whole bubble's container that turned yellow, and with it
 * the prose, the tool history, the media. A successful turn that trips at the
 * end got framed whole, as if all of it were wrong, and the text explaining
 * why was not even visible. Here the error line sits on top and that is all:
 * what the turn produced sits below it, rendered as always.
 *
 * IT LIVES IN ITS OWN FILE since the payload fold arrived: the banner is now a
 * component with state (the copy confirmation) and a test of its own, and
 * `MessageContent` is already a file nobody wants to open.
 */
export function TurnErrorBanner({ text }: { text: string }) {
  const tr = useT();
  const { headline, details, truncated } = useMemo(() => readableVerdict(text), [text]);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!details) return;
    if (await copyText(details)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      data-testid="turn-error"
      className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2.5 py-1.5 text-compact leading-snug text-amber-900 dark:text-amber-200"
    >
      <span aria-hidden className="flex-shrink-0 leading-snug"><TriangleAlert className="w-4 h-4" /></span>
      <div className="min-w-0 flex-1">
        <span className="break-words">{headline}</span>
        {details && (
          // `<details>` and not a button with state: the fold is closed on its
          // own, it opens with the keyboard, and the browser prints it open.
          <details data-testid="turn-error-details" className="mt-1">
            <summary className="cursor-pointer select-none text-mini opacity-80 hover:opacity-100">
              {/* A payload stored cut off says so: what is in the fold is not
                  the whole thing the provider sent, and a reader about to
                  paste it into a bug report needs to know that. */}
              {tr(truncated ? 'chat.turnError.detailsTruncated' : 'chat.turnError.details')}
            </summary>
            <div className="mt-1 flex items-start gap-1.5">
              <pre className="min-w-0 flex-1 overflow-auto max-h-40 rounded bg-amber-500/10 px-2 py-1.5 text-mini font-mono whitespace-pre-wrap break-words">{details}</pre>
              <button
                type="button"
                onClick={copy}
                title={tr('chat.turnError.copy')}
                aria-label={tr('chat.turnError.copy')}
                className="flex-shrink-0 rounded p-1 hover:bg-amber-500/20"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
