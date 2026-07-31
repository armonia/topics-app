// Niente confronto in tempo costante qui, e non è una difesa mancante: il token
// non viene MAI comparato in JS. Si cerca il suo hash PBKDF2 in SQLite
// (`WHERE agent_token_hash = ?`), quindi `timingSafeEqual` era un import senza
// consumatori. Dove un confronto in JS c'è davvero — il pairing token in
// `lib/auth-gate.ts`, i token dei topic via `utils.timingSafeEqualStr` — è
// timing-safe.
import { pbkdf2Sync, randomBytes } from "crypto";
import type { Database } from "bun:sqlite";

const SALT = "topix-agent-salt";
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = "sha256";

export interface AgentAuthResult {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    avatarEmoji: string;
    maxConcurrentTasks: number;
    isBoardLead: boolean;
    gatewaySessionId: string | null;
  };
  isLead: boolean;
}

/**
 * Authenticate an agent by X-Agent-Token header.
 * Updates last_seen_at on every successful auth.
 */
export function authenticateAgent(
  req: Request,
  db: Database
): AgentAuthResult | null {
  const token =
    req.headers.get("x-agent-token") ||
    req.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) return null;

  const hash = hashToken(token);

  const agent = db
    .prepare("SELECT * FROM agent_profiles WHERE agent_token_hash = ?")
    .get(hash) as any;

  if (!agent) return null;

  // Touch presence
  db.prepare("UPDATE agent_profiles SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), agent.id);

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      avatarEmoji: agent.avatar_emoji,
      maxConcurrentTasks: agent.max_concurrent_tasks,
      isBoardLead: !!agent.is_board_lead,
      gatewaySessionId: agent.gateway_session_id || null,
    },
    isLead: !!agent.is_board_lead,
  };
}

/**
 * Hash a raw token using PBKDF2-SHA256 (deterministic).
 */
export function hashToken(token: string): string {
  return pbkdf2Sync(token, SALT, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
}

/**
 * Mint a new agent token. Returns { token, hash }.
 * Store the hash in DB, give the token to the agent.
 */
export function mintAgentToken(): { token: string; hash: string } {
  const token = `topix_${randomBytes(32).toString("hex")}`;
  const hash = hashToken(token);
  return { token, hash };
}
