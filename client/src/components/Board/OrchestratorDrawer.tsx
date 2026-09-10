/**
 * THE KANBAN COORDINATOR, INSIDE THE KANBAN.
 *
 * The toolbar entry used to promote the conversation to a permanent pane: you
 * left the board to talk about the board, and looking at a column the answer
 * mentioned meant switching tabs. This is the shell that keeps it where it is
 * useful — the same slot the task preview opens in: an in-flow sibling of the
 * columns on a desktop, a full-screen overlay on a phone.
 *
 * The shell draws only the frame (command row, width, dismissal): the BODY
 * comes from whoever hosts the board, because a real chat needs the
 * message-store handles that live up there and that a board pane does not
 * have. See `KanbanBoardPane`'s `orchestrator` prop.
 *
 * NO ESCAPE-TO-CLOSE, and that is not an oversight: there is a composer in
 * here. The task drawer closes on Escape because there Escape has no other
 * job; in a chat it is the key that dismisses a popover or abandons a line,
 * and claiming it would make the conversation vanish for someone who was only
 * closing a menu. It closes with the X, or by pressing the toolbar entry
 * again — that entry is a toggle.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, Music4, SquareArrowOutUpRight, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { Topic } from '../../types';

/** The same key shape the task drawer uses (`board:taskDetailWide`): two
 *  drawers, two memories, so widening the chat does not widen the review. */
const WIDE_KEY = 'board:orchestratorWide';

const readWide = () => {
  try { return localStorage.getItem(WIDE_KEY) === '1'; } catch { return false; }
};

interface Props {
  topic: Topic;
  /** Closes the drawer. The conversation stays alive on the server. */
  onClose: () => void;
  /** Promotes the same conversation to a permanent tab. */
  onPopOut: () => void;
  /** The real chat, mounted by whoever hosts the board. */
  children: ReactNode;
}

export function OrchestratorDrawer({ topic, onClose, onPopOut, children }: Props) {
  const tr = useT();
  const [wide, setWide] = useState(readWide);
  const toggleWide = useCallback(() => {
    setWide((v) => {
      const next = !v;
      try { localStorage.setItem(WIDE_KEY, next ? '1' : '0'); } catch { /* private mode: the width stays local to this session */ }
      return next;
    });
  }, []);

  return (
    <div
      data-testid="board-orchestrator-drawer"
      // The task drawer's geometry (TaskDetail): below lg a full-screen
      // overlay above the board's own topbar (z-40), from lg up an in-flow
      // SIBLING that shrinks the columns instead of covering them — so every
      // column stays reachable through the row's own horizontal scroll.
      className={`pane-frost flex min-h-0 flex-col border-app-border absolute inset-0 z-40 w-full lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l ${
        wide ? 'lg:w-[min(64rem,72%)] lg:shadow-2xl' : 'lg:w-96 lg:max-w-[75%]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <Music4 className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs text-app-text-heading">{topic.name}</span>
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-app-text-secondary">
            {tr('topic.orchestrator.badge')}
          </span>
        </div>
        <button
          type="button"
          data-testid="board-orchestrator-popout"
          onClick={onPopOut}
          title={tr('board.orchestrator.popOut')}
          aria-label={tr('board.orchestrator.popOut')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-app-text-secondary hover:bg-white/10 hover:text-app-text"
        ><SquareArrowOutUpRight className="h-3.5 w-3.5" /></button>
        <button
          type="button"
          data-testid="board-orchestrator-wide-toggle"
          aria-pressed={wide}
          onClick={toggleWide}
          title={wide ? tr('task.drawer.narrow') : tr('task.drawer.widen')}
          aria-label={wide ? tr('task.drawer.narrow') : tr('task.drawer.widen')}
          className="hidden h-6 w-6 shrink-0 place-items-center rounded text-app-text-secondary hover:bg-white/10 hover:text-app-text lg:grid"
        >{wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
        <button
          type="button"
          data-testid="board-orchestrator-close"
          onClick={onClose}
          title={tr('common.close')}
          aria-label={tr('common.close')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-app-text-secondary hover:bg-white/10 hover:text-app-text"
        ><X className="h-3.5 w-3.5" /></button>
      </div>
      {/* `min-h-0` on both levels: without it the message list grows past the
          drawer and the scroll lands on the board underneath. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
