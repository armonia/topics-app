import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronsDown, History, SquareTerminal } from 'lucide-react';
import { SuggestionMenu } from '../Shared/SuggestionMenu';
import { Spinner } from '../Shared/Spinner';
import { topicsApi, type ResumableSession } from '../../lib/api';
import { errMessage } from '../../lib/errMessage';
import { useConfirm } from '../../hooks/useConfirm';
import { useLocale, useT } from '../../hooks/useT';
import { useToast } from '../Shared/Toast';

/**
 * THE LIST OF `/resume` (CMDUI-03): the Claude Code sessions of this chat's
 * project that no chat of Topics holds, newest first, twenty at a time.
 * Choosing one adopts it as a chat that CONTINUES the same session: the next
 * turn starts the CLI with `--resume` and that id.
 *
 * The same shell as the «/» menu and the @mention (`SuggestionMenu`), held to
 * the composer: whoever filters is typing in the field, and under 768 px a
 * `Menu` becomes a sheet whose scrim covers that field. The words after
 * `/resume ` filter on title and branch of the rows already loaded.
 *
 * The keyboard is taken from the field while the list is open (arrows, Enter,
 * Tab, Escape), in the capture of the field itself, so the composer's own
 * Enter never sends `/resume` as a message.
 */
type Row = { kind: 'session'; session: ResumableSession } | { kind: 'more' };

export function ResumePicker({ topicId, filter, inputRef, isMobile, onClose, onAdopted }: {
  topicId: string;
  filter: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isMobile: boolean;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [sessions, setSessions] = useState<ResumableSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [adopting, setAdopting] = useState<string | null>(null);
  // While the dialog asks, a press on it is not a press outside the list:
  // cancelling leaves the list where it was.
  const [asking, setAsking] = useState(false);

  const loadPage = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const page = await topicsApi.resumableSessions(topicId, before);
      setSessions((prev) => (before ? [...prev, ...page.sessions] : page.sessions));
      setMore(page.more);
      setCursor(page.cursor);
      setFailed(null);
    } catch (e) {
      setFailed(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => { void loadPage(null); }, [loadPage]);

  const rows = useMemo((): Row[] => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: ResumableSession) => {
      const hay = `${s.title ?? ''} ${s.branch ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    const list: Row[] = sessions.filter(match).map((session) => ({ kind: 'session', session }));
    if (more) list.push({ kind: 'more' });
    return list;
  }, [sessions, filter, more]);

  useEffect(() => { setSelected((i) => Math.min(i, Math.max(0, rows.length - 1))); }, [rows.length]);

  const choose = useCallback(async (row: Row | undefined) => {
    if (!row || adopting) return;
    if (row.kind === 'more') { if (!loading) void loadPage(cursor); return; }
    const s = row.session;
    // Two processes writing one session fork it: a session still running in a
    // terminal is continued here only if the person says so.
    if (s.active) {
      setAsking(true);
      let go = false;
      try {
        go = await confirm({
          title: tr('chat.resume.activeTitle'),
          body: tr('chat.resume.activeBody'),
          confirmLabel: tr('chat.resume.activeConfirm'),
        });
      } finally {
        setAsking(false);
      }
      if (!go) { inputRef.current?.focus(); return; }
    }
    setAdopting(s.sessionId);
    try {
      const topic = await topicsApi.adoptClaudeSession({ sessionId: s.sessionId, transcriptPath: s.transcriptPath, ...(s.title ? { name: s.title } : {}) });
      window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: topic.id, topic, mode: 'permanent', reveal: true } }));
      onAdopted();
    } catch (e) {
      toast.error(tr('chat.resume.failed', { reason: errMessage(e) }));
    } finally {
      setAdopting(null);
    }
  }, [adopting, loading, loadPage, cursor, confirm, tr, toast, onAdopted, inputRef]);

  // The keys of the field while the list is open.
  useEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = rows.length || 1;
        setSelected((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n));
      } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        void choose(rows[selected]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    field.addEventListener('keydown', onKey);
    return () => field.removeEventListener('keydown', onKey);
  }, [inputRef, rows, selected, choose, onClose]);

  const when = (ms: number) => {
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
      : d.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  return (
    <SuggestionMenu<Row>
      visible
      items={rows}
      getKey={(r) => (r.kind === 'more' ? '__more' : r.session.sessionId)}
      selectedIndex={selected}
      onClose={onClose}
      holdOpen={asking}
      inputRef={inputRef}
      headerIcon={<History size={12} className="text-app-text-secondary" />}
      headerLabel={tr('chat.resume.header')}
      filterBadge={filter.trim() || undefined}
      hint={isMobile ? '' : tr('chat.slash.hint')}
      listboxLabel={tr('chat.resume.header')}
      loading={loading && sessions.length === 0}
      loadingLabel={tr('chat.resume.loading')}
      emptyLabel={failed ? tr('chat.resume.failed', { reason: failed }) : tr('chat.resume.empty')}
      maxHeightClass={isMobile ? 'max-h-[50vh]' : 'max-h-80'}
      testId="resume-picker"
      renderItem={(row, idx, { selected: on }) => {
        const base = `w-full px-3 ${isMobile ? 'min-h-[44px]' : ''} py-1.5 text-left flex items-center gap-2.5 transition-colors ${on ? 'bg-primary/10' : 'hover:bg-app-hover'}`;
        if (row.kind === 'more') {
          return (
            <button type="button" role="option" aria-selected={on} data-testid="resume-load-more" className={base}
              onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSelected(idx)} onClick={() => void choose(row)}>
              {loading ? <Spinner size="sm" /> : <ChevronsDown size={14} className="text-app-text-muted shrink-0" />}
              <span className="text-compact text-app-text-secondary">{tr('chat.resume.loadMore')}</span>
            </button>
          );
        }
        const s = row.session;
        return (
          <button type="button" role="option" aria-selected={on} data-testid="resume-row" data-session-id={s.sessionId} data-active={s.active ? 'true' : undefined}
            className={base} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSelected(idx)} onClick={() => void choose(row)}>
            {adopting === s.sessionId ? <Spinner size="sm" /> : <SquareTerminal size={14} className="text-app-text-muted shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span data-testid="resume-row-title" className="text-compact text-app-text truncate">{s.title ?? tr('chat.resume.untitled')}</span>
                <span className="ml-auto text-micro text-app-text-tertiary tabular-nums shrink-0">{when(s.lastActivityAt)}</span>
              </span>
              <span className="flex items-center gap-2 text-micro text-app-text-muted">
                {s.branch && <span className="font-mono truncate">{s.branch}</span>}
                {s.active && <span data-testid="resume-row-active" className="text-emerald-600 dark:text-emerald-400 shrink-0">{tr('chat.resume.activeNow')}</span>}
                {adopting === s.sessionId && <span className="shrink-0">{tr('chat.resume.adopting')}</span>}
              </span>
            </span>
          </button>
        );
      }}
    />
  );
}
