/**
 * WHICH ALWAYS-ON AGENT A FOLDER BELONGS TO (Jarvis, Visione, any other agent
 * living in the Topics home). The criterion lives here and nowhere else: the
 * client groups agent sessions with it (`client/src/lib/agentSessions.ts`) and
 * the server tells a card which agent's chat it came from (`openerAgent`).
 *
 * Every agent has its home at `<topics home>/agents/<id>` (`~/.topics/agents/<id>`)
 * and the folder's name is its id: anything below it is that agent's. A new
 * agent shows up on its own, with its id as name, until `AGENT_NAMES` gives it
 * a friendlier one.
 */

/** Where the agents' homes sit, as a path piece: `<home>/.topics/agents/<id>/...`. */
const AGENTS_DIR = '/.topics/agents/';

/** The main agent: a channel chat that names no agent of its own is its. */
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
 * The agent that owns a folder, or null when the folder is not an agent's:
 * `~/.topics/agents/gtm/...` is `gtm`, `~/.topics/agents` alone is nobody's.
 */
export function agentOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = `${norm(path)}/`;
  const at = p.indexOf(AGENTS_DIR);
  if (at < 0) return null;
  return p.slice(at + AGENTS_DIR.length).split('/')[0] || null;
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
