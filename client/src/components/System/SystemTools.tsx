/**
 * STRUMENTI: the catalogue of what the agents can reach (MCP servers, skills,
 * CLIs), who uses each server and what it weighs on every turn. A chip with an
 * agent's name opens that agent's tool filter, where «Limita» is set; the
 * servers that are always on and the ones mounted on request are told apart
 * because only the first kind is paid on every turn.
 */
import { useEffect, useState } from 'react';
import { useLocale, useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { shortTokens } from '../../lib/formatTokens';
import { useAgentRegistry } from '../../state/agentRegistry';
import { AgentToolsPage } from '../Settings/AgentToolsPage';
import { openAgentPlace } from './systemNav';

interface Weight { alwaysOn: number; onDemand: number }

export function SystemTools() {
  const tr = useT();
  const locale = useLocale();
  const { reg } = useAgentRegistry();
  const [weight, setWeight] = useState<Weight | null>(null);
  useEffect(() => {
    let alive = true;
    void readJson('/api/agent-tools').then((b) => {
      const w = (b as { tokenWeight?: Weight } | null)?.tokenWeight;
      if (alive && w) setWeight(w);
    });
    return () => { alive = false; };
  }, []);
  return (
    <section data-testid="system-tools" className="max-w-3xl space-y-3">
      <h2 className="text-body font-semibold text-app-text">{tr('system.tools.title')}</h2>
      <p className="text-prose text-app-text-secondary">{tr('system.tools.intro')}</p>
      {weight && (
        <p data-testid="system-tools-weight" className="text-mini tabular-nums text-app-text-muted">
          {tr('system.tools.weight', { on: shortTokens(weight.alwaysOn, locale), demand: shortTokens(weight.onDemand, locale) })}
        </p>
      )}
      <div className="rounded border border-app-border">
        <AgentToolsPage agents={reg?.agents.map((a) => ({ id: a.id, name: a.name }))} onLimit={(id) => openAgentPlace(id, 'tools')} />
      </div>
    </section>
  );
}
