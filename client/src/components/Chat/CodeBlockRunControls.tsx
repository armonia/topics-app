/**
 * What a runnable code block draws (CHAT-RUN-01, CHAT-RUN-02): Run and Open in
 * terminal in its header, or why Run is not there, and the strip that asks a
 * second time before a command that deletes, forces or has a placeholder.
 * The state lives in `useCommandRun`.
 */
import { useEffect, useRef } from 'react';
import { EyeOff, Play, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { RiskReason } from './commandRisk';
import type { useCommandRun } from './useCommandRun';

/** Run and Open in terminal, beside Copy. */
export function RunButtons({ runner }: { runner: ReturnType<typeof useCommandRun> }) {
  const tr = useT();
  if (!runner.command) return null;
  return (
    <>
      {runner.risk?.block ? (
        <span className="text-mini text-amber-300/90 inline-flex items-center gap-1 px-1" title={tr('code.hiddenCharsTitle')} data-testid="code-run-blocked">
          <EyeOff size={10} /> {tr('code.hiddenChars')}
        </span>
      ) : runner.run?.status !== 'running' && (
        <button
          type="button"
          onClick={runner.requestRun}
          disabled={runner.starting}
          title={tr('code.runTitle')}
          data-testid="code-run"
          className="text-emerald-300/90 hover:text-emerald-200 rounded px-1.5 py-0.5 text-mini flex items-center justify-center gap-1 min-h-6 transition-colors disabled:opacity-50"
        >
          <Play size={10} /> {tr('code.run')}
        </button>
      )}
      <button
        type="button"
        onClick={runner.openTerminal}
        aria-label={tr('code.openInTerminal')}
        title={tr('code.openInTerminalTitle')}
        data-testid="code-open-terminal"
        className="text-gray-400 hover:text-gray-200 rounded px-1.5 py-0.5 inline-flex items-center justify-center min-w-6 min-h-6 transition-colors"
      >
        <SquareTerminal size={11} />
      </button>
    </>
  );
}

/** The strip that takes the header's place before a command that deletes, forces, or has a placeholder. */
export function RunConfirmStrip({ reasons, onRun, onCancel }: { reasons: RiskReason[]; onRun: () => void; onCancel: () => void }) {
  const tr = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const destructive = reasons.filter((r) => r.kind !== 'placeholder').map((r) => r.text);
  const placeholders = reasons.filter((r) => r.kind === 'placeholder').map((r) => r.text);
  const list = (items: string[]) => items.map((t) => `\u201c${t}\u201d`).join(', ');
  // The amber tint sits on the code block's own dark ground: on the light theme
  // the page behind is white, and a translucent tint over it lost the text.
  return (
    <div className="bg-app-code-bg rounded-t-md">
    <div
      role="group"
      data-testid="command-run-confirm"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      className="flex flex-wrap items-center justify-between gap-2 bg-amber-500/15 rounded-t-md px-2.5 py-1 border-b border-amber-400/20 text-mini text-amber-100"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <TriangleAlert size={12} className="shrink-0 text-amber-300" />
        <span className="min-w-0">
          {destructive.length > 0 && <span className="block">{tr('code.confirm.destructive', { list: list(destructive) })}</span>}
          {placeholders.length > 0 && <span className="block">{tr('code.confirm.placeholder', { list: list(placeholders) })}</span>}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onRun} data-testid="command-run-confirm-run" className="rounded px-2 py-0.5 min-h-6 text-mini font-medium bg-amber-500/25 hover:bg-amber-500/40 text-amber-50 transition-colors">
          {tr('code.confirm.runAnyway')}
        </button>
        <button type="button" ref={cancelRef} onClick={onCancel} data-testid="command-run-confirm-cancel" className="rounded px-2 py-0.5 min-h-6 text-mini text-gray-200 hover:bg-white/10 transition-colors">
          {tr('code.confirm.cancel')}
        </button>
      </div>
    </div>
    </div>
  );
}

