import type { APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:13334";

export interface SeedToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status?: "pending" | "running" | "success" | "error";
  result?: string;
  error?: string;
  contentOffset?: number;
}

export interface SeedMessageOpts {
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: SeedToolCall[];
  media?: string[];
  thinking?: string;
  id?: string;
  parentId?: string;
  /** Branch index for sibling messages under the same parent (default 0). */
  branchIndex?: number;
  timestamp?: string;
  // Slice 7 — per-message footer metadata. All optional; null/missing means
  // the row renders no footer.
  latencyMs?: number;
  usagePromptTokens?: number;
  usageCompletionTokens?: number;
  costCents?: number;
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
