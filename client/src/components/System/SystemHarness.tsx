/**
 * HARNESS: what an agent reads before the first word, as layers with their
 * weight: Topics' base, the user's rules, the agent (one chip each, opening its
 * page), the tools (always on against mounted on request), the memory index and
 * the turn. Contradictions between two sources come with the two sources, and
 * the weight per outside harness comes from the usage hub only when it is there.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Scale } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { shortTokens } from '../../lib/formatTokens';
import { useAgentRegistry } from '../../state/agentRegistry';
import { HUB_CONTEXT_DOC, useHubDoc } from '../../state/hubDocs';
import { contextView } from '../../lib/hubContext';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { BTN } from '../Agents/AgentConfigPieces';
import { harnessLayers, memoryIndexTokens, type PersonaWeights } from './harnessLayers';
import { openAgentPlace, openSystemPlace } from './systemNav';

const ContextLevel = lazy(async () => {
  const { ContextLevel: Body } = await import('../Sidebar/ContextLevel');
  return { default: Body };
});

interface ToolsWeight { tokenWeight?: { alwaysOn?: number; onDemand?: number } }
interface StoresAnswer { stores?: { index: { chars: number } | null; receivedBy: string[] }[] }

function Layer({ id, title, hint, weight, where, children }: { id: string; title: string; hint: string; weight: string; where: ReactNode; children?: ReactNode }) {
  const tr = useT();
  return (
    <li data-testid={`harness-layer-${id}`} className="rounded border border-app-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-prose font-medium text-app-text">{title}</span>
        <span data-testid={`harness-weight-${id}`} className="ml-auto text-mini tabular-nums text-app-text-secondary">{weight}</span>
      </div>
      <p className="mt-0.5 text-mini text-app-text-muted">{hint}</p>
      {children}
      <p className="mt-1.5 text-mini text-app-text-muted">
        {tr('system.harness.changeAt')}: <span data-testid={`harness-where-${id}`}>{where}</span>
      </p>
    </li>
  );
}

export function SystemHarness() {
  const tr = useT();
  const locale = useLocale();
  const { reg } = useAgentRegistry();
  const [personas, setPersonas] = useState<PersonaWeights[] | null>(null);
  const [tools, setTools] = useState<{ alwaysOn: number; onDemand: number } | null>(null);
  const [memory, setMemory] = useState<number | null>(null);
  const hub = useHubDoc(HUB_CONTEXT_DOC, true, 60_000);
  const hubPresent = useMemo(() => contextView(hub.data) !== null, [hub.data]);

  useEffect(() => {
    if (!reg) return;
    let alive = true;
    void Promise.all(reg.agents.map(async (a) => {
      const body = await readJson(`/api/agent-config/persona?agent=${encodeURIComponent(a.id)}`) as { layers?: PersonaWeights['layers'] } | null;
      return { agent: a.id, name: a.name, layers: body?.layers ?? [] };
    })).then((list) => { if (alive) setPersonas(list); });
    return () => { alive = false; };
  }, [reg]);
  useEffect(() => {
    let alive = true;
    void readJson('/api/agent-tools').then((b) => {
      const w = (b as ToolsWeight | null)?.tokenWeight;
      if (alive && w) setTools({ alwaysOn: w.alwaysOn ?? 0, onDemand: w.onDemand ?? 0 });
    });
    void readJson('/api/memory-stores').then((b) => {
      const stores = (b as StoresAnswer | null)?.stores;
      if (alive && stores) setMemory(memoryIndexTokens(stores));
    });
    return () => { alive = false; };
  }, []);

  if (!reg || !personas) return <p className="text-prose text-app-text-muted">{tr('system.reading')}</p>;
  const layers = harnessLayers(personas, tools, memory);
  const tokens = (n: number) => tr('system.harness.tokens', { n: shortTokens(n, locale) });
  const link = (label: string, go: () => void, id: string) => (
    <button type="button" data-testid={`harness-where-link-${id}`} onClick={go} className="underline hover:text-primary">{label}</button>
  );
  const contradictions = reg.issues.filter((i) => i.type === 'source-contradiction');
  return (
    <section data-testid="system-harness" className="max-w-3xl space-y-4">
      <h2 className="text-body font-semibold text-app-text">{tr('system.harness.title')}</h2>
      <p className="text-prose text-app-text-secondary">{tr('system.harness.intro')}</p>
      <ol className="space-y-2">
        <Layer id="base" title={tr('system.harness.base')} hint={tr('system.harness.baseHint')} weight={tokens(layers.base)} where={tr('system.harness.where.base')} />
        <Layer id="rules" title={tr('system.harness.rules')} hint={tr('system.harness.rulesHint')} weight={tokens(layers.rules)} where={tr('system.harness.where.rules')} />
        <Layer id="agent" title={tr('system.harness.agent')} hint={tr('system.harness.agentHint')} weight={tr('system.harness.perAgent')} where={link(tr('system.harness.where.agent'), () => (layers.agents[0] ? openAgentPlace(layers.agents[0].id) : window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'agents' } }))), 'agent')}>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {layers.agents.length === 0 && <span className="text-mini text-app-text-muted">{tr('system.harness.noAgents')}</span>}
            {layers.agents.map((a) => (
              <button key={a.id} type="button" data-testid="harness-agent-chip" onClick={() => openAgentPlace(a.id, 'context')} className="rounded-full border border-app-border px-2.5 py-1 text-mini text-app-text hover:bg-app-hover">
                {a.name || a.id} <span className="tabular-nums text-app-text-muted">{tokens(a.tokens)}</span>
              </button>
            ))}
          </div>
        </Layer>
        <Layer
          id="tools" title={tr('system.harness.tools')} hint={tr('system.harness.toolsHint')}
          weight={layers.tools ? tr('system.harness.toolsWeight', { on: shortTokens(layers.tools.alwaysOn, locale), demand: shortTokens(layers.tools.onDemand, locale) }) : tr('system.harness.unknown')}
          where={link(tr('system.harness.where.tools'), () => openSystemPlace('tools'), 'tools')}
        />
        <Layer id="memory" title={tr('system.harness.memory')} hint={tr('system.harness.memoryHint')} weight={layers.memory === null ? tr('system.harness.unknown') : tokens(layers.memory)} where={link(tr('system.harness.where.memory'), () => openSystemPlace('memory'), 'memory')} />
        <Layer id="turn" title={tr('system.harness.turn')} hint={tr('system.harness.turnHint')} weight={tr('system.harness.grows')} where={tr('system.harness.where.turn')} />
      </ol>

      <div>
        <h3 className="mb-1 text-prose font-semibold text-app-text">{tr('system.harness.contradictions')}</h3>
        {contradictions.length === 0 ? (
          <p data-testid="harness-no-contradictions" className="text-mini text-app-text-muted">{tr('system.harness.noContradictions')}</p>
        ) : (
          <ul className="space-y-2">
            {contradictions.map((c) => (
              <li key={`${c.ref}:${c.text}`} data-testid="harness-contradiction" className="flex items-start gap-2 rounded border border-app-border p-2.5">
                <Scale size={14} aria-hidden="true" className={`mt-0.5 flex-shrink-0 ${WARNING_TEXT}`} />
                <span className="min-w-0 flex-1 text-prose text-app-text">
                  {c.sources ? tr('system.harness.contradiction', { a: c.sources[0], b: c.sources[1] }) : c.text}
                </span>
                {c.agent && <button type="button" data-testid="harness-contradiction-pick" onClick={() => openAgentPlace(c.agent!, 'channels')} className={BTN}>{tr('system.harness.pick')}</button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="harness-external">
        <h3 className="mb-1 text-prose font-semibold text-app-text">{tr('system.harness.external')}</h3>
        {hubPresent ? (
          <Suspense fallback={<p className="text-mini text-app-text-muted">{tr('system.reading')}</p>}><ContextLevel embedded /></Suspense>
        ) : (
          <p data-testid="harness-external-missing" className="text-prose text-app-text-secondary">{tr('system.harness.externalMissing')}</p>
        )}
      </div>
    </section>
  );
}
