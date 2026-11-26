/**
 * WHO IS AT WORK, ONE NUMBER (22/11): the pill on the identity card, the
 * tail of the agents row in System and the foot of the bell («14 at work»)
 * all say this. Before, the pill and the
 * foot counted Topics alone through two different rules and System added the
 * hub's agents outside Topics: three numbers for one question.
 *
 * It is the sessions of Topics at work (the rows the System level lists,
 * `activeAgentRowsFrom`) plus what the hub sees at work outside Topics: Claude
 * Code elsewhere, Codex, Muse, the sub-agents, the live workflows. The hub
 * counts those without the Topics tabs it found, so nobody is counted twice.
 */
import { useHubEverRead, useHubLive } from './hubLive';

/** The hub's count of agents at work outside Topics; 0 without the hub, or while it does not answer. */
export function outsideAgentsOf(projectsData: unknown): number {
  const n = (projectsData as { agentsOutside?: unknown } | undefined)?.agentsOutside;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function useOutsideAgents(): number {
  const present = useHubEverRead();
  const projects = useHubLive().projects;
  return present && !projects?.error ? outsideAgentsOf(projects?.data) : 0;
}
