import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, LogIn, Plug, RefreshCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { mcpApi, type McpFleetStatus, type McpServerStatus } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';

/**
 * How often the panel re-reads the fleet while a sign-in is open, and for how
 * long it keeps doing it.
 *
 * The window matches the loopback listener's own five minutes: polling past the
 * moment the server stopped listening would be asking a question that can no
 * longer change its answer. Two seconds between reads is cheap because a
 * mounted fleet answers `GET /api/mcp/fleet` from memory.
 */
const AUTH_POLL_MS = 2_000;
const AUTH_POLL_WINDOW_MS = 5 * 60 * 1000;

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

  /**
   * The server whose sign-in tab is open right now, if any.
   *
   * One at a time on purpose: it is the name the poll below watches, and a
   * person signing into two servers at once is not a thing worth the extra
   * state. Clicking the button again clears it, which is how somebody who gave
   * up (closed the tab, changed their mind) gets the row back.
   */
  const [connecting, setConnecting] = useState<string | null>(null);

  const connect = useCallback(async (name: string) => {
    try {
      const { authorizeUrl } = await mcpApi.startOauth(name);
      // Through the shell bridge, never `window.open`: inside the desktop
      // shell's webview a plain `_blank` is a no-op, so the person would click
      // Connect and watch nothing at all happen.
      openExternalOnce(authorizeUrl);
      setConnecting(name);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * While a sign-in is open, ask the fleet whether that server came back.
   *
   * The server does the actual work: when the callback lands it re-mounts the
   * fleet, so this poll is only how the screen finds out. It stops the moment
   * the server leaves `needs-auth`, whichever way it went, because a sign-in
   * that ends in `failed` is still an answer and leaving the spinner running
   * would be the panel lying about what it knows.
   */
  useEffect(() => {
    if (!connecting) return;
    const ctrl = new AbortController();
    const giveUpAt = Date.now() + AUTH_POLL_WINDOW_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const next = await mcpApi.fleet(ctrl.signal);
        if (stopped) return;
        setStatus(next);
        const server = next.servers.find((s) => s.name === connecting);
        if (server && server.state !== 'needs-auth') { setConnecting(null); return; }
      } catch {
        // A failed poll is a poll. The next one may well answer, and the
        // sign-in itself is happening somewhere this fetch cannot see.
      }
      if (stopped) return;
      if (Date.now() >= giveUpAt) { setConnecting(null); return; }
      timer = setTimeout(() => { void tick(); }, AUTH_POLL_MS);
    };

    timer = setTimeout(() => { void tick(); }, AUTH_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); ctrl.abort(); };
  }, [connecting]);

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
              connecting={connecting === server.name}
              onConnect={() => {
                if (connecting === server.name) setConnecting(null);
                else void connect(server.name);
              }}
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
 *  doing its job, not a fault, and painting it like one sends people hunting.
 *  `needs-auth` is amber for the same reason and one more: red would say the
 *  server is broken, when the only thing missing is a sign-in nobody has done
 *  yet, and the row carries the button that does it. */
const STATE_TONE: Record<McpServerStatus['state'], string> = {
  ready: 'text-emerald-400 border-emerald-400/30',
  failed: 'text-red-500 border-red-500/30',
  excluded: 'text-app-text-muted border-app-border',
  'needs-auth': 'text-amber-400 border-amber-400/30',
};

function McpServerRow({
  server, expanded, onToggle, connecting, onConnect,
}: {
  server: McpServerStatus;
  expanded: boolean;
  onToggle: () => void;
  /** A sign-in tab for THIS server is open and the panel is watching for it. */
  connecting: boolean;
  onConnect: () => void;
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

      {/* THE ROW CARRIES ITS OWN CURE. A server waiting for a sign-in is the one
          state on this panel a person can resolve from here, so the button
          lives next to the reason instead of in a settings page somewhere else.
          While the tab is open the same button cancels: the sign-in happens in
          another window and it can simply never come back. */}
      {server.state === 'needs-auth' && (
        <button
          data-testid={`mcp-server-connect-${server.name}`}
          onClick={onConnect}
          // `coarse:min-h-11` like every other target in this panel: the touch
          // rule keys off the POINTER, so on desktop it stays compact.
          className="mt-1.5 flex items-center gap-1 rounded-md border border-amber-400/30 bg-surface px-2 py-1 text-[11px] text-amber-400 hover:bg-app-hover coarse:min-h-11 coarse:px-3"
        >
          <LogIn size={11} className={connecting ? 'animate-pulse' : undefined} />
          {connecting ? t('mcp.connectWaiting') : t('mcp.connect')}
        </button>
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
