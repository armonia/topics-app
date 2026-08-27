import { useEffect, useState } from 'react';
import { AlertCircle, FileCog, Plug, Terminal, ShieldCheck, Webhook } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { sessionEnvironmentApi, type SessionEnvironment, type SessionEnvSource } from '../../lib/api';

/**
 * WHAT THIS CHAT INHERITED, on screen.
 *
 * Topics does not reimplement hooks, skills, commands or permission rules: it
 * spawns the real CLI with the user's setting sources, so everything written
 * under their home folder and under the project is already in force. What was
 * missing was the place to LOOK at it: the app inherited a whole environment
 * and showed none of it, so "why did that hook fire" and "where did that tool
 * go" were answered by opening four files by hand.
 *
 * EVERY ROW SAYS WHERE IT COMES FROM. The list itself is the easy half; the
 * question people actually have is which of the settings files won, so the
 * source is a chip on the row and never a detail hidden behind a click.
 *
 * READ-ONLY, AND IT SAYS SO. Editing someone's global configuration from here
 * is a separate decision with a different blast radius. Showing it is already
 * the answer to the failure this replaces.
 *
 * IT FETCHES ON MOUNT, ONCE. The parent mounts this only while the section is
 * open (a closed `<details>` hides its children, it does not unmount them), so
 * mounting IS being visible. Those files change when a person edits them, which
 * is not something to poll for.
 */
export function SessionEnvironmentPanel({ topicId }: { topicId: string }) {
  const t = useT();
  const [env, setEnv] = useState<SessionEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    sessionEnvironmentApi
      .get(topicId, ctrl.signal)
      .then((e) => { if (!ctrl.signal.aborted) { setEnv(e); setError(null); } })
      .catch((e: unknown) => {
        // An aborted fetch is this panel closing, not a failure to report.
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [topicId]);

  if (error) {
    return (
      <div data-testid="session-env-error" className="flex items-start gap-2 px-4 py-2 text-[11px] text-red-500">
        <AlertCircle size={12} className="mt-px flex-shrink-0" />
        <span className="flex-1 break-words">{t('sessionEnv.error')} {error}</span>
      </div>
    );
  }
  if (!env) {
    return <div data-testid="session-env-loading" className="px-4 py-2 text-[11px] text-app-text-muted">{t('sessionEnv.loading')}</div>;
  }
  if (!env.inherits) {
    // A runtime that does not read those files must say so. Showing an empty
    // list would read as "you have nothing configured", which is a different
    // and false statement.
    return (
      <div data-testid="session-env-no-inherit" className="px-4 py-2 text-[11px] text-app-text-muted">
        {t('sessionEnv.noInherit', { provider: env.provider ?? '' })}
      </div>
    );
  }

  const hookEvents = [...new Set(env.hooks.map((h) => h.event))];

  return (
    <div data-testid="session-env" className="px-4 pb-3 pt-1 space-y-3">
      <p className="break-words text-[11px] text-app-text-muted">{t('sessionEnv.blurb')}</p>

      <Section icon={<Plug size={11} />} title={t('sessionEnv.section.mcp')} count={env.mcp.servers.length}>
        {env.mcp.policy === 'bridge-only' && (
          <Note testId="session-env-mcp-policy">{t('sessionEnv.policy.bridgeOnly')}</Note>
        )}
        {env.mcp.servers.length === 0 && <Note>{t('sessionEnv.empty.mcp')}</Note>}
        {env.mcp.servers.map((s) => (
          <Row key={s.name} testId={`session-env-mcp-${s.name}`} state={s.state}>
            <span className="font-mono text-[11.5px] text-app-text">{s.name}</span>
            <Chip tone={s.state === 'mounted' ? 'ok' : 'muted'}>{t(`sessionEnv.state.${s.state}`)}</Chip>
            {s.origin === 'bridge' && <Chip>{t('sessionEnv.origin.bridge')}</Chip>}
            {s.transport && <Chip mono>{s.transport}</Chip>}
            {s.detail && <Detail>{s.detail}</Detail>}
            {s.reason && <Detail muted>{s.reason}</Detail>}
          </Row>
        ))}
      </Section>

      <Section icon={<Webhook size={11} />} title={t('sessionEnv.section.hooks')} count={env.hooks.length}>
        {env.hooks.length === 0 && <Note>{t('sessionEnv.empty.hooks')}</Note>}
        {/* Grouped by event because that is the axis on which a hook fires:
            "what runs before a tool" is one question, "what runs on stop" is
            another, and a flat list makes both of them a scan. */}
        {hookEvents.map((event) => (
          <div key={event} data-testid={`session-env-hook-event-${event}`}>
            <div className="pb-0.5 pt-1 font-mono text-[10.5px] text-app-text-tertiary">{event}</div>
            {env.hooks.filter((h) => h.event === event).map((h, i) => (
              <Row key={`${h.file}-${h.command}-${i}`} testId={`session-env-hook-${event}-${i}`}>
                {h.matcher && <Chip mono>{h.matcher}</Chip>}
                <SourceChip source={h.source} file={h.file} />
                <Detail>{h.command}</Detail>
              </Row>
            ))}
          </div>
        ))}
      </Section>

      <Section icon={<Terminal size={11} />} title={t('sessionEnv.section.commands')} count={env.commands.length}>
        {env.commands.length === 0 && <Note>{t('sessionEnv.empty.commands')}</Note>}
        {env.commands.map((c) => (
          <Row key={`${c.kind}-${c.name}`} testId={`session-env-command-${c.name}`}>
            <span className="font-mono text-[11.5px] text-app-text" title={c.file}>/{c.name}</span>
            <Chip>{t(`sessionEnv.kind.${c.kind}`)}</Chip>
            {c.description && <Detail muted>{c.description}</Detail>}
          </Row>
        ))}
      </Section>

      <Section icon={<ShieldCheck size={11} />} title={t('sessionEnv.section.permissions')} count={env.permissions.rules.length}>
        {env.permissions.mode && (
          <Note testId="session-env-permission-mode">{t('sessionEnv.mode', { mode: env.permissions.mode })}</Note>
        )}
        {env.permissions.rules.length === 0 && <Note>{t('sessionEnv.empty.permissions')}</Note>}
        {env.permissions.rules.map((r, i) => (
          <Row key={`${r.effect}-${r.rule}-${i}`} testId={`session-env-rule-${i}`}>
            <Chip tone={r.effect === 'deny' ? 'deny' : r.effect === 'allow' ? 'ok' : 'muted'}>
              {t(`sessionEnv.effect.${r.effect}`)}
            </Chip>
            <span className="font-mono text-[11px] text-app-text">{r.rule}</span>
            <SourceChip source={r.source} file={r.file} />
          </Row>
        ))}
      </Section>

      {/* The files themselves, present or not. It is the difference between
          "nothing is configured" and "nothing is configured IN THE FILES THIS
          SESSION READ", which are the same sentence until the working directory
          is not the one you assumed. */}
      <Section icon={<FileCog size={11} />} title={t('sessionEnv.section.files')} count={env.settingsFiles.length}>
        {env.settingsFiles.map((f) => (
          <Row key={f.path} testId={`session-env-file-${f.source}`} state={f.exists ? undefined : 'excluded'}>
            <SourceChip source={f.source} />
            <span className="break-all font-mono text-[10.5px] text-app-text-muted">{f.path}</span>
            {!f.exists && <Chip>{t('sessionEnv.file.missing')}</Chip>}
          </Row>
        ))}
        {env.mcp.source && (
          <Row testId="session-env-file-mcp">
            <Chip mono>mcp</Chip>
            <span className="break-all font-mono text-[10.5px] text-app-text-muted">{env.mcp.source}</span>
          </Row>
        )}
      </Section>

      <p className="text-[10.5px] text-app-text-muted">{t('sessionEnv.readonly')}</p>
    </div>
  );
}

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-app-text-tertiary">
        <span className="text-app-text-muted">{icon}</span>
        <span>{title}</span>
        <span className="tabular-nums text-app-text-muted">{count}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ children, testId, state }: { children: React.ReactNode; testId?: string; state?: string }) {
  return (
    <div
      data-testid={testId}
      data-state={state}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-app-border bg-surface/60 px-2 py-1.5 ${state === 'excluded' ? 'opacity-60' : ''}`}
    >
      {children}
    </div>
  );
}

/** The colour of a chip. `excluded` is deliberately not red: a rule doing its
 *  job painted like a fault sends people hunting for a bug that is not there. */
const TONE: Record<string, string> = {
  ok: 'text-emerald-400 border-emerald-400/30',
  deny: 'text-red-500 border-red-500/30',
  muted: 'text-app-text-muted border-app-border',
};

function Chip({ children, tone, mono }: { children: React.ReactNode; tone?: keyof typeof TONE; mono?: boolean }) {
  return (
    <span className={`rounded border px-1 py-px text-[10px] ${mono ? 'font-mono ' : ''}${TONE[tone ?? 'muted']}`}>
      {children}
    </span>
  );
}

function SourceChip({ source, file }: { source: SessionEnvSource; file?: string }) {
  const t = useT();
  return <span title={file}><Chip>{t(`sessionEnv.source.${source}`)}</Chip></span>;
}

function Detail({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={`w-full break-all font-mono text-[10.5px] ${muted ? 'text-app-text-muted' : 'text-app-text-secondary'}`}>
      {children}
    </span>
  );
}

function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div data-testid={testId} className="break-words text-[11px] text-app-text-muted">{children}</div>;
}
