/**
 * Durable registry for the one global Kanban orchestrator Topic.
 *
 * The Topic itself deliberately stays ordinary: normal Topic/session/message
 * persistence owns the conversation.  This small table only answers the
 * security-sensitive question "is this exact Topic/session the global
 * orchestrator?".  No mutable Topic field is part of that answer.
 */
import type { Database } from "bun:sqlite";
import type { Topic } from "../types";

/** The sole scope supported by the registry. It is schema data, not a title. */
export const GLOBAL_ORCHESTRATOR_SCOPE = "global" as const;

export interface GlobalOrchestratorSession {
  scope: typeof GLOBAL_ORCHESTRATOR_SCOPE;
  topicId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Dependencies are injected so this registry does not own Topic persistence.
 * Production callers pass the normal AppContext Topic getters/saver and a
 * server-owned factory for an unbound Topic.  The factory is never called when
 * the registry already points at a Topic.
 */
export interface EnsureGlobalOrchestratorSessionDeps {
  db: Database;
  getTopicById: (topicId: string) => Topic | null;
  saveTopic: (topic: Topic) => void;
  createTopic: () => Topic;
  now?: () => string;
}

export interface EnsureGlobalOrchestratorSessionResult {
  topic: Topic;
  /** True only when this call created and registered the ordinary Topic. */
  created: boolean;
}

/** A registry row exists but its referenced Topic cannot be loaded. */
export class GlobalOrchestratorSessionIntegrityError extends Error {
  constructor(topicId: string) {
    super(`Global orchestrator registry points to missing topic ${topicId}`);
    this.name = "GlobalOrchestratorSessionIntegrityError";
  }
}

/** The server-owned factory returned a Topic that is not eligible to be global. */
export class GlobalOrchestratorTopicInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalOrchestratorTopicInvariantError";
  }
}

type RegistryRow = {
  scope: string;
  topic_id: string;
  created_at: string;
  updated_at: string;
};

function toSession(row: RegistryRow): GlobalOrchestratorSession {
  return {
    scope: GLOBAL_ORCHESTRATOR_SCOPE,
    topicId: row.topic_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolve the registered role from a Topic id.  This is deliberately a table
 * lookup, not a check of title, system prompt, project path, or MCP policy.
 */
export function getGlobalOrchestratorSessionByTopicId(
  db: Database,
  topicId: string,
): GlobalOrchestratorSession | null {
  if (!topicId) return null;
  try {
    const row = db
      .query(
        `SELECT scope, topic_id, created_at, updated_at
           FROM global_orchestrator_sessions
          WHERE scope = ? AND topic_id = ?
          LIMIT 1`,
      )
      .get(GLOBAL_ORCHESTRATOR_SCOPE, topicId) as RegistryRow | null;
    return row ? toSession(row) : null;
  } catch {
    // A partial/test database without the migration must never gain the role.
    // This is a security decision: a failed role lookup is false, not unknown.
    return null;
  }
}

/**
 * Resolve the registered role from a normal Topic session key.  The join makes
 * it impossible to grant the role from a caller-provided Topic id alone.
 */
export function getGlobalOrchestratorSessionBySessionKey(
  db: Database,
  sessionKey: string,
): GlobalOrchestratorSession | null {
  if (!sessionKey) return null;
  try {
    const row = db
      .query(
        `SELECT registry.scope, registry.topic_id, registry.created_at, registry.updated_at
           FROM global_orchestrator_sessions AS registry
           JOIN topics ON topics.id = registry.topic_id
          WHERE registry.scope = ? AND topics.session_key = ?
          LIMIT 1`,
      )
      .get(GLOBAL_ORCHESTRATOR_SCOPE, sessionKey) as RegistryRow | null;
    return row ? toSession(row) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the *usable* global capability.  The registry remains the durable
 * role identity, but the coordinator may exercise its narrow cross-board
 * authority only while its backing Topic is still an unbound, top-level Codex
 * conversation.
 *
 * Keep this deliberately separate from `getGlobalOrchestratorSessionBySessionKey`.
 * Callers that deny ordinary project/file/session behaviour must use the raw
 * registry lookup: a manually corrupted row must not become an ordinary
 * project-bound Topic merely because it is no longer eligible for the global
 * capability.
 */
export function getEligibleGlobalOrchestratorSessionBySessionKey(
  db: Database,
  sessionKey: string,
): GlobalOrchestratorSession | null {
  if (!sessionKey) return null;
  try {
    const row = db
      .query(
        `SELECT registry.scope, registry.topic_id, registry.created_at, registry.updated_at
           FROM global_orchestrator_sessions AS registry
           JOIN topics ON topics.id = registry.topic_id
          WHERE registry.scope = ?
            AND topics.session_key = ?
            AND topics.project_path IS NULL
            AND topics.worktree_id IS NULL
            AND topics.parent_id IS NULL
            AND topics.provider = 'codex'
          LIMIT 1`,
      )
      .get(GLOBAL_ORCHESTRATOR_SCOPE, sessionKey) as RegistryRow | null;
    return row ? toSession(row) : null;
  } catch {
    // A partial schema must not accidentally grant cross-board authority.
    return null;
  }
}

/** Role predicate for a Topic id; callers must still perform normal auth. */
export function isGlobalOrchestratorTopic(db: Database, topicId: string): boolean {
  return getGlobalOrchestratorSessionByTopicId(db, topicId) !== null;
}

/** Role predicate for a normal Topic session key; fail closed when absent. */
export function isGlobalOrchestratorSession(db: Database, sessionKey: string): boolean {
  return getGlobalOrchestratorSessionBySessionKey(db, sessionKey) !== null;
}

/**
 * Capability predicate for the focused global board surface.  Unlike the raw
 * role predicate above, this fails closed after a binding/provider corruption.
 */
export function isEligibleGlobalOrchestratorSession(db: Database, sessionKey: string): boolean {
  return getEligibleGlobalOrchestratorSessionBySessionKey(db, sessionKey) !== null;
}

/**
 * Small batched read for client-facing Topic lists.  The marker is a
 * presentation aid, but its source is still the raw durable registry: a
 * malformed coordinator must remain visibly restricted rather than reverting
 * to an ordinary Topic-shaped UI.
 */
export function listGlobalOrchestratorTopicIds(db: Database): ReadonlySet<string> {
  try {
    const rows = db.query(
      `SELECT topic_id
         FROM global_orchestrator_sessions
        WHERE scope = ?`,
    ).all(GLOBAL_ORCHESTRATOR_SCOPE) as Array<{ topic_id: string }>;
    return new Set(rows.map((row) => row.topic_id));
  } catch {
    // A partial/test database that lacks the migration must never fabricate a
    // coordinator identity.  This mirrors the fail-closed role predicates.
    return new Set();
  }
}

/**
 * Project the registry-backed role into a Topic payload sent to the client.
 * The copy is intentional: callers may persist the original Topic later, and
 * this UI marker must never become accidental database state.
 */
export function presentGlobalOrchestratorTopic(db: Database, topic: Topic): Topic {
  if (isGlobalOrchestratorTopic(db, topic.id)) {
    return topic.isGlobalOrchestrator ? topic : { ...topic, isGlobalOrchestrator: true };
  }
  // The marker is server-projected rather than caller-controlled.  Strip a
  // stale or forged transport value from any ordinary Topic before it leaves
  // this boundary, instead of treating the presence of the field as authority.
  if (topic.isGlobalOrchestrator === undefined) return topic;
  const unmarked = { ...topic };
  delete unmarked.isGlobalOrchestrator;
  return unmarked;
}

function assertGlobalOrchestratorTopicShape(topic: Topic): void {
  if (!topic?.id) {
    throw new GlobalOrchestratorTopicInvariantError("Global orchestrator Topic needs an id");
  }
  if (!topic.sessionKey) {
    throw new GlobalOrchestratorTopicInvariantError("Global orchestrator Topic needs a session key");
  }
  // A project-bound Topic inherits a board's ordinary task authority. The
  // orchestrator must instead receive its narrow cross-board authority from
  // this registry, so binding one here is an invariant violation.
  if (topic.projectPath || topic.worktreeId || topic.parentId) {
    throw new GlobalOrchestratorTopicInvariantError(
      "Global orchestrator Topic must be an unbound top-level Topic (no project path, worktree, or parent)",
    );
  }
}

function assertEligibleGlobalTopic(topic: Topic): void {
  assertGlobalOrchestratorTopicShape(topic);
  if (topic.provider !== "codex") {
    throw new GlobalOrchestratorTopicInvariantError(
      "Global orchestrator Topic must use the Codex provider",
    );
  }
}

/**
 * Create or reuse the singleton within one `BEGIN IMMEDIATE` transaction.
 *
 * `BEGIN IMMEDIATE` serializes the check/create sequence before either caller
 * can mint a Topic, so concurrent ensure calls converge on a single registry
 * row.  The normal Topic saver may itself use a nested transaction/savepoint;
 * it remains inside this outer write boundary.
 */
export function ensureGlobalOrchestratorSession(
  deps: EnsureGlobalOrchestratorSessionDeps,
): EnsureGlobalOrchestratorSessionResult {
  const now = deps.now ?? (() => new Date().toISOString());

  return deps.db
    .transaction((): EnsureGlobalOrchestratorSessionResult => {
      const row = deps.db
        .query(
          `SELECT scope, topic_id, created_at, updated_at
             FROM global_orchestrator_sessions
            WHERE scope = ?
            LIMIT 1`,
        )
        .get(GLOBAL_ORCHESTRATOR_SCOPE) as RegistryRow | null;

      if (row) {
        const topic = deps.getTopicById(row.topic_id);
        // With the migration's FK this is not expected in a healthy database.
        // Do not silently mint a replacement: the registry remains the source
        // of truth even if an external/manual DB mutation damaged it.
        if (!topic) throw new GlobalOrchestratorSessionIntegrityError(row.topic_id);
        // A user has explicitly opened the coordinator through its canonical
        // Kanban entry point. Restore only the provider identity that this
        // durable role owns, inside the same transaction as the registry
        // lookup. Generic routes still fail closed for a raw corrupted row;
        // this is the deliberate, auditable recovery path.
        //
        // Structural bindings are never repaired: returning a later
        // project-bound edit here would silently recreate ordinary per-board
        // authority for the global session.
        assertGlobalOrchestratorTopicShape(topic);
        if (topic.provider !== "codex") {
          topic.provider = "codex";
          deps.saveTopic(topic);
        }
        assertEligibleGlobalTopic(topic);
        return { topic, created: false };
      }

      const topic = deps.createTopic();
      assertEligibleGlobalTopic(topic);
      // An ensure operation may only mint its own Topic. Registering a
      // pre-existing unbound conversation here would silently grant its normal
      // session the cross-board role, which is precisely what the registry is
      // meant to prevent.
      if (deps.getTopicById(topic.id)) {
        throw new GlobalOrchestratorTopicInvariantError(
          "Global orchestrator factory must create a new Topic",
        );
      }
      deps.saveTopic(topic);

      const timestamp = now();
      deps.db.run(
        `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [GLOBAL_ORCHESTRATOR_SCOPE, topic.id, timestamp, timestamp],
      );
      return { topic, created: true };
    })
    .immediate();
}
