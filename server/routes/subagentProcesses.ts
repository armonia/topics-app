/**
 * The sub-agent processes of a topic, derived from a provider's session list.
 *
 * WHY THIS IS ITS OWN FILE. It used to be one long inline expression inside
 * `GET /api/processes` (`routes/topics.ts`), and that route is the only view
 * Topics has of sub-agents AS PROCESSES — the panel that says what is running
 * under a chat. Nothing tested it, and nothing could: the route resolves its
 * provider from the global registry, so exercising the mapping meant standing
 * up a fake provider. The same cut was made for the same reason in
 * `routes/clearPolicy.ts` — the decision is pure, so it lives where a test can
 * reach it and the route keeps only the plumbing.
 *
 * WHAT THE MAPPING DECIDES, and why each part can be wrong quietly:
 *
 *  - WHICH sessions count. A provider's session list contains far more than
 *    sub-agents; only the ones whose key names them belong in this panel. Get
 *    the filter wrong in the permissive direction and the panel fills with
 *    every session the provider knows — which reads as "these are all running
 *    under your chat", and none of them are.
 *  - WHETHER one is still running. `active` is the only status that means
 *    running; everything else is done. The panel draws a spinner off this, so
 *    an unknown status treated as running spins forever.
 *  - WHEN it finished. `completedAt` exists only for what has finished. A
 *    completion time on a running process is not a cosmetic slip: it is the
 *    panel saying a thing both ran and ended.
 */

/** One entry of a provider's session list, in the shape this mapping needs. */
export interface SessionForProcesses {
  sessionKey?: string;
  label?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SubagentProcess {
  sessionKey: string;
  label: string;
  status: "running" | "done";
  startedAt: string;
  completedAt?: string;
}

/** The mark that a session IS a sub-agent, in its key. */
const SUBAGENT_MARK = "subagent";

/**
 * The sub-agent sessions, in the shape the panel draws.
 *
 * The clock is a parameter and not `new Date()` on purpose: it is the fallback
 * for missing dates, and a test that cannot pin it would assert on the clock.
 */
export function subagentProcesses(
  sessions: readonly SessionForProcesses[],
  now: () => string = () => new Date().toISOString(),
): SubagentProcess[] {
  return sessions
    .filter((s) => s.sessionKey?.includes(SUBAGENT_MARK))
    .map((s) => {
      const key = s.sessionKey!;
      const isActive = s.status === "active";
      return {
        sessionKey: key,
        // The fallback is the LAST segment of the key, not the whole key:
        // `topic:abc:subagent:explore` in a narrow panel has to read as
        // "explore". The last fallback is a word, never an empty string.
        label: s.label || key.split(":").pop() || "Sub-agent",
        status: isActive ? "running" : "done",
        startedAt: s.createdAt || now(),
        ...(isActive ? {} : { completedAt: s.updatedAt || now() }),
      };
    });
}
