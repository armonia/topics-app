import type { ReactNode } from 'react';

/**
 * The ONE "the agent is working" row, shared by the chat transcript and the
 * task drawer (card 045ef721). Left: the glyph, the phrase and, when a tool is
 * running, "Esegue: <tool>". The numbers (timer, tokens, rate) are children and
 * only appear on hover: a "0.0 tok/s" while a tool works reads like a fault.
 * Vertical padding is 8px on both sides, always, so the two surfaces cannot
 * drift apart again.
 */
export function TurnLoader({
  icon,
  phrase,
  phraseClassName = 'font-medium',
  tool,
  runningLabel,
  children,
  testId = 'chat-streaming-indicator',
  className = '',
  ...rest
}: {
  icon: ReactNode;
  phrase: ReactNode;
  phraseClassName?: string;
  /** Short description of the tool running now, or null. */
  tool?: string | null;
  /** Already-translated "Running:" prefix. */
  runningLabel?: string;
  /** The numbers: shown only while the row is hovered or focused. */
  children?: ReactNode;
  testId?: string;
  className?: string;
} & Partial<Record<`data-${string}` | `aria-${string}` | 'role', string | undefined>>) {
  return (
    <div
      data-testid={testId}
      data-turn-loader="true"
      className={`group flex items-center gap-2 py-2 text-mini leading-none select-none ${className}`}
      {...rest}
    >
      {icon}
      <span className={phraseClassName} data-testid="turn-phrase">{phrase}</span>
      {tool && (
        <span className="min-w-0 truncate text-app-text-muted" data-testid="turn-running-tool" title={tool}>
          {runningLabel ?? 'Esegue:'} {tool}
        </span>
      )}
      {children && (
        <span
          data-testid="turn-loader-numbers"
          className="ml-auto flex shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {children}
        </span>
      )}
    </div>
  );
}
