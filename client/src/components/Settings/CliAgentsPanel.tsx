import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { providersApi, type CliAgentPresence } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { useT } from '../../hooks/useT';

/**
 * THE AGENT CLIs, and the way out when the probe is wrong.
 *
 * Topics does not bundle the CLIs: it runs the ones already installed, and to
 * run one it has to know where it is. It looks in the places the vendors
 * document, and that list cannot be complete: a custom npm prefix, a version
 * manager, a portable copy on another volume. Whoever installed Codex somewhere
 * else opened Settings, read that it was not there, and had nothing to press
 * (card 38d9f64b). Nothing above this block could contradict the probe, because
 * the probe was the only thing that spoke.
 *
 * So the block says both halves of the answer. For what is there: where it is,
 * one line, no action needed. For what is missing: the install command, ready to
 * copy, AND the field for the case where the answer is "it IS installed, it just
 * lives elsewhere". The second is one click away instead of visible from the
 * start, because the common case is the first one, and a text field asking for a
 * path is the kind of thing that makes a person think they have to fill it in.
 */
export function CliAgentsPanel() {
  const t = useT();
  const [agents, setAgents] = useState<CliAgentPresence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A promise chain rather than an awaited call inside the effect: the mounted
  // component must not set state after it is gone, and this is the shape the
  // rest of the pane already uses (`McpFleetPanel`).
  const load = useCallback(() => {
    providersApi
      .cliAgents()
      .then((res) => { setAgents(res.agents); setError(null); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('ai.local.loadFailed'));
      });
  }, [t]);

  useEffect(() => {
    const ctrl = new AbortController();
    providersApi
      .cliAgents()
      .then((res) => { if (!ctrl.signal.aborted) { setAgents(res.agents); setError(null); } })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('ai.local.loadFailed'));
      });
    return () => ctrl.abort();
  }, [t]);

  if (error && !agents) {
    return (
      <div className="flex items-center gap-2 text-compact text-red-500">
        <AlertCircle size={12} className="flex-shrink-0" />
        <span className="flex-1 break-words">{error}</span>
        <button
          onClick={load}
          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-mini bg-surface border border-app-border hover:bg-app-hover coarse:min-h-11 coarse:px-3"
        >
          <RefreshCw size={11} />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="cli-agents-panel">
      <h3 className="text-prose font-medium text-app-text mb-1">{t('ai.local.title')}</h3>
      <p className="text-mini text-app-text-muted mb-3">
        {t('ai.local.hint')}
      </p>
      <div className="space-y-1.5">
        {agents?.map((agent) => (
          <CliAgentRow key={agent.id} agent={agent} onChanged={setAgents} />
        ))}
        {agents === null && <div className="text-compact text-app-text-muted">{t('common.loading')}</div>}
      </div>
    </div>
  );
}

function CliAgentRow({
  agent,
  onChanged,
}: {
  agent: CliAgentPresence;
  onChanged: (agents: CliAgentPresence[]) => void;
}) {
  const t = useT();
  // The field opens by itself when a manual path is already there and no longer
  // resolves: that is the one state a person has to act on, and hiding the field
  // behind a click would hide the only control that fixes it.
  const [editing, setEditing] = useState(agent.manualPathBroken);
  const [value, setValue] = useState(agent.manualPath ?? '');
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (path: string | null) => {
    setSaving(true);
    setRowError(null);
    try {
      const res = await providersApi.configureCliAgent(agent.id, path);
      onChanged(res.agents);
      setEditing(false);
    } catch (err) {
      // The server's refusal is already a sentence for a person ("There is
      // nothing at that path."), so it is shown as it arrives.
      setRowError(err instanceof Error ? err.message : t('ai.local.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const copyInstall = async () => {
    await copyText(agent.install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isCommand = !agent.install.startsWith('http');

  return (
    <div className="rounded-md border border-app-border bg-surface px-2.5 py-2" data-testid={`cli-agent-${agent.id}`}>
      <div className="flex items-center gap-2">
        <span
          className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${agent.installed ? 'bg-emerald-500' : 'bg-app-text-muted/40'}`}
        />
        <span className="text-compact text-app-text flex-1 truncate">{agent.name}</span>
        {agent.installed ? (
          <span className="text-micro text-app-text-muted font-mono truncate max-w-[45%]" title={agent.path ?? ''}>
            {agent.path}
          </span>
        ) : (
          <span className="text-micro text-app-text-muted">{t('ai.local.notFound')}</span>
        )}
        {!agent.installed && (
          <a
            href={agent.url}
            target="_blank"
            rel="noreferrer"
            className="flex-shrink-0 p-1 rounded-md hover:bg-app-hover text-app-text-muted coarse:h-11 coarse:w-11 coarse:flex coarse:items-center coarse:justify-center"
            title={agent.url}
          >
            <ExternalLink size={11} />
          </a>
        )}
        <button
          data-testid="cli-agent-path-toggle"
          onClick={() => setEditing((v) => !v)}
          className="flex-shrink-0 px-2 py-1 rounded-md text-mini bg-app-bg border border-app-border hover:bg-app-hover coarse:min-h-11 coarse:px-3"
        >
          {t(agent.manualPath ? 'ai.local.changePath' : 'ai.local.setPath')}
        </button>
      </div>

      {/* The install command sits under a CLI that is missing, and only there:
          for one already installed it would be an instruction to redo something
          that is done. */}
      {!agent.installed && isCommand && (
        <div className="mt-1.5 flex items-center gap-2">
          <code className="flex-1 text-micro font-mono text-app-text-muted bg-app-bg rounded px-1.5 py-1 truncate">
            {agent.install}
          </code>
          <button
            onClick={() => { void copyInstall(); }}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-micro bg-app-bg border border-app-border hover:bg-app-hover coarse:min-h-11 coarse:px-3"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {t(copied ? 'ai.local.copied' : 'ai.local.copy')}
          </button>
        </div>
      )}

      {agent.manualPathBroken && (
        <div className="mt-1.5 flex items-center gap-1.5 text-micro text-amber-500">
          <AlertCircle size={10} className="flex-shrink-0" />
          <span className="break-all">{t('ai.local.missingPath', { path: agent.manualPath ?? '' })}</span>
        </div>
      )}

      {editing && (
        <div className="mt-1.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              data-testid="cli-agent-path-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !saving) void submit(value); }}
              placeholder="/opt/homebrew/bin/codex"
              spellCheck={false}
              className="flex-1 min-w-0 text-mini font-mono bg-app-bg border border-app-border rounded-md px-2 py-1 outline-none focus:border-app-accent coarse:min-h-11"
            />
            <button
              data-testid="cli-agent-path-save"
              onClick={() => { void submit(value); }}
              disabled={saving || value.trim() === ''}
              className="flex-shrink-0 px-2 py-1 rounded-md text-mini bg-app-accent text-white disabled:opacity-50 coarse:min-h-11 coarse:px-3"
            >
              {t('common.save')}
            </button>
            {agent.manualPath && (
              <button
                onClick={() => { void submit(null); }}
                disabled={saving}
                className="flex-shrink-0 px-2 py-1 rounded-md text-mini bg-app-bg border border-app-border hover:bg-app-hover disabled:opacity-50 coarse:min-h-11 coarse:px-3"
              >
                {t('ai.local.clearPath')}
              </button>
            )}
          </div>
          <p className="text-micro text-app-text-muted">
            {t('ai.local.pathHint', { command: `which ${agent.bin}` })}
          </p>
          {rowError && (
            <div className="flex items-center gap-1.5 text-micro text-red-500" data-testid="cli-agent-path-error">
              <AlertCircle size={10} className="flex-shrink-0" />
              <span className="break-words">{rowError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
