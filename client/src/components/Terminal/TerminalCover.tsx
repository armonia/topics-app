import type { Ref } from 'react';
import { SkeletonRows } from '../Shared/Skeleton';
import type { TerminalScreenCopy } from '../../lib/terminalScrollbackCache';

/** xterm's row height at this font size with JetBrains Mono, for a copy
 *  written before the row height was kept with it. */
const DEFAULT_ROW_PX = 17;

/**
 * What a terminal pane shows over xterm until xterm has drawn the replay: the
 * last screen this device kept (`terminalScrollbackCache`), or with none the
 * skeleton. Never an empty pane (TABSWITCH-02).
 *
 * The copy has the same metrics as xterm's DOM renderer, its lines at the row
 * height they were written at, and is pinned to the bottom of xterm's rows, the
 * way a terminal reads: the replay lands on top of it without anything moving.
 * The pane is taller than its whole rows by a remainder, so the box is the pane
 * rounded down to whole rows, not the pane (a 6 px jump when pinned to the
 * pane's bottom, tab-switch audit 2026-09-30); where `round()` is not supported
 * the declaration is dropped and the box is the pane. Once xterm opens, the pane
 * sets the box to xterm's real rows height through `ref`.
 *
 * A `div`, not a `pre`: the unlayered `pre:not(.tool-card-code)` rule of
 * index.css (the markdown code block) beats every utility, and made the copy a
 * padded, tinted box in the flow, 6 px below the rows' top.
 */
export function TerminalCover({ copy, ref }: { copy: TerminalScreenCopy | null; ref?: Ref<HTMLDivElement> }) {
  if (!copy) {
    return (
      <div data-testid="terminal-skeleton" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <SkeletonRows count={6} rowClassName="flex h-[17px] items-center px-2" glyph={0} />
      </div>
    );
  }
  const rowPx = copy.rowPx ?? DEFAULT_ROW_PX;
  return (
    <div
      ref={ref}
      data-testid="terminal-text"
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 bottom-0 flex flex-col justify-end px-[1px] overflow-hidden whitespace-pre text-prose text-app-text-muted"
      style={{
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
        lineHeight: `${rowPx}px`,
        height: `round(down, 100%, ${rowPx}px)`,
      }}
    >
      {copy.text}
    </div>
  );
}
