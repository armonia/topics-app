/**
 * THE PROJECT MENU'S AGENTS (hub-smistamento, HUBBR-16): who works on the
 * project now, as the hub's Progetti page listed it under each project, across
 * Claude Code, Codex, Muse and jcode, inside Topics and out.
 *
 * Folded, one line says how many, the model mix («1 Opus · 2 Sonnet») and the
 * pace of the last hour; open, each agent says its provider and model, what
 * kind of session it is, since when it runs, when it last did something, its
 * tokens and its share of the week, its title, sub-agents one step in, and
 * «Apri» where the hub knows a way in (a Topics chat opens here as a tab, the
 * desktop app's link opens outside). Below, the hub's cost advice when Opus
 * runs on a project that already took a tenth of the Claude week.
 */
import { useState } from 'react';
import { AlertTriangle, Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { openExternal } from '../../lib/shell/external';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { CodexIcon } from '../Shared/CodexIcon';
import {
  PROVIDER_NAMES, agentOpen, modelMix, opusAdvice, shortTokens, weekShare,
  type HubAgent, type HubProject,
} from '../../lib/projectHub';

type Tr = ReturnType<typeof useT>;

/** A span of time in the menu's words: minutes, then hours, then days. */
export function spanWords(tr: Tr, ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return tr('projectHub.span.min', { n: Math.max(1, min) });
  const h = Math.round(min / 60);
  if (h < 48) return tr('projectHub.span.h', { n: h });
  return tr('projectHub.span.d', { n: Math.round(h / 24) });
}

function ProviderGlyph({ provider }: { provider: string }) {
  if (provider === 'claude') return <ClaudeIcon size={12} className="flex-none text-app-text-secondary" />;
  if (provider === 'codex') return <CodexIcon size={12} className="flex-none text-app-text-secondary" />;
  return <Bot size={12} className="flex-none text-app-text-secondary" aria-hidden="true" />;
}

function AgentRow({ a, now, onOpened }: { a: HubAgent; now: number; onOpened?: () => void }) {
  const tr = useT();
  const locale = useLocale();
  const target = agentOpen(a.open);
  const meta = [
    a.kind,
    a.startedAt !== null ? tr('projectHub.agent.since', { t: spanWords(tr, now - a.startedAt) }) : '',
    a.lastActivity !== null ? (now - a.lastActivity < 60_000 ? tr('projectHub.agent.now') : tr('projectHub.agent.ago', { t: spanWords(tr, now - a.lastActivity) })) : '',
    a.tokens > 0 ? tr('projectHub.agent.tokens', { n: shortTokens(a.tokens, locale) }) : '',
    a.pct > 0 ? tr('projectHub.agent.pct', { pct: a.pct < 0.1 ? `<${(0.1).toLocaleString(locale)}` : a.pct.toLocaleString(locale, { maximumFractionDigits: 1 }) }) : '',
  ].filter(Boolean).join(' · ');
  const open = () => {
    if (!target) return;
    if (target.kind === 'topic') window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: target.id, mode: 'permanent', reveal: true } }));
    else void openExternal(target.url);
    onOpened?.();
  };
  return (
    <div
      data-testid="project-hub-agent"
      data-depth={a.depth || undefined}
      className="flex items-start gap-1.5 py-1 pr-3"
      style={{ paddingLeft: 12 + Math.min(2, a.depth) * 14 }}
    >
      <span className="mt-0.5 flex flex-none" title={PROVIDER_NAMES[a.provider] ?? a.provider}><ProviderGlyph provider={a.provider} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1">
          <b className="flex-none text-mini font-semibold text-app-text">{a.model || PROVIDER_NAMES[a.provider] || a.provider}</b>
          <span data-testid="project-hub-agent-meta" className="truncate text-mini tabular-nums text-app-text-tertiary" title={meta}>{meta}</span>
        </div>
        {a.title && <div className="truncate text-mini text-app-text-secondary" title={a.title}>{a.title}</div>}
      </div>
      {target && (
        <button
          type="button"
          data-testid="project-hub-agent-open"
          onClick={open}
          title={a.open?.via ? tr('projectHub.agent.openVia', { via: a.open.via }) : undefined}
          className="inline-flex h-[18px] flex-none items-center whitespace-nowrap rounded-xs bg-app-hover px-1.5 text-mini text-app-text-secondary hover:text-app-text"
        >
          {tr('projectHub.agent.open')}
        </button>
      )}
    </div>
  );
}

/** The agents' fold and the Opus advice; nothing when no agent works on the project. */
export function ProjectHubAgents({ p, onOpened }: { p: HubProject; onOpened?: () => void }) {
  const tr = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const a = p.agents;
  if (!a) return null;
  const now = Date.now();
  const advice = opusAdvice(p);
  const hidden = a.count - a.list.length;
  return (
    <div data-testid="project-hub-agents">
      <button
        type="button"
        data-testid="project-hub-agents-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-app-hover"
      >
        {open ? <ChevronDown size={12} className="flex-none text-app-text-tertiary" aria-hidden="true" /> : <ChevronRight size={12} className="flex-none text-app-text-tertiary" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-mini">
          <span className="text-app-text">{a.count === 1 ? tr('projectHub.agentsOne') : tr('projectHub.agents', { n: a.count })}</span>
          {a.models.length > 0 && <span data-testid="project-hub-agents-mix" className="text-app-text-tertiary">{` · ${modelMix(a)}`}</span>}
        </span>
        {a.hourTokens > 0 && (
          <span data-testid="project-hub-agents-pace" className="flex-none text-mini tabular-nums text-app-text-secondary" title={tr('projectHub.paceTitle')}>
            {tr('projectHub.pace', { n: shortTokens(a.hourTokens, locale) })}
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-[220px] overflow-y-auto">
          {a.list.map((g, i) => <AgentRow key={`${g.provider}-${g.startedAt ?? i}-${i}`} a={g} now={now} onOpened={onOpened} />)}
          {hidden > 0 && <div className="px-3 py-1 text-mini text-app-text-tertiary">{tr('projectHub.agentsMore', { n: hidden })}</div>}
        </div>
      )}
      {advice && (
        <div data-testid="project-hub-opus" className={`flex items-start gap-1.5 px-3 py-1 text-mini leading-snug ${WARNING_TEXT}`}>
          <AlertTriangle size={12} className="mt-0.5 flex-none" aria-hidden="true" />
          <span>{tr('projectHub.opus', { n: advice.n, t: spanWords(tr, advice.ms), pct: weekShare(p.claude) })}</span>
        </div>
      )}
    </div>
  );
}
