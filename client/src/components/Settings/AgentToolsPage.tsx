import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, Sparkles, SquareTerminal, Trash2, Unplug } from 'lucide-react';
import { ICON_BUTTON, ROW, TEXT_BUTTON } from '../Sidebar/menuRowStyles';
import { PALLINO_ATTESA, PALLINO_OK } from '../Sidebar/chromeSignals';
import { useT } from '../../hooks/useT';
import { agentToolsApi, mcpApi, type AgentToolsInventory } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';
import { openUserMenu } from '../../lib/openUserMenu';

const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_WAIT_MS = 120_000;

type Mcp = AgentToolsInventory['mcp'][number];

/**
 * ONE PAGE FOR EVERYTHING THE AGENTS CAN REACH: MCP servers (active, parked,
 * waiting for a sign-in, failed, each with the reason), the skills found on
 * disk, the agent CLIs, and where the machines live. It reads the same
 * inventory an agent gets from `topics tools`, so the screen and the agents
 * never describe two different worlds.
 */
export function AgentToolsPage() {
  const t = useT();
  const [inv, setInv] = useState<AgentToolsInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [extra, setExtra] = useState({ mcp: '', skills: '' });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await agentToolsApi.inventory(signal);
      if (!signal?.aborted) { setInv(next); setError(null); }
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  // Names waiting for the browser sign-in to finish: the server mounts them
  // only at the OAuth callback, so the page keeps asking until it happens.
  const [waiting, setWaiting] = useState<string[]>([]);
  useEffect(() => {
    if (waiting.length === 0) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > SIGN_IN_WAIT_MS) { setWaiting([]); return; }
      void load();
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting.length, load]);
  useEffect(() => {
    if (!inv || waiting.length === 0) return;
    const still = waiting.filter((n) => inv.mcp.find((m) => m.name === n)?.state === 'needs-auth');
    if (still.length !== waiting.length) setWaiting(still);
  }, [inv, waiting]);

  const authorize = (m: Mcp) => run(m.name, async () => {
    const { authorizeUrl } = await mcpApi.startOauth(m.name);
    openExternalOnce(authorizeUrl);
    setWaiting((w) => (w.includes(m.name) ? w : [...w, m.name]));
  });

  const removeSource = (kind: 'mcp' | 'skills', label: string) => {
    if (!inv) return;
    const rest = inv.sources.filter((s) => s.kind === kind && s.extra && s.label !== label).map((s) => s.label);
    void run(`remove-${kind}`, () => agentToolsApi.configure(kind === 'mcp' ? { extraMcpFiles: rest } : { extraSkillDirs: rest }));
  };

  const addSource = (kind: 'mcp' | 'skills') => {
    const value = extra[kind].trim();
    if (!value || !inv) return;
    const current = inv.sources.filter((s) => s.kind === kind && s.extra).map((s) => s.label);
    void run(`add-${kind}`, async () => {
      await agentToolsApi.configure(kind === 'mcp' ? { extraMcpFiles: [...current, value] } : { extraSkillDirs: [...current, value] });
      setExtra((e) => ({ ...e, [kind]: '' }));
    });
  };

  if (error && !inv) return <p data-testid="agent-tools-error" className="px-3 py-2 text-mini text-app-text-muted">{t('agentTools.error', { message: error })}</p>;
  if (!inv) return <p data-testid="agent-tools-loading" className="px-3 py-2 text-mini text-app-text-muted">{t('agentTools.loading')}</p>;

  const heading = 'flex items-center gap-2 px-3 pt-2 pb-0.5 text-mini font-medium text-app-text-muted';
  const hint = 'px-3 py-1 text-mini text-app-text-muted';
  const link = 'text-app-text underline hover:text-primary';
  // Secondary actions show on hover or focus; on touch they are always there.
  const reveal = 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100';
  const dot = (state: string) => (state === 'active' ? PALLINO_OK : state === 'needs-auth' ? PALLINO_ATTESA : state === 'failed' ? 'bg-red-600 dark:bg-red-400' : 'bg-app-text-muted/40');

  return (
    <div data-testid="agent-tools-page" className="pb-1">
      <div className={heading}>
        <span className="min-w-0 flex-1 truncate">{t('agentTools.mcp')}</span>
        <button type="button" data-testid="agent-tools-refresh" className={ICON_BUTTON} disabled={busy !== null} aria-label={t('agentTools.refresh')} title={t('agentTools.refresh')} onClick={() => void run('refresh', () => mcpApi.refresh())}>
          <RefreshCw size={12} />
        </button>
      </div>
      {inv.mcp.length === 0 && <p className={hint}>{t('agentTools.none')}</p>}
      <ul>
        {inv.mcp.map((m) => (
          <li key={m.name} data-testid={`agent-tools-mcp-${m.name}`} data-state={m.state} className={`group ${ROW}`}>
            <Plug size={12} className="flex-shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-app-text">{m.name}</span>
              <span className="block truncate text-app-text-muted">
                {m.source} · {t('agentTools.toolCount', { n: m.toolCount })}{m.reason ? ` · ${m.reason}` : ''}
              </span>
            </span>
            <span data-testid={`agent-tools-mcp-${m.name}-state`} className="flex-shrink-0 text-app-text-muted">{t(`agentTools.state.${m.state}`)}</span>
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot(m.state)}`} />
            {m.state === 'needs-auth' && (
              <button type="button" className={`${TEXT_BUTTON} text-app-text hover:bg-app-hover disabled:opacity-50`} disabled={busy === m.name} onClick={() => void authorize(m)}>{t('agentTools.authorize')}</button>
            )}
            {m.state === 'parked' && m.parkedByUser && (
              <button type="button" className={`${ICON_BUTTON} ${reveal}`} disabled={busy === m.name} aria-label={t('agentTools.mount')} title={t('agentTools.mount')} onClick={() => void run(m.name, () => agentToolsApi.configure({ mount: m.name }))}>
                <Plug size={12} />
              </button>
            )}
            {m.state !== 'parked' && (
              <button type="button" className={`${ICON_BUTTON} ${reveal}`} disabled={busy === m.name} aria-label={t('agentTools.disconnect')} title={t('agentTools.disconnect')} onClick={() => void run(m.name, () => agentToolsApi.configure({ park: m.name }))}>
                <Unplug size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className={`${heading} border-t border-app-border mt-1`}>{t('agentTools.skills')}</div>
      {inv.skills.length === 0 && <p className={hint}>{t('agentTools.none')}</p>}
      <ul>
        {inv.skills.map((s) => (
          <li key={s.name} data-testid={`agent-tools-skill-${s.name}`} className={ROW}>
            <Sparkles size={12} className="flex-shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-app-text">{s.name}</span>
              <span className="block truncate text-app-text-muted">{s.description || s.source}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className={`${heading} border-t border-app-border mt-1`}>{t('agentTools.clis')}</div>
      <ul>
        {inv.clis.map((c) => (
          <li key={c.id} data-testid={`agent-tools-cli-${c.id}`} data-installed={c.installed ? 'true' : 'false'} className={ROW}>
            <SquareTerminal size={12} className="flex-shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1 truncate text-app-text">{c.name}</span>
            <span className="flex-shrink-0 text-app-text-muted">{c.installed ? t('agentTools.installed') : t('agentTools.missing')}</span>
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${c.installed ? PALLINO_OK : 'bg-app-text-muted/40'}`} />
          </li>
        ))}
      </ul>

      <div className={`${heading} border-t border-app-border mt-1`}>{t('agentTools.machines')}</div>
      <p className={hint}>
        {t('agentTools.machinesHint')}{' '}
        <button type="button" data-testid="agent-tools-open-devices" className={link} onClick={() => openUserMenu('devices')}>{t('home.machines')}</button>
      </p>

      <div className={`${heading} border-t border-app-border mt-1`}>{t('agentTools.automations')}</div>
      <p className={hint}>
        {t('agentTools.automationsHint')}{' '}
        <button type="button" data-testid="agent-tools-open-automations" className={link} onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'automations' } }))}>{t('automations.open')}</button>
      </p>

      <div className={`${heading} border-t border-app-border mt-1`}>{t('agentTools.sources')}</div>
      <ul>
        {inv.sources.map((s) => (
          <li key={`${s.kind}:${s.label}`} className={`group ${ROW} text-app-text-muted`}>
            <span className="min-w-0 flex-1 truncate">
              {s.label}{!s.found ? ` · ${t('agentTools.sourceMissing')}` : ''}{s.extra ? ` · ${t('agentTools.sourceExtra')}` : ''}
            </span>
            {s.extra && (
              <button type="button" data-testid="agent-tools-remove-source" className={`${ICON_BUTTON} ${reveal}`} aria-label={t('agentTools.removeSource')} title={t('agentTools.removeSource')} onClick={() => removeSource(s.kind, s.label)}>
                <Trash2 size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {(['mcp', 'skills'] as const).map((kind) => (
        <form key={kind} className={`${ROW} pt-1`} onSubmit={(e) => { e.preventDefault(); addSource(kind); }}>
          <input
            data-testid={`agent-tools-add-${kind}-input`}
            value={extra[kind]}
            onChange={(e) => setExtra((x) => ({ ...x, [kind]: e.target.value }))}
            placeholder={t('agentTools.pathPlaceholder')}
            className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-mini text-app-text outline-none focus:border-primary coarse:text-compact"
          />
          <button type="submit" className={`${TEXT_BUTTON} text-app-text hover:bg-app-hover`}>{t(kind === 'mcp' ? 'agentTools.addMcp' : 'agentTools.addSkills')}</button>
        </form>
      ))}
    </div>
  );
}
