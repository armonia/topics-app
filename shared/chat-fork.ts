/**
 * HOW A CHAT'S MEMORY SURVIVES A FORK, per runtime (CHAT-FORK-03).
 *
 * A fork is a new topic whose history is a copy of the original's active
 * branch. The copy is what the chat SHOWS; what the model REMEMBERS depends on
 * where the runtime keeps its conversation:
 *
 *   - `claude-cli`: in the CLI's session transcript. The branch starts with
 *     `--resume <parent> --resume-session-at <point> --fork-session`.
 *   - `codex-cli`: in the Codex thread. The branch starts with
 *     `codex exec fork <parent thread>`.
 *   - `db-history`: in Topics' own database, reread on every turn (the native
 *     engine, the SDK providers, the direct endpoints). The copy IS the memory.
 *   - `null`: a session of its own outside Topics (openclaw, the ACP agents). A
 *     new session key would open an empty conversation under a chat that shows
 *     a history, so these runtimes do not offer the fork.
 *
 * ONE table, read by the server (on the RESOLVED provider) and by the client
 * (on the topic's column, to decide whether to draw the menu item). The client
 * has no resolved provider: a topic without a pinned provider shows the item
 * and lets the server decide.
 *
 * Direct endpoints are recognised by their name prefix and not by a capability
 * for that same reason: the client has only the name.
 */
import { isDirectProviderName } from "./direct-endpoints";

export type ForkMode = "claude-cli" | "codex-cli" | "db-history";

export function forkModeFor(providerName: string | null | undefined): ForkMode | null {
  if (!providerName) return null;
  if (providerName === "claude-code" || providerName === "claude-code-team") return "claude-cli";
  if (providerName === "codex") return "codex-cli";
  // `topics:<model>` is the legacy spelling of the native engine pinned to a model.
  if (providerName === "topics" || providerName.startsWith("topics:")) return "db-history";
  if (providerName === "claude" || providerName === "openai") return "db-history";
  if (isDirectProviderName(providerName)) return "db-history";
  return null;
}
