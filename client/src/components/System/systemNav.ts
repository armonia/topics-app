/**
 * THE ADDRESS OF ONE PLACE INSIDE «SISTEMA», and the door from a health
 * problem to the place that fixes it.
 *
 * Like the Agents page, System has no pathname of its own: its section lives
 * in the hash (`#sistema/<section>`) and is written with `replaceState`, so a
 * reload opens on the same section. `openAgentPlace` is the other direction:
 * it points the Agents page at one agent (and Configure section) and opens it.
 */
import type { HealthDestination } from '../../../../shared/agents-health';

export const SYSTEM_SECTIONS = ['health', 'harness', 'tools', 'memory', 'log'] as const;
export type SystemSection = (typeof SYSTEM_SECTIONS)[number];

const PREFIX = '#sistema';

export function systemSectionFromHash(hash: string): SystemSection | null {
  if (!hash.startsWith(PREFIX)) return null;
  const section = decodeURIComponent(hash.slice(PREFIX.length).replace(/^\/+/, ''));
  return (SYSTEM_SECTIONS as readonly string[]).includes(section) ? (section as SystemSection) : null;
}

export function readSystemSection(): SystemSection {
  return systemSectionFromHash(window.location.hash) ?? 'health';
}

export function writeSystemSection(section: SystemSection): void {
  const hash = `${PREFIX}/${section}`;
  if (window.location.hash === hash) return;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', pathname + search + hash);
}

/** Opens the Agents page on one agent: its Configure `section`, or its activity when there is none. */
export function openAgentPlace(agentId: string, section?: string): void {
  const base = `#agenti/${encodeURIComponent(agentId)}`;
  window.location.hash = section ? `${base}/configura/${encodeURIComponent(section)}` : base;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'agents' } }));
}

/** Opens System on one section. */
export function openSystemPlace(section: SystemSection): void {
  window.location.hash = `${PREFIX}/${section}`;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'system-page' } }));
}

export type HealthPlace =
  | { kind: 'agent'; agentId: string; section: string }
  | { kind: 'system'; section: SystemSection }
  | { kind: 'automations' };

const AGENT_SECTION: Record<string, string> = { jobs: 'jobs', chats: 'channels', memory: 'memory', tools: 'tools', identity: 'identity' };
const SYSTEM_PLACE: Record<string, SystemSection> = { harness: 'harness', rules: 'harness', memory: 'memory', tools: 'tools' };

/**
 * Where a problem is fixed. A problem that names an agent goes to that
 * agent's Configure section; one that does not goes to the System section
 * about the same thing (a scheduled job with no agent goes to Automations,
 * where jobs live).
 */
export function healthTarget(d: HealthDestination): HealthPlace {
  const agentSection = AGENT_SECTION[d.section];
  if (d.agentId && agentSection) return { kind: 'agent', agentId: d.agentId, section: agentSection };
  if (d.section === 'jobs') return { kind: 'automations' };
  return { kind: 'system', section: SYSTEM_PLACE[d.section] ?? 'health' };
}

export function openHealthTarget(target: HealthPlace): void {
  if (target.kind === 'agent') openAgentPlace(target.agentId, target.section);
  else if (target.kind === 'automations') window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'automations' } }));
  else openSystemPlace(target.section);
}
