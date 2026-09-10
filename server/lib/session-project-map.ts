/**
 * WHICH PROJECT A LIVE SESSION BELONGS TO, for a whole batch in ONE query.
 *
 * The fleet sampler (`lib/fleet-usage.ts`) knows what each session is holding
 * in RAM and CPU. It does not know which project that is, and the question the
 * performance panel exists to answer is per-project, not per-pid. The missing
 * half is a `topics` row.
 *
 * WHY A BATCH AND NOT A LOOKUP. `getFleetSessionRefs` runs on every fleet
 * sample. A per-session query there would be N statements every few seconds for
 * an answer that is one indexed `IN` away; N is small today, and a loop that is
 * cheap at ten rows is the shape that stops being cheap without anyone editing
 * it. So the resolver takes the whole list and answers with a map. Measured on
 * the live database (1.7k topics): 0.12 ms for a batch of 7, 0.14 ms for 20 -
 * both indexes it needs already exist.
 *
 * TWO KEY SHAPES, one query. A terminal session carries the topic's FULL uuid
 * (`TerminalSession.topicId`); a chat session is addressed by its session key,
 * `topic:` + the first 8 characters of that uuid (`topicSessionKey` in
 * `services/agent-census.ts`). Both are looked up in the same statement, and
 * the returned map is keyed by whatever the caller passed in, so neither side
 * has to know how the other one is addressed.
 *
 * A KEY THAT IS ABSENT FROM THE MAP MEANS "no such topic row", and a row whose
 * `projectPath` is absent means the topic has no project. The two are not the
 * same thing and neither is an error: a scratch chat and a shell opened in
 * `$HOME` both legitimately belong to no project.
 */
import type { Database } from "bun:sqlite";

export interface SessionProject {
  /** Full topic uuid. */
  topicId: string;
  /** Absolute project path, absent when the topic has none. */
  projectPath?: string;
}

/**
 * Resolve topic identity + project path for a batch of session keys and/or
 * topic ids. One statement, whatever the batch size. An empty batch runs
 * nothing at all.
 */
export function resolveSessionProjects(
  db: Database,
  keys: readonly string[],
): Map<string, SessionProject> {
  const out = new Map<string, SessionProject>();
  const wanted = [...new Set(keys.filter((k) => typeof k === "string" && k.length > 0))];
  if (wanted.length === 0) return out;

  const holes = wanted.map(() => "?").join(",");
  let rows: Array<{ id: string; session_key: string; project_path: string | null }>;
  try {
    rows = db
      .prepare(
        `SELECT id, session_key, project_path FROM topics
          WHERE session_key IN (${holes}) OR id IN (${holes})`,
      )
      .all(...wanted, ...wanted) as typeof rows;
  } catch {
    // A missing table or a locked database costs the attribution, never the
    // measurement it decorates: the caller keeps its memory and CPU figures.
    return out;
  }

  for (const r of rows) {
    const value: SessionProject = { topicId: r.id };
    if (r.project_path) value.projectPath = r.project_path;
    // Indexed under BOTH addresses, so the caller looks up with the string it
    // already has instead of converting one shape into the other.
    if (r.session_key) out.set(r.session_key, value);
    if (r.id) out.set(r.id, value);
  }
  return out;
}
