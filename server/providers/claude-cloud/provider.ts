// Il provider `claude-cloud` per le CHAT: un topic che lo sceglie parla con una sessione
// cloud di Claude Code invece che con una CLI su questo Mac. Le card non passano di qui:
// girano sul nodo «Cloud Claude» della corsia remota (./node.ts), che sa consegnare un ramo.
//
// Niente "coding-tasks" fra le capacità: la sessione cloud non ha il ponte MCP di Topics,
// quindi non può aggiornare una card da sé. Così non compare nei picker dei task.

import type { AIProvider, ChatMessage, CompletionResult, ProviderCapability, ProviderDiagnostic, StreamHandler } from "../types";
import { getTopicWorkspaceForSession } from "../../lib/agent-workspace";
import { CloudApi } from "./api";
import { credsFor } from "./creds";
import { cloudModelFor, githubSlug } from "./node";
import { CloudSessionRunner } from "./session";

export interface ClaudeCloudProviderConfig {
  type: "claude-cloud";
  /** Account di vdm (auto-N); assente = l'account loggato in Claude Code. */
  account?: string;
  model?: string;
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
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
    const slug = origin ? githubSlug(origin) : null;
    if (!slug) {
      handler.onError("claude-cloud: il topic deve stare in un repo con origin su GitHub (la sessione clona da lì)");
      return {};
    }
    // Il ramo del topic se è su origin, altrimenti quello di default: la VM clona da GitHub,
    // non da questo disco, quindi un ramo solo locale non esiste per lei.
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
    // Una chiamata di servizio (titoli, riassunti) non vale una VM: la fanno gli altri provider.
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
