/**
 * What a `spawn_agent` child starts with: its model, its profile and its
 * effort, each resolved once, here, from the call, the profile and the parent
 * (SUBAGENT-08, 09, 10). The route passes the result to `createSession`, which
 * turns it into `--model`, `--agent` and `--effort` on the CLI, and answers the
 * caller with the same values, so the parent learns what really started.
 *
 * Before this, the child got no `--model` at all and ran on the CLI default
 * (opus) under every parent, sonnet chats included, and its effort skipped the
 * parent topic's override because the child was created with no topic.
 */
import type { AgentProfile } from "./agent-profiles";

export const SUBAGENT_MODELS = ["inherit", "sonnet", "opus", "fable", "haiku"] as const;
export const SUBAGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Where the model came from: the call, the profile, the parent (`inherit`), or nowhere (CLI default). */
export type ModelSource = "call" | "profile" | "parent" | "default";
export type EffortSource = "call" | "profile" | "parent";

export interface SubagentLaunch {
  /** Passed as `--model`; null leaves the CLI default. */
  model: string | null;
  modelSource: ModelSource;
  /** Why there is no `--model`, in the words the spawn answer carries. */
  modelNote?: string;
  /** Passed as `--agent`. */
  agent: string | null;
  /** Passed as `--effort`; null leaves the CLI's own. */
  effort: string | null;
  effortSource: EffortSource;
  /** The CLI flags, in the order `createSession` appends them. */
  args: string[];
}

/**
 * A model the child, which is always a Claude CLI, can honour: a full Claude id
 * (`claude-sonnet-5-5[1m]`) or one of the CLI's aliases. A GPT or Gemini
 * parent, or an `auto` nobody resolved, has nothing to hand down.
 */
export function isClaudeModel(model: string | null | undefined): boolean {
  const m = (model ?? "").trim().toLowerCase();
  return /^claude-[a-z0-9.-]+(\[1m\])?$/.test(m) || /^(sonnet|opus|haiku|fable)(\[1m\])?$/.test(m);
}

/** The flags of a resolved launch. Shared with `createSession`, which rebuilds them on a resume. */
export function launchArgs(l: { model: string | null; agent: string | null; effort: string | null }): string[] {
  const args: string[] = [];
  if (l.model) args.push("--model", l.model);
  if (l.agent) args.push("--agent", l.agent);
  if (l.effort) args.push("--effort", l.effort);
  return args;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function resolveSubagentLaunch(input: {
  call: { model?: unknown; agentType?: unknown; effort?: unknown };
  profiles: ReadonlyMap<string, AgentProfile>;
  parent: {
    /** The parent's model as stored (`topics.model`) or read (its transcript); null when unknown. */
    model: string | null;
    /** The effort the parent's topic resolves to: its override, then Settings, env and `xhigh`. */
    effort: string | null;
  };
}): { ok: true; launch: SubagentLaunch } | { ok: false; error: string } {
  const { call, profiles, parent } = input;

  const callModel = str(call.model);
  if (callModel && !(SUBAGENT_MODELS as readonly string[]).includes(callModel)) {
    return { ok: false, error: `unknown model "${callModel}": use one of ${SUBAGENT_MODELS.join(", ")}` };
  }
  const callEffort = str(call.effort);
  if (callEffort && !(SUBAGENT_EFFORTS as readonly string[]).includes(callEffort)) {
    return { ok: false, error: `unknown effort "${callEffort}": use one of ${SUBAGENT_EFFORTS.join(", ")}` };
  }
  const agentType = str(call.agentType);
  const profile = agentType ? profiles.get(agentType) : undefined;
  if (agentType && !profile) {
    const known = [...profiles.keys()].sort();
    return {
      ok: false,
      error: `unknown agent_type "${agentType}": ${known.length ? `use one of ${known.join(", ")}` : "no profile is installed in ~/.claude/agents or the project's .claude/agents"}`,
    };
  }

  // The model: the call, then the profile, then the parent (choice 1, `inherit`).
  let model: string | null = null;
  let modelSource: ModelSource = "default";
  let modelNote: string | undefined;
  const profileModel = profile?.model && profile.model !== "inherit" ? profile.model : null;
  if (callModel && callModel !== "inherit") {
    model = callModel;
    modelSource = "call";
  } else if (!callModel && profileModel) {
    model = profileModel;
    modelSource = "profile";
  } else if (parent.model && isClaudeModel(parent.model)) {
    model = parent.model;
    modelSource = "parent";
  } else {
    modelNote = parent.model
      ? `default (parent model ${parent.model} is not a Claude model)`
      : "default (the parent's model is not known)";
  }

  // The effort: the call, then the profile, then the parent's topic chain.
  const profileEffort = profile?.effort && (SUBAGENT_EFFORTS as readonly string[]).includes(profile.effort) ? profile.effort : null;
  let effort: string | null;
  let effortSource: EffortSource;
  if (callEffort) {
    effort = callEffort;
    effortSource = "call";
  } else if (profileEffort) {
    effort = profileEffort;
    effortSource = "profile";
  } else {
    effort = parent.effort;
    effortSource = "parent";
  }

  const agent = profile ? profile.name : null;
  return {
    ok: true,
    launch: {
      model, modelSource, ...(modelNote ? { modelNote } : {}),
      agent, effort, effortSource,
      args: launchArgs({ model, agent, effort }),
    },
  };
}
