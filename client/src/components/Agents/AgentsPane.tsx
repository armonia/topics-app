/**
 * AGENTI: the always-on agents' sessions grouped by agent (Jarvis, Visione,
 * any other always-on agent), each with its state, its last activity and how
 * many sessions it holds; sub-agents sit under the session that spawned them.
 * A session opens as from the sidebar. The grouping is `lib/agentSessions`.
 */
import { useMemo, useState } from 'react';
import { Bot, ChevronRight, SquareTerminal, TriangleAlert } from 'lucide-react';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { useLocale, useT } from '../../hooks/useT';
import { useAgentGroups, useChannelTitles } from '../../state/agentGroups';
import { agentSessionName } from '../../lib/agentSessions';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { useSharedNow } from '../../state/useSharedNow';
import type { AgentSession, AgentSessionState, AgentTerminal } from '../../lib/agentSessions';
import { PALLINO_ATTESA, SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import { STATUS_DOT, STATUS_INK } from '../../lib/statusVisual';
import { AgentProfiles } from './AgentProfiles';
import { useAgentRegistry } from '../../state/agentRegistry';

type Tr = ReturnType<typeof useT>;

const DOT: Record<AgentSessionState, string> = { working: STATUS_DOT.working, waiting: PALLINO_ATTESA, idle: 'bg-app-border-light' };
const TEXT: Record<AgentSessionState, string> = { working: STATUS_INK.working, waiting: SEGNALE_ATTESA, idle: 'text-app-text-muted' };

function openSession(id: string) {
  window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: id, mode: 'permanent', reveal: true } }));
}

function openTerminal(id: string, name: string) {
  window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: id, name } }));
}

function useAgo() {
  const locale = useLocale();
  const now = useSharedNow();
  return useMemo(() => {
    const fmt = new Intl.RelativeTimeFormat(locale === 'en' ? 'en-GB' : 'it-IT', { numeric: 'auto' });
    return (at: number) => {
      const min = Math.round((at - now) / 60_000);
      if (Math.abs(min) < 60) return fmt.format(min, 'minute');
      const h = Math.round(min / 60);
      if (Math.abs(h) < 24) return fmt.format(h, 'hour');
      return fmt.format(Math.round(h / 24), 'day');
    };
  }, [locale, now]);
}

function SessionRow({ s, depth, tr, ago, name }: { s: AgentSession; depth: number; tr: Tr; ago: (at: number) => string; name: (raw: string, key?: string | null) => string }) {
  return (
    <>
      <li>
        <button
          type="button"
          data-testid="agents-session"
          onClick={() => openSession(s.topic.id)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-app-hover"
          style={{ paddingLeft: 8 + depth * 18 }}
        >
          {s.error
            ? <TriangleAlert size={12} className={`flex-shrink-0 ${DANGER_TEXT}`} aria-hidden="true" />
            : <span className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT[s.state]}`} aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate text-prose text-app-text">{name(s.topic.name, s.topic.sessionKey)}</span>
          {s.error && <span data-testid="agents-session-error" className={`flex-shrink-0 text-mini ${DANGER_TEXT}`}>{tr('agents.error')}</span>}
          {s.state !== 'idle' && <span className={`flex-shrink-0 text-mini ${TEXT[s.state]}`}>{tr(`agents.state.${s.state}`)}</span>}
          <span className="flex-shrink-0 text-mini tabular-nums text-app-text-muted">{ago(s.lastActivity)}</span>
          <ChevronRight size={12} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />
        </button>
      </li>
      {s.children.map((c) => <SessionRow key={c.topic.id} s={c} depth={depth + 1} tr={tr} ago={ago} name={name} />)}
      {s.terminals.map((t) => <TerminalRow key={t.terminal.id} t={t} depth={depth + 1} tr={tr} ago={ago} />)}
    </>
  );
}

/** A sub-agent running in a terminal (the CLI): it opens as a terminal pane. */
function TerminalRow({ t, depth, tr, ago }: { t: AgentTerminal; depth: number; tr: Tr; ago: (at: number) => string }) {
  const { id, name, type } = t.terminal;
  return (
    <>
      <li>
        <button
          type="button"
          data-testid="agents-terminal"
          onClick={() => openTerminal(id, name)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-app-hover"
          style={{ paddingLeft: 8 + depth * 18 }}
        >
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT[t.state]}`} aria-hidden="true" />
          {type === 'claude-code'
            ? <ClaudeIcon size={12} className="flex-shrink-0 text-app-text-secondary" />
            : <SquareTerminal size={12} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate text-prose text-app-text">{name}</span>
          {t.state !== 'idle' && <span className={`flex-shrink-0 text-mini ${TEXT[t.state]}`}>{tr(`agents.state.${t.state}`)}</span>}
          <span className="flex-shrink-0 text-mini tabular-nums text-app-text-muted">{ago(t.lastActivity)}</span>
          <ChevronRight size={12} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />
        </button>
      </li>
      {t.children.map((c) => <TerminalRow key={c.terminal.id} t={c} depth={depth + 1} tr={tr} ago={ago} />)}
    </>
  );
}

/** Sessions shown per agent before «show more»: every agent's header stays in sight. */
const VISIBLE = 6;

export function AgentsPane() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const tr = useT();
  const ago = useAgo();
  const groups = useAgentGroups();
  const titles = useChannelTitles();
  const { reg, load } = useAgentRegistry();
  const cli = tr('agents.cli');
  const name = (raw: string, key?: string | null) => agentSessionName(raw, titles, cli, key);
  return (
    <div data-testid="agents-pane" className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <h1 className="text-title font-semibold text-app-text">{tr('agents.title')}</h1>
        <p className="mt-1 text-prose text-app-text-secondary">{tr('agents.lede')}</p>
        {reg && reg.agents.length > 0 && <AgentProfiles reg={reg} reload={load} />}
        {reg && reg.agents.length > 0 && groups.length > 0 && <h2 className="mt-8 text-body-lg font-semibold text-app-text">{tr('agents.sessionsTitle')}</h2>}
        {groups.length === 0 && !(reg && reg.agents.length > 0) && <p className="mt-6 text-prose text-app-text-muted">{tr('agents.empty')}</p>}
        {groups.map((g) => (
          <section key={g.id} data-testid="agents-group" className="mt-6 rounded-lg border border-app-border-light">
            <header className="flex items-center gap-2 border-b border-app-border-light px-3 py-2">
              <Bot size={16} className="text-app-text-secondary" aria-hidden="true" />
              <h2 className="text-body-lg font-semibold text-app-text">{g.name}</h2>
              <span data-testid="agents-group-counts" className="flex items-center gap-2 text-mini">
                {g.waiting > 0 && (
                  <span className={`flex items-center gap-1 ${SEGNALE_ATTESA}`}>
                    <span className={`h-2 w-2 rounded-full ${PALLINO_ATTESA}`} aria-hidden="true" />
                    {tr('agents.waitingYou', { n: g.waiting })}
                  </span>
                )}
                {g.working > 0 && (
                  <span className={`flex items-center gap-1 ${STATUS_INK.working}`}>
                    <span className={`h-2 w-2 rounded-full ${STATUS_DOT.working}`} aria-hidden="true" />
                    {tr('agents.working', { n: g.working })}
                  </span>
                )}
                {g.errors > 0 && (
                  <span className={`flex items-center gap-1 ${DANGER_TEXT}`}>
                    <TriangleAlert size={11} aria-hidden="true" />
                    {tr('agents.errors', { n: g.errors })}
                  </span>
                )}
                {g.waiting === 0 && g.working === 0 && g.errors === 0 && <span className="text-app-text-muted">{tr('agents.state.idle')}</span>}
              </span>
              <span className="ml-auto text-mini tabular-nums text-app-text-muted">
                {g.total === 1 ? tr('agents.sessionsOne') : tr('agents.sessions', { n: g.total })}
                {' · '}
                {tr('agents.last', { when: ago(g.lastActivity) })}
              </span>
            </header>
            <ul className="p-1">
              {(open.has(g.id) ? g.sessions : g.sessions.slice(0, VISIBLE)).map((s) => <SessionRow key={s.topic.id} s={s} depth={0} tr={tr} ago={ago} name={name} />)}
              {g.terminals.map((t) => <TerminalRow key={t.terminal.id} t={t} depth={0} tr={tr} ago={ago} />)}
              {!open.has(g.id) && g.sessions.length > VISIBLE && (
                <li>
                  <button
                    type="button"
                    data-testid="agents-more"
                    onClick={() => setOpen((o) => new Set(o).add(g.id))}
                    className="w-full rounded px-2 py-1.5 text-left text-mini text-app-text-secondary hover:bg-app-hover"
                  >
                    {tr('agents.more', { n: g.sessions.length - VISIBLE })}
                  </button>
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
