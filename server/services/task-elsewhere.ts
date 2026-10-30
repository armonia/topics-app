/**
 * WHERE an In-progress card works when no agent of this machine is in it.
 *
 * On 26/10 two cards sat in In progress with the same chip, "stopped · no
 * agent": one had its work running in a Claude cloud session, the other had
 * simply stopped. The board could not tell them apart, and the person reading
 * it could not tell whether to wait or to step in. This module reads the three
 * places that say "somebody is on it, not here", in the order they are sure:
 *
 *  1. the card names a paired node that answers at an address (a PC, or the
 *     Claude cloud node): the run lives on that machine;
 *  2. the thread links a Claude cloud session (`claude.ai/code/session_…`):
 *     somebody started the work there, outside the dispatcher;
 *  3. the card points at a pull request (`output_url`): the work is that PR.
 *
 * None of them proves the run is alive this second, and the sentences on the
 * card say so: they say WHERE, the thread says how it is going.
 */
import type { Database } from "bun:sqlite";
import type { QueueContext } from "../../shared/board";

type Elsewhere = NonNullable<QueueContext["elsewhere"]>;

/** The hostname the Claude cloud node registers with (`providers/claude-cloud/node.ts`). */
const CLOUD_HOST = "claude-cloud";

const CLOUD_LINK = /https?:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/;
const PR_LINK = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;

interface Row {
  id: string;
  status: string;
  parent_task_id?: string | null;
  assigned_to?: string | null;
  machine_id?: string | null;
  output_url?: string | null;
}

const ids = (xs: string[]) => JSON.stringify(xs);

/** Only the rows the `no_agent` branch can reach: In progress, a root, nobody's. */
function candidates(rows: Row[]): Row[] {
  return rows.filter((r) => r.status === "in_progress" && !r.parent_task_id && !r.assigned_to);
}

export function readElsewhere(db: Database, rows: Row[]): Map<string, Elsewhere> {
  const out = new Map<string, Elsewhere>();
  const todo = candidates(rows);
  if (!todo.length) return out;

  // 1. A node that answers at an address. A row without `base_url` is a stale
  //    row of THIS machine (one per hostname): no agent there means no agent.
  const machineIds = [...new Set(todo.map((r) => r.machine_id).filter(Boolean) as string[])];
  if (machineIds.length) {
    try {
      const nodes = new Map<string, { name: string; hostname: string; base_url: string | null }>();
      for (const m of db.query(
        "SELECT id, name, hostname, base_url FROM machines WHERE id IN (SELECT value FROM json_each(?))",
      ).all(ids(machineIds)) as Array<{ id: string; name: string; hostname: string; base_url: string | null }>) nodes.set(m.id, m);
      for (const r of todo) {
        const node = r.machine_id ? nodes.get(r.machine_id) : undefined;
        if (!node?.base_url) continue;
        out.set(r.id, node.hostname === CLOUD_HOST
          ? { where: "cloud", label: node.name }
          : { where: "node", label: node.name });
      }
    } catch { /* a reduced schema without `machines` or `base_url`: nothing to say */ }
  }

  // 2. A cloud session linked in the thread, newest first.
  const rest = todo.filter((r) => !out.has(r.id));
  if (rest.length) {
    try {
      for (const c of db.query(
        `SELECT task_id, content FROM task_comments
          WHERE task_id IN (SELECT value FROM json_each(?)) AND content LIKE '%claude.ai/code/session_%'
          ORDER BY created_at DESC, rowid DESC`,
      ).all(ids(rest.map((r) => r.id))) as Array<{ task_id: string; content: string }>) {
        if (out.has(c.task_id)) continue;
        const m = CLOUD_LINK.exec(c.content);
        if (m) out.set(c.task_id, { where: "cloud", label: m[0] });
      }
    } catch { /* no thread table: nothing to say */ }
  }

  // 3. A pull request the card points at.
  for (const r of todo) {
    if (out.has(r.id) || !r.output_url) continue;
    const m = PR_LINK.exec(r.output_url);
    if (m) out.set(r.id, { where: "pr", label: `#${m[1]}` });
  }
  return out;
}
