/**
 * REGISTRO: the tail of the channel engine's log, filterable by agent and
 * level. The lines live in the engine's own file and are read again every few
 * seconds, so a reload of the page loses nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { startVisibleInterval } from '../../state/documentVisibility';
import { useAgentRegistry } from '../../state/agentRegistry';
import { Select } from '../Shared/Select';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';

const POLL_MS = 5_000;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

interface Tail { path: string; exists: boolean; lines: { time: string | null; level: string; agent: string | null; chat: string | null; text: string }[] }

export function SystemLog() {
  const tr = useT();
  const { reg } = useAgentRegistry();
  const [agent, setAgent] = useState('');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('info');
  const [tail, setTail] = useState<Tail | null>(null);
  const load = useCallback(async () => {
    const query = new URLSearchParams({ level, ...(agent ? { agent } : {}) });
    const body = await readJson(`/api/system/engine-log?${query}`, { cache: 'no-store' }) as Tail | null;
    if (body) setTail(body);
  }, [agent, level]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the read starts on mount; the state is set when the fetch resolves
    void load();
    return startVisibleInterval(() => { void load(); }, POLL_MS);
  }, [load]);
  return (
    <section data-testid="system-log" className="max-w-4xl space-y-3">
      <h2 className="text-body font-semibold text-app-text">{tr('system.log.title')}</h2>
      <div className="flex flex-wrap gap-2">
        <Select
          testId="log-agent"
          value={agent}
          onChange={setAgent}
          ariaLabel={tr('system.log.agent')}
          options={[{ value: '', label: tr('system.log.allAgents') }, ...(reg?.agents ?? []).map((a) => ({ value: a.id, label: a.name || a.id }))]}
        />
        <Select
          testId="log-level"
          value={level}
          onChange={setLevel}
          ariaLabel={tr('system.log.level')}
          options={LEVELS.map((l) => ({ value: l, label: tr(`system.log.level.${l}`) }))}
        />
      </div>
      {tail === null ? <p className="text-prose text-app-text-muted">{tr('system.reading')}</p> : !tail.exists ? (
        <p data-testid="log-missing" className="text-prose text-app-text-secondary">{tr('system.log.missing', { path: tail.path })}</p>
      ) : tail.lines.length === 0 ? (
        <p className="text-prose text-app-text-muted">{tr('system.log.empty')}</p>
      ) : (
        <ol data-testid="log-lines" className="max-h-[60vh] overflow-auto rounded border border-app-border p-2 font-mono text-mini">
          {tail.lines.map((l, i) => (
            <li key={i} data-level={l.level} className={`flex flex-wrap gap-x-2 break-words ${l.level === 'error' ? DANGER_TEXT : l.level === 'warn' ? WARNING_TEXT : 'text-app-text-secondary'}`}>
              <span data-testid="log-time" className="tabular-nums text-app-text-muted">{l.time ? l.time.slice(11) : ''}</span>
              <span data-testid="log-agent-name" className="font-medium">{(l.agent && reg?.agents.find((a) => a.id === l.agent)?.name) || l.agent || ''}</span>
              <span data-testid="log-chat">{l.chat ?? ''}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
