/**
 * SYSTEM HEALTH (T7): every problem of the agents' system in ONE list.
 *
 * One type per problem, each with a plain-words sentence, a severity and a
 * destination (the section and, when there is one, the agent to open). The
 * number next to "System" in the sidebar and in the Agents overview is the
 * length of this list, so there is no second counter that can disagree.
 *
 * Nothing is stored: `collectHealth` is recomputed from the sources on every
 * read, which is why a fixed problem is gone on the next read. The memory
 * rules come from `storeProblems` (T6), never re-derived here.
 */
import type { MemoryStore, MemoryStoreProblem } from "../memory/stores";
import { storeProblems } from "../memory/stores";

export type HealthSeverity = "error" | "warning";

export type HealthSection = "jobs" | "chats" | "harness" | "memory" | "tools" | "identity" | "rules";

/** Where the person goes to fix it: a section of the agents' area, and the agent to open when the problem belongs to one. */
export interface HealthDestination {
  section: HealthSection;
  agentId?: string;
  /** The thing to focus inside the section (a job id, a topic id, a store id, a server name). */
  ref?: string;
}

export interface HealthSubject {
  /** What the problem is about, in words: a job name, an agent name, a store id. */
  label: string;
  agentId?: string;
  ref?: string;
  /** Extra words for the types whose sentence needs them (a contradiction names its two sources). */
  detail?: string;
}

interface ProblemType {
  severity: HealthSeverity;
  sentence: (s: HealthSubject) => string;
  destination: (s: HealthSubject) => HealthDestination;
}

const agentOrRef = (section: HealthSection) => (s: HealthSubject): HealthDestination => ({
  section,
  ...(s.agentId ? { agentId: s.agentId } : {}),
  ...(s.ref ? { ref: s.ref } : {}),
});

export const HEALTH_PROBLEM_TYPES = {
  "job-without-agent": {
    severity: "error",
    sentence: (s) => `The scheduled job "${s.label}" has no agent to run it, so it never does anything.`,
    destination: agentOrRef("jobs"),
  },
  "chat-unnamed": {
    severity: "warning",
    sentence: (s) => `A chat has no name (${s.label}), so you cannot tell what it is about.`,
    destination: agentOrRef("chats"),
  },
  "source-contradiction": {
    severity: "warning",
    sentence: (s) => `Two sources say different things: ${s.detail ?? s.label}. Choose which one counts.`,
    destination: agentOrRef("harness"),
  },
  "memory-unreceived": {
    severity: "warning",
    sentence: (s) => `${s.label} holds notes that no agent receives.`,
    destination: agentOrRef("memory"),
  },
  "memory-index-missing": {
    severity: "warning",
    sentence: (s) => `${s.label} has notes but no index, so the agent cannot find them.`,
    destination: agentOrRef("memory"),
  },
  "memory-index-over-limit": {
    severity: "warning",
    sentence: (s) => `The index of ${s.label} is too long: the part past the limit is never read.`,
    destination: agentOrRef("memory"),
  },
  "tool-down": {
    severity: "error",
    sentence: (s) => `The tool server "${s.label}" is down${s.detail ? ` (${s.detail})` : ""}, so agents cannot use it.`,
    destination: agentOrRef("tools"),
  },
  "persona-file-missing": {
    severity: "warning",
    sentence: (s) => `${s.label} is missing ${s.detail ?? "a file"} that describes who it is.`,
    destination: agentOrRef("identity"),
  },
  "rules-single-agent": {
    severity: "warning",
    sentence: (s) => `Your rules live only in ${s.label}: the other agents never read them.`,
    destination: agentOrRef("rules"),
  },
} as const satisfies Record<string, ProblemType>;

export type HealthProblemType = keyof typeof HEALTH_PROBLEM_TYPES;

export interface HealthProblem {
  id: string;
  type: HealthProblemType;
  severity: HealthSeverity;
  sentence: string;
  destination: HealthDestination;
}

export interface HealthAgentInput {
  id: string;
  name: string;
  /** Persona files the agent's folder lacks (`IDENTITY.md`, a soul file). */
  missingPersonaFiles: string[];
  /** The agent's folder carries its own copy of the user's rules. */
  hasOwnRules: boolean;
}

export interface HealthInput {
  agents: HealthAgentInput[];
  stores: MemoryStore[];
  /** Scheduled jobs whose action is an agent run; `agentId` null or unknown = nobody runs it. */
  jobs: Array<{ id: string; name: string; agentId: string | null }>;
  /** Chats a person can see (system chats excluded) with their stored name. */
  chats: Array<{ id: string; name: string | null }>;
  /** Pairs of sources that disagree, already found by the harness reading. */
  contradictions: Array<{ id: string; sources: [string, string]; about: string }>;
  tools: Array<{ name: string; ok: boolean; reason?: string }>;
  /** The shared rules file the whole system reads exists. */
  sharedRulesPresent: boolean;
}

function problem(type: HealthProblemType, key: string, subject: HealthSubject): HealthProblem {
  const def: ProblemType = HEALTH_PROBLEM_TYPES[type];
  return { id: `${type}:${key}`, type, severity: def.severity, sentence: def.sentence(subject), destination: def.destination(subject) };
}

const STORE_PROBLEM_TYPE: Record<MemoryStoreProblem["kind"], HealthProblemType> = {
  unreceived: "memory-unreceived",
  "index-missing": "memory-index-missing",
  "index-over-limit": "memory-index-over-limit",
};

export function collectHealth(input: HealthInput): HealthProblem[] {
  const out: HealthProblem[] = [];
  const names = new Map(input.agents.map((a) => [a.id, a.name]));

  for (const job of input.jobs) {
    if (job.agentId && names.has(job.agentId)) continue;
    out.push(problem("job-without-agent", job.id, { label: job.name, ref: job.id }));
  }

  for (const chat of input.chats) {
    if (chat.name && chat.name.trim()) continue;
    out.push(problem("chat-unnamed", chat.id, { label: chat.id, ref: chat.id }));
  }

  for (const c of input.contradictions) {
    out.push(problem("source-contradiction", c.id, { label: c.about, ref: c.id, detail: `${c.about} (${c.sources[0]} against ${c.sources[1]})` }));
  }

  for (const store of input.stores) {
    for (const p of storeProblems(store)) {
      const owner = store.ownerAgentId;
      out.push(problem(STORE_PROBLEM_TYPE[p.kind], `${store.id}`, {
        label: owner ? `The memory of ${names.get(owner) ?? owner}` : `The memory "${store.id}"`,
        ...(owner ? { agentId: owner } : {}),
        ref: store.id,
      }));
    }
  }

  for (const tool of input.tools) {
    if (tool.ok) continue;
    out.push(problem("tool-down", tool.name, { label: tool.name, ref: tool.name, ...(tool.reason ? { detail: tool.reason } : {}) }));
  }

  for (const agent of input.agents) {
    if (agent.missingPersonaFiles.length === 0) continue;
    out.push(problem("persona-file-missing", agent.id, { label: agent.name, agentId: agent.id, detail: agent.missingPersonaFiles.join(" and ") }));
  }

  const withRules = input.agents.filter((a) => a.hasOwnRules);
  if (!input.sharedRulesPresent && withRules.length === 1 && input.agents.length > 1) {
    const only = withRules[0];
    out.push(problem("rules-single-agent", only.id, { label: only.name, agentId: only.id }));
  }

  return out;
}
