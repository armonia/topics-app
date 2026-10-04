/**
 * THE AUDIT FLEET OF THE MODEL PANELS REVISION (2026-10-04, §11), shared by the
 * selector's spec and the providers level's: «with keys» (Claude Code, Claude
 * API, Codex, OpenAI API, Gemini CLI, jcode, an Ollama and an OpenRouter
 * endpoint, goose in error, the Topics engine) and «without keys», plus the 134
 * ids jcode really lists. Handed to the page through the snapshot route and
 * the WS push; no provider is called.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { ProvidersSnapshot, ProviderSnapshotEntry } from "../../../shared/types";

const at = new Date().toISOString();
const CLAUDE_CODE_IDS = [
  "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-haiku-4-5",
  "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5",
];
const OLDER = new Set(["claude-opus-4-8", "claude-opus-4-8[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]", "claude-haiku-3-5"]);
const CODEX = [
  ["gpt-6.1-sol", "GPT-6.1-Sol", "current"], ["gpt-6-astra", "GPT-6-Astra", "current"], ["gpt-6-sol", "GPT-6-Sol", "current"],
  ["gpt-6-luna", "GPT-6-Luna", "current"], ["gpt-5.6-sol", "GPT-5.6-Sol", "older"], ["gpt-5.6-terra", "GPT-5.6-Terra", "older"],
  ["gpt-5.6-luna", "GPT-5.6-Luna", "older"], ["gpt-5.5", "GPT-5.5", "older"],
] as const;
export const JCODE_IDS = readFileSync(resolve(__dirname, "jcode-models.txt"), "utf8").split("\n").map((id) => id.trim()).filter(Boolean);

export const row = (name: string, label: string, models: string[], extra: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry =>
  ({ name, label, status: "ready", isDefault: false, models, capabilities: ["coding-tasks"], requirements: [], fetchedAt: at, ...extra });
export const claudeCode = row("claude-code", "Claude Code", CLAUDE_CODE_IDS, {
  isDefault: true,
  modelInfo: Object.fromEntries(CLAUDE_CODE_IDS.map((id) => [id, { generation: OLDER.has(id) ? "older" : "current" }])),
});
const codex = row("codex", "Codex", CODEX.map(([id]) => id), {
  modelContextWindows: Object.fromEntries(CODEX.map(([id]) => [id, 272000])),
  modelInfo: Object.fromEntries(CODEX.map(([id, label, generation]) => [id, { label, generation }])),
});
export const engine = row("topics", "Topics", ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"]);
export const snapshotOf = (providers: ProviderSnapshotEntry[]): ProvidersSnapshot => ({ generatedAt: at, defaultProvider: "claude-code", providers });

export const KEYS = snapshotOf([
  claudeCode,
  row("claude", "Claude API", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6"], {
    capabilities: ["streaming"], modelInfo: { "claude-opus-4-8": { generation: "older" }, "claude-sonnet-4-6": { generation: "older" } },
  }),
  codex,
  row("openai", "OpenAI API", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.5", "o4-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"], { capabilities: ["streaming"] }),
  row("gemini", "Gemini CLI", ["gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro"]),
  row("jcode", "jcode", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]),
  row("direct-ollama", "Ollama (Mac mini)", ["gpt-oss:20b", "qwen3-coder:30b", "llama3.3:70b", "deepseek-r1:32b", "gemma3:27b"], { capabilities: ["streaming"] }),
  row("direct-openrouter", "OpenRouter", ["anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-2.5-pro", "meta-llama/llama-4-maverick", "mistralai/devstral-medium", "x-ai/grok-4"], { capabilities: ["streaming"] }),
  row("goose", "goose", [], { status: "error", lastError: "goose acp: exited with code 1" }),
  engine,
]);
export const NO_KEYS = snapshotOf([
  claudeCode,
  row("codex", "Codex", [], { status: "unavailable", requirements: [{ key: "codex-login", label: "Codex login", present: false, hint: "codex login" }] }),
  row("gemini", "Gemini CLI", [], { status: "unavailable", requirements: [{ key: "GEMINI_API_KEY", label: "Gemini key", present: false, hint: "export GEMINI_API_KEY=..." }] }),
  row("direct-lmstudio", "LM Studio", [], { status: "error", capabilities: ["streaming"], lastError: "connect ECONNREFUSED 127.0.0.1:1234" }),
  engine,
]);

export async function mockSnapshot(page: Page, snapshot: ProvidersSnapshot) {
  await page.route("**/api/providers/snapshot", (route) => route.fulfill({ json: snapshot }));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(typeof message === "string" && message.includes('"providers:snapshot"')
      ? JSON.stringify({ type: "providers:snapshot", snapshot }) : message));
    socket.onMessage((message) => server.send(message));
  });
}
