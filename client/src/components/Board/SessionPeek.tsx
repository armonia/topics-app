import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DISPATCH_CHIP, type LiveUsage } from './constants';
import { fmtLive, fmtTok, fmtUsd, liveToolLabel } from './format';
import { boardApi, type TaskSessionPeek } from '../../lib/board';
import { useLocale, useT } from '../../hooks/useT';
import { POPOVER_PANEL } from '../../lib/popoverStyles';
import { useExitGhost } from '../../lib/exitGhost';

interface SessionPeekProps {
  taskId: string;
  open: boolean;
  live?: LiveUsage;
  layout?: 'floating' | 'menu';
  anchor?: HTMLElement | null;
}

interface Position {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function SessionPeek({ taskId, open, live, layout = 'floating', anchor }: SessionPeekProps) {
  const tr = useT();
  const locale = useLocale();
  const [peek, setPeek] = useState<TaskSessionPeek | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () => {
      setNow(Date.now());
      void boardApi.sessionPeek(taskId).then((next) => { if (alive) setPeek(next); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1200);
    return () => { alive = false; clearInterval(timer); };
  }, [open, taskId]);

  useLayoutEffect(() => {
    if (!open || layout !== 'floating' || !anchor) return;
    const place = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(rect.width, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const height = Math.min(panel.scrollHeight, 220, window.innerHeight - margin * 2);
      const below = Math.max(0, window.innerHeight - rect.bottom - margin);
      const above = Math.max(0, rect.top - margin);
      let top: number;
      let maxHeight: number;
      if (below >= height) {
        top = rect.bottom + margin;
        maxHeight = below;
      } else if (above >= height) {
        top = rect.top - margin - height;
        maxHeight = above;
      } else if (below >= above) {
        top = rect.bottom + margin;
        maxHeight = below;
      } else {
        maxHeight = above;
        top = Math.max(margin, rect.top - margin - maxHeight);
      }
      const next = { left, top, width, maxHeight };
      setPosition((previous) => previous && Object.keys(next).every((key) => previous[key as keyof Position] === next[key as keyof Position]) ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    const panel = panelRef.current;
    if (panel) observer.observe(panel);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, layout, anchor, taskId, peek, live]);

  // The floating card enters and leaves like every popover (MOTION-04); inside the menu it is a row.
  useExitGhost(panelRef, open && layout === 'floating');
  if (!open) return null;
  const age = peek?.since && now !== null ? fmtLive(now - Date.parse(peek.since)) : null;
  const cost = fmtUsd(peek?.costCents, locale);
  const stateKey = peek ? DISPATCH_CHIP[peek.state]?.textKey : null;
  const content = (
    <aside
      ref={panelRef}
      data-testid="task-session-peek"
      data-session-peek-anchor={layout === 'floating' ? taskId : undefined}
      className={layout === 'menu'
        ? 'mb-2 rounded-md border border-app-border bg-surface p-2.5 text-compact leading-4 shadow-xl'
        : `${POPOVER_PANEL} fixed z-50 p-2.5 text-compact leading-4`}
      style={layout === 'floating' ? {
        left: position?.left ?? 8,
        top: position?.top ?? 8,
        width: position?.width ?? 220,
        maxHeight: position?.maxHeight ?? 'calc(100vh - 16px)',
        overflowY: 'auto',
        visibility: position ? 'visible' : 'hidden',
      } : undefined}
    >
      <div className="flex items-center gap-2 font-medium text-app-text-heading">
        <span>{stateKey ? tr(stateKey) : peek ? tr('board.sessionPeek.stateUnknown') : tr('board.sessionPeek.loading')}</span>
        {age && <span className="text-app-text-muted">{tr('board.sessionPeek.duration', { age })}</span>}
        {cost && <span className="ml-auto text-app-text-muted">{cost}</span>}
        {peek?.tokens != null && <span className="text-app-text-muted">{fmtTok(peek.tokens)} {tr('board.sessionPeek.tokens')}</span>}
      </div>
      {(live?.lastTool || peek?.tool) && <p data-testid="task-session-peek-tool" className="mt-1 truncate text-app-text-muted">{live?.lastTool ? liveToolLabel(live.lastTool) : peek?.tool}</p>}
      {peek?.lines.map((line, index) => <p key={`${index}-${line}`} data-testid="task-session-peek-line" className="mt-1 break-words text-app-text">{line}</p>)}
      {!peek?.lines.length && <p className="mt-1 text-app-text-muted">{tr('board.sessionPeek.noMessage')}</p>}
    </aside>
  );
  return layout === 'menu' ? content : createPortal(content, document.body);
}
