import type { APIRequestContext } from "@playwright/test";
import { E2E_BASE } from "./test-server";

const BASE = E2E_BASE;

export interface SeedToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status?: "pending" | "running" | "success" | "error" | "waiting_for_input";
  result?: string;
  error?: string;
  /** Persisted verbatim by the seed endpoint. With status "waiting_for_input"
   *  this drives the clickable <ToolInputForm> panel on load (AskUserQuestion /
   *  the mcp__topics__ask_user_question bridge tool). */
  userInputSchema?: unknown;
  contentOffset?: number;
  /** Real-usage window bounds (epoch ms) — drive duration rendering. */
  startedAt?: number;
  endedAt?: number;
  /** Per-action attribution: cost in cents and tokens of the model call that
   *  decided this tool. Drive the per-row cost readout. */
  costCents?: number;
  tokens?: number;
}

export interface SeedMessageOpts {
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: SeedToolCall[];
  media?: string[];
  thinking?: string;
  id?: string;
  /** Parent message id. Omit → the seed endpoint defaults it to the session's
   *  LAST message (keeps linear threads linked). Pass `null` EXPLICITLY to force
   *  a real root (parent_id NULL) — needed to seed sibling-root edit branches;
   *  omitting it would instead chain the message onto the previous one. */
  parentId?: string | null;
  /** Branch index for sibling messages under the same parent (default 0). */
  branchIndex?: number;
  timestamp?: string;
  // Slice 7 — per-message footer metadata. All optional; null/missing means
  // the row renders no footer.
  latencyMs?: number;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  costCents?: number;
  /** Scorporo della cache. Assente ≠ 0: assente = "non riportato dal provider". */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation1hTokens?: number;
}

/** Seed a message directly into the test server's database */
export async function seedMessage(
  request: APIRequestContext,
  opts: SeedMessageOpts
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/test/seed-message`, {
    data: opts,
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) {
    const text = await res.text();
    throw new Error(`Failed to seed message: ${res.status()} ${text}`);
  }
  return res.json() as Promise<{ id: string }>;
}
