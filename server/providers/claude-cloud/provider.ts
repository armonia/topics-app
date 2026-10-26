// The `claude-cloud` provider for CHATS: a topic that picks it talks to a Claude Code
// cloud session instead of a CLI on this Mac. Cards do not go through here:
// they run on the «Cloud Claude» node of the remote lane (./node.ts), which can deliver a branch.
//
// No "coding-tasks" among the capabilities: the cloud session has no Topics MCP bridge,
// so it cannot update a card by itself. That way it does not show up in the task pickers.

import type { AIProvider, ChatMessage, CompletionResult, ProviderCapability, ProviderDiagnostic, StreamHandler } from "../types";
import { getTopicWorkspaceForSession } from "../../lib/agent-workspace";
import { CloudApi } from "./api";
import { credsFor } from "./creds";
import { cloudModelFor, resolveGithubSlug } from "./node";
import { runBounded } from "../../lib/bounded-spawn";
import { CloudSessionRunner } from "./session";

export interface ClaudeCloudProviderConfig {
  type: "claude-cloud";
  /** vdm account (auto-N); absent = the account logged into Claude Code. */
  account?: string;
  model?: string;
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  const r = await runBounded(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", timeoutMs: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export class ClaudeCloudProvider implements AIProvider {
  readonly name = "claude-cloud";
  readonly capabilities: Set<ProviderCapability> = new Set(["streaming", "tools", "sessions", "abort"]);
  private runner: CloudSessionRunner;
  private aborts = new Map<string, AbortController>();
  private ready = false;

  constructor(private readonly config: ClaudeCloudProviderConfig) {
    this.runner = new CloudSessionRunner(new CloudApi(credsFor(config.account)));
  }

  get connected(): boolean { return this.ready; }
  start(): void { this.ready = true; }
  stop(): void {
    this.ready = false;
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
  }

  async sendChat(sessionKey: string, message: string, handler: StreamHandler, options?: { model?: string }): Promise<{ runId?: string }> {
    const cwd = getTopicWorkspaceForSession(sessionKey);
    const origin = cwd ? await gitOut(["remote", "get-url", "origin"], cwd) : null;
    const slug = origin ? await resolveGithubSlug(origin) : null;
    if (!slug) {
      handler.onError("claude-cloud: il topic deve stare in un repo con origin su GitHub (la sessione clona da lì)");
      return {};
    }
    // The topic's branch if it is on origin, otherwise the default one: the VM clones from GitHub,
    // not from this disk, so a local-only branch does not exist for it.
    const local = await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], cwd!);
    const pushed = local && local !== "HEAD" ? await gitOut(["ls-remote", "origin", `refs/heads/${local}`], cwd!) : null;
    const revision = pushed ? local! : ((await gitOut(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd!))?.replace(/^origin\//, "") ?? "main");

    const ctrl = new AbortController();
    this.aborts.get(sessionKey)?.abort();
    this.aborts.set(sessionKey, ctrl);
    const runId = crypto.randomUUID();
    void this.runner
      .sendTurn(sessionKey, message, handler, {
        source: { repo: slug, revision },
        deliveryBranch: `claude/chat-${sessionKey.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 24)}`,
        model: cloudModelFor(options?.model ?? this.config.model),
        title: message.slice(0, 60),
        signal: ctrl.signal,
      })
      .then((r) => {
        if (r.outcome === "stalled") handler.onError("claude-cloud: la sessione non manda più eventi da 15 minuti");
        if (r.outcome === "aborted") handler.onAborted?.();
      })
      .catch((err: unknown) => handler.onError(`claude-cloud: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { if (this.aborts.get(sessionKey) === ctrl) this.aborts.delete(sessionKey); });
    return { runId };
  }

  async abort(sessionKey: string): Promise<void> {
    this.aborts.get(sessionKey)?.abort();
  }

  async complete(_messages: ChatMessage[]): Promise<CompletionResult> {
    // A service call (titles, summaries) is not worth a VM: the other providers handle it.
    throw new Error("claude-cloud non fa completamenti di servizio");
  }

  async diagnose(): Promise<ProviderDiagnostic> {
    try {
      await credsFor(this.config.account)();
      return { name: this.name, status: "ready", requirements: [] };
    } catch (err) {
      return { name: this.name, status: "error", requirements: [], lastError: err instanceof Error ? err.message : String(err) };
    }
  }
}
