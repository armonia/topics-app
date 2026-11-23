/**
 * The shapes the System page and its server routes share: a health problem
 * with the place that fixes it (`GET /api/system/agents-health`), and an issue
 * the agents registry found (`GET /api/agent-config`). Declared once here so the
 * client and the server cannot describe the same answer two ways.
 */
export type HealthSeverity = "error" | "warning";

export type HealthSection = "jobs" | "chats" | "harness" | "memory" | "tools" | "identity" | "rules";

/** Where the person goes to fix it: a section of the agents' area, and the agent to open when the problem belongs to one. */
export interface HealthDestination {
  section: HealthSection;
  agentId?: string;
  /** The thing to focus inside the section (a job id, a topic id, a store id, a server name). */
  ref?: string;
}

export interface HealthProblem<T extends string = string> {
  id: string;
  type: T;
  severity: HealthSeverity;
  /** The problem in English, for logs and for a client that does not know `type`. */
  sentence: string;
  /** The pieces of `sentence` (names, files, reasons), so the client says it in the reader's language. */
  vars?: Record<string, string>;
  destination: HealthDestination;
}

/** A problem the registry found. `type` is set for the ones the system health list reports. */
export interface RegistryIssue {
  agent: string | null;
  text: string;
  type?: "source-contradiction" | "job-without-agent";
  /** Stable key of the thing it is about (a chat key, an account, a channel). */
  ref?: string;
  /** The two places that disagree (`source-contradiction`). */
  sources?: [string, string];
  /** The scheduled jobs concerned (`job-without-agent`). */
  jobs?: { id: string; name: string }[];
}
