import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Plug, RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { mcpApi, type McpFleetStatus, type McpServerStatus } from '../../lib/api';

/**
 * WHAT IS MOUNTED RIGHT NOW, and why the rest is not.
 *
 * THE SILENCE THIS REPLACES. A globally configured MCP server can be absent for
 * four different reasons: an inheritance rule dropped it, it is on the deny
 * list, its handshake failed, or the native MCP client is switched off. Until
 * this panel existed the only trace of any of that was one line printed on the
 * server's stdout at boot, which nobody reads. A missing tool was
 * indistinguishable from a bug, and people went looking in the wrong place.
 * So the REASON is the point of the card, not a detail at the bottom of it.
 *
 * IT READS ONCE, WHEN IT IS ON SCREEN. The panel is mounted only while the
 * "AI Providers" section is the selected one (see `GlobalSettings.tsx`), so
 * mounting IS being visible and one fetch on mount is the whole subscription.
 * There is no interval: the fleet changes when a person edits their global
 * config, which is not something to poll for, and `GET /api/mcp/fleet` mounts
 * the fleet on read, so a poll would be a handshake storm rather than a cheap
 * question. When somebody does change that config, the answer is the button.
 */
export function McpFleetPanel() {
  const t = useT();
  const [status, setStatus] = useState<McpFleetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    mcpApi
      .fleet(ctrl.signal)
      .then((s) => { if (!ctrl.signal.aborted) { setStatus(s); setError(null); } })
      .catch((e: unknown) => {
        // An aborted fetch is this component unmounting, not a failure to report.
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, []);

  const recheck = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await mcpApi.refresh());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const servers = status?.servers ?? [];

  return (
    <div
      data-testid="mcp-fleet-panel"
      className="mb-3 rounded-lg border border-app-border bg-surface/40 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <Plug size={13} className="flex-shrink-0 text-app-text-muted" />
        <span className="flex-1 text-[12.5px] font-medium text-app-text">{t('mcp.title')}</span>
        <button
          data-testid="mcp-fleet-refresh"
          onClick={() => { void recheck(); }}
          disabled={refreshing}
          // `coarse:min-h-11` like every other target in this panel: under a
          // finger this button measured 26.5px tall against the 44px required
          // — found by the nightly (run 33040071985), its only red out of 245.
          // The `coarse` variant keys off the POINTER, not the screen width,
          // so on desktop the button stays as compact as it has always been
          // and only grows where there is an actual finger.
          className="flex flex-shrink-0 items-center gap-1 rounded-md border border-app-border bg-surface px-2 py-1 text-[11px] hover:bg-app-hover disabled:opacity-50 coarse:min-h-11 coarse:px-3"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : undefined} />
          {refreshing ? t('mcp.rechecking') : t('mcp.recheck')}
        </button>
      </div>

      <p className="mt-1 break-words text-[11px] text-app-text-muted">{t('mcp.blurb')}</p>

      {error && (
        <div data-testid="mcp-fleet-error" className="mt-1.5 flex items-start gap-2 text-[11px] text-red-500">
          <AlertCircle size={12} className="mt-px flex-shrink-0" />
          <span className="flex-1 break-words">{t('mcp.error')} {error}</span>
        </div>
      )}

      {/* The three ways the list can legitimately be empty, told apart. Rolling
          them into one "nothing here" would answer "is it broken?" with a
          shrug: off, still connecting and nothing configured are three
          different situations with three different next moves. */}
      {!error && status === null && (
        <div className="mt-1.5 text-[11px] text-app-text-muted">{t('mcp.loading')}</div>
      )}
      {status && !status.enabled && (
        <div data-testid="mcp-fleet-off" className="mt-1.5 break-words text-[11px] text-app-text-muted">
          {t('mcp.off')}
        </div>
      )}
      {status?.enabled && status.mounting && servers.length === 0 && (
        <div data-testid="mcp-fleet-mounting" className="mt-1.5 text-[11px] text-app-text-muted">
          {t('mcp.mounting')}
        </div>
      )}
      {status?.enabled && !status.mounting && servers.length === 0 && (
        <div data-testid="mcp-fleet-empty" className="mt-1.5 break-words text-[11px] text-app-text-muted">
          {t('mcp.empty')}
        </div>
      )}

      {servers.length > 0 && (
        <div data-testid="mcp-fleet-servers" className="mt-2 space-y-1">
          {servers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              expanded={expanded === server.name}
              onToggle={() => setExpanded(expanded === server.name ? null : server.name)}
            />
          ))}
        </div>
      )}

      {/* Which file the answer came from. It is the difference between "no
          servers" and "no servers IN THE CONFIG THIS PROCESS READ", which are
          the same sentence until you are looking at the wrong home directory. */}
      {status?.source && (
        <p data-testid="mcp-fleet-source" className="mt-1.5 break-all text-[10.5px] text-app-text-muted">
          {t('mcp.source', { path: status.source })}
        </p>
      )}
    </div>
  );
}

/** The colour of the state chip. Excluded is deliberately NOT red: it is a rule
 *  doing its job, not a fault, and painting it like one sends people hunting. */
const STATE_TONE: Record<McpServerStatus['state'], string> = {
  ready: 'text-emerald-400 border-emerald-400/30',
  failed: 'text-red-500 border-red-500/30',
  excluded: 'text-app-text-muted border-app-border',
};

function McpServerRow({
  server, expanded, onToggle,
}: {
  server: McpServerStatus;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const toolCount = server.tools.length;
  const skillCount = server.skills.length;
  const canExpand = toolCount > 0;
  const toolsLabel = toolCount === 0
    ? t('mcp.tools.none')
    : toolCount === 1 ? t('mcp.tools.one') : t('mcp.tools.many', { n: toolCount });

  return (
    <div
      data-testid={`mcp-server-${server.name}`}
      data-state={server.state}
      data-transport={server.transport ?? ''}
      data-tool-count={toolCount}
      className="rounded-md border border-app-border bg-surface/60 px-2 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11.5px] text-app-text">{server.name}</span>
        <span className={`rounded border px-1 py-px text-[10px] ${STATE_TONE[server.state]}`}>
          {t(`mcp.state.${server.state}`)}
        </span>
        {server.transport && (
          <span className="rounded border border-app-border px-1 py-px font-mono text-[10px] text-app-text-muted">
            {server.transport}
          </span>
        )}
        <span className="text-[11px] text-app-text-muted">{toolsLabel}</span>
        {skillCount > 0 && (
          <span data-testid={`mcp-server-skills-${server.name}`} className="text-[11px] text-app-text-muted">
            · {skillCount === 1 ? t('mcp.skills.one') : t('mcp.skills.many', { n: skillCount })}
          </span>
        )}
      </div>

      {/* WHY IT IS NOT HERE, in the person's own language of cause: the
          inheritance rule that dropped it, or the error the handshake returned.
          Never folded away behind the expander, because a server nobody can see
          the reason for is the whole defect this panel was built to close. */}
      {server.reason && (
        <p data-testid={`mcp-server-reason-${server.name}`} className="mt-1 break-words text-[11px] text-app-text-muted">
          {server.reason}
        </p>
      )}

      {/* The tools ARE reachable without a console, and still not shouted: a
          server with forty of them would otherwise bury the other rows. */}
      {canExpand && (
        <button
          data-testid={`mcp-server-toggle-${server.name}`}
          onClick={onToggle}
          aria-expanded={expanded}
          className="mt-1 flex items-center gap-1 text-[11px] text-app-text-muted hover:text-app-text"
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {expanded ? t('mcp.hideTools') : t('mcp.showTools')}
        </button>
      )}
      {canExpand && expanded && (
        <ul data-testid={`mcp-server-tools-${server.name}`} className="mt-1 space-y-px">
          {server.tools.map((tool) => (
            <li key={tool} className="break-all font-mono text-[10.5px] text-app-text-muted">
              {tool}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
