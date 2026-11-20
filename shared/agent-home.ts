/**
 * WHICH ALWAYS-ON AGENT A FOLDER BELONGS TO (Jarvis, Visione, any other agent
 * of the agents' home). The criterion lives here and nowhere else: the client
 * groups agent sessions with it (`client/src/lib/agentSessions.ts`) and the
 * server tells a card which agent's chat it came from (`openerAgent`).
 *
 * A folder is an agent's when it sits in an agent home. The agent is read from
 * the folder: `workspace-<id>` is agent `<id>`, the home itself and its
 * `workspace` are the main agent. A new agent shows up on its own, with its id
 * as name, until `AGENT_NAMES` gives it a friendlier one.
 */
import { LEGACY_DATA_DIR_NAME } from './legacy-data-dir';

/** The agent homes, as path suffixes: the old data root and Jarvis' home. */
const AGENT_HOMES = [`/${LEGACY_DATA_DIR_NAME}`, '/.claude/jarvis/home'] as const;

/** The main agent, the one that answers in the home itself. */
export const MAIN_AGENT = 'jarvis';

/** Friendly names of the agents we know; any other shows its folder id. */
const AGENT_NAMES: Record<string, string> = {
  jarvis: 'Jarvis',
  gtm: 'Visione', // allow-italian: the agent's own name, not UI copy
};

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The agent that owns a folder, or null when the folder is not an agent's.
 * The old data root and its `workspace` are the main agent,
 * its `workspace-gtm/…` is `gtm`.
 */
export function agentOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = norm(path);
  for (const home of AGENT_HOMES) {
    const at = p.indexOf(home);
    if (at < 0) continue;
    const rest = p.slice(at + home.length);
    if (rest !== '' && !rest.startsWith('/')) continue;
    const first = rest.split('/')[1] ?? '';
    const m = /^workspace-(.+)$/.exec(first);
    return m ? m[1] : MAIN_AGENT;
  }
  return null;
}

export function isAgentPath(path: string | null | undefined): boolean {
  return agentOfPath(path) !== null;
}

/** The name an agent is read by: its friendly name, else its folder id. */
export function agentName(id: string): string {
  return AGENT_NAMES[id] ?? id;
}

/** The agent id a display name or id stands for («Visione» -> `gtm`), or null when it names no agent we know. */
export function agentIdOfName(name: string | null | undefined): string | null {
  const n = name?.trim().toLowerCase();
  if (!n) return null;
  for (const [id, friendly] of Object.entries(AGENT_NAMES)) if (id === n || friendly.toLowerCase() === n) return id;
  return null;
}
