import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { agentToolsApi, mcpApi, type AgentToolsInventory } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';
import { openUserMenu } from '../../lib/openUserMenu';

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

  const authorize = (m: Mcp) => run(m.name, async () => {
    const { authorizeUrl } = await mcpApi.startOauth(m.name);
    openExternalOnce(authorizeUrl);
  });

  const addSource = (kind: 'mcp' | 'skills') => {
    const value = extra[kind].trim();
    if (!value || !inv) return;
    const current = inv.sources.filter((s) => s.kind === kind && s.extra).map((s) => s.label);
    void run(`add-${kind}`, async () => {
      await agentToolsApi.configure(kind === 'mcp' ? { extraMcpFiles: [...current, value] } : { extraSkillDirs: [...current, value] });
      setExtra((e) => ({ ...e, [kind]: '' }));
    });
  };

  if (error && !inv) return <p data-testid="agent-tools-error" className="p-3 text-small text-app-text-secondary">{t('agentTools.error', { message: error })}</p>;
  if (!inv) return <p data-testid="agent-tools-loading" className="p-3 text-small text-app-text-secondary">{t('agentTools.loading')}</p>;

  const btn = 'rounded-md border border-app-border px-2 py-0.5 text-mini hover:bg-app-hover disabled:opacity-50';
  const heading = 'px-3 pt-3 pb-1 text-mini font-medium uppercase tracking-wide text-app-text-tertiary';

  return (
    <div data-testid="agent-tools-page" className="pb-2 text-small">
      <div className="flex items-center justify-between pr-3">
        <h3 className={heading}>{t('agentTools.mcp')}</h3>
        <button type="button" data-testid="agent-tools-refresh" className={btn} disabled={busy !== null} onClick={() => void run('refresh', () => mcpApi.refresh())}>
          <RefreshCw size={11} className="mr-1 inline" />{t('agentTools.refresh')}
        </button>
      </div>
      {inv.mcp.length === 0 && <p className="px-3 text-app-text-tertiary">{t('agentTools.none')}</p>}
      <ul>
        {inv.mcp.map((m) => (
          <li key={m.name} data-testid={`agent-tools-mcp-${m.name}`} data-state={m.state} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
              <span data-testid={`agent-tools-mcp-${m.name}-state`} className="text-mini text-app-text-secondary">{t(`agentTools.state.${m.state}`)}</span>
              {m.state === 'needs-auth' && (
                <button type="button" className={btn} disabled={busy === m.name} onClick={() => void authorize(m)}>{t('agentTools.authorize')}</button>
              )}
              {m.state === 'parked' && m.parkedByUser && (
                <button type="button" className={btn} disabled={busy === m.name} onClick={() => void run(m.name, () => agentToolsApi.configure({ mount: m.name }))}>{t('agentTools.mount')}</button>
              )}
              {m.state !== 'parked' && (
                <button type="button" className={btn} disabled={busy === m.name} onClick={() => void run(m.name, () => agentToolsApi.configure({ park: m.name }))}>{t('agentTools.disconnect')}</button>
              )}
            </div>
            <div className="truncate text-mini text-app-text-tertiary">
              {m.source} · {t('agentTools.toolCount', { n: m.toolCount })}{m.reason ? ` · ${m.reason}` : ''}
            </div>
          </li>
        ))}
      </ul>

      <h3 className={heading}>{t('agentTools.skills')}</h3>
      {inv.skills.length === 0 && <p className="px-3 text-app-text-tertiary">{t('agentTools.none')}</p>}
      <ul>
        {inv.skills.map((s) => (
          <li key={s.name} data-testid={`agent-tools-skill-${s.name}`} className="px-3 py-1">
            <div className="truncate font-medium">{s.name}</div>
            <div className="truncate text-mini text-app-text-tertiary">{s.description || s.source}</div>
          </li>
        ))}
      </ul>

      <h3 className={heading}>{t('agentTools.clis')}</h3>
      <ul>
        {inv.clis.map((c) => (
          <li key={c.id} data-testid={`agent-tools-cli-${c.id}`} data-installed={c.installed ? 'true' : 'false'} className="flex items-center gap-2 px-3 py-1">
            <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
            <span className="text-mini text-app-text-secondary">{c.installed ? t('agentTools.installed') : t('agentTools.missing')}</span>
          </li>
        ))}
      </ul>

      <h3 className={heading}>{t('agentTools.machines')}</h3>
      <p className="px-3 text-app-text-tertiary">
        {t('agentTools.machinesHint')}{' '}
        <button type="button" data-testid="agent-tools-open-devices" className="underline" onClick={() => openUserMenu('devices')}>{t('home.machines')}</button>
      </p>

      <h3 className={heading}>{t('agentTools.sources')}</h3>
      <ul className="px-3 text-mini text-app-text-tertiary">
        {inv.sources.map((s) => (
          <li key={`${s.kind}:${s.label}`} className="truncate">
            {s.label}{!s.found ? ` · ${t('agentTools.sourceMissing')}` : ''}{s.extra ? ` · ${t('agentTools.sourceExtra')}` : ''}
          </li>
        ))}
      </ul>
      {(['mcp', 'skills'] as const).map((kind) => (
        <form key={kind} className="flex gap-2 px-3 pt-2" onSubmit={(e) => { e.preventDefault(); addSource(kind); }}>
          <input
            data-testid={`agent-tools-add-${kind}-input`}
            value={extra[kind]}
            onChange={(e) => setExtra((x) => ({ ...x, [kind]: e.target.value }))}
            placeholder={t('agentTools.pathPlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-app-border bg-transparent px-2 py-1 text-mini"
          />
          <button type="submit" className={btn}>{t(kind === 'mcp' ? 'agentTools.addMcp' : 'agentTools.addSkills')}</button>
        </form>
      ))}
    </div>
  );
}
