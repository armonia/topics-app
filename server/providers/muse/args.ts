/**
 * The argv used to launch `muse exec` — as a PURE FUNCTION.
 *
 * Same reason as its twin `codex/args.ts`: a third-party CLI's argv is the
 * surface that breaks every release, and while it stays a literal array
 * inside the spawning function, the breakage lands in production instead of
 * CI. No environment or disk reads here: everything comes in through the
 * parameters, so a snapshot test can photograph the list.
 *
 * Decisions (which model, which effort, which session to resume) stay
 * upstream: this file lines them up, it does not make them.
 */

/** What it takes to assemble the argv of a chat turn. */
export interface MuseExecArgsOptions {
  /**
   * Explicit model, or null/undefined to NOT pass the flag.
   * Without `--model` the CLI reads `~/.config/muse/settings.json`, which is
   * where the user already chose (and a hand-written model that does not exist
   * does not fail the turn: the server falls back to the default — measured
   * 06/10 — so always passing it would only be noise).
   */
  model?: string | null;
  /**
   * This topic's muse session, always: a known id to resume, a fresh one
   * (generated upstream) to start. Without `--session-id` the CLI mints a new
   * id every launch and resume would be impossible; with a valid but unknown
   * UUID it CREATES one with that id (measured on echo).
   */
  sessionId: string;
  /** Resolved reasoning tier, or null to leave the CLI default (`high`). */
  reasoningEffort?: string | null;
  /**
   * Root the CLI constrains workspace tools to. Passed explicit even when it
   * matches the child cwd: under launchd the `(cwd default)` default depends
   * on who launched the server, `(explicit)` does not.
   */
  workspace?: string | null;
  /** `full-access` opts into bypass; anything else stays with the CLI approval+sandbox. */
  approvalMode?: string | null;
  /**
   * File the CLI reads the prompt from (`--prompt-file`).
   *
   * `muse exec` does NOT read the prompt from stdin — without a positional
   * PROMPT or `--prompt-file` it exits 2 (`missing prompt`) — and the positional
   * PROMPT hits the argv ceiling (on Linux 128KB per single argument, and a
   * 20-turn transcript exceeds it). The file has no ceilings; the spawner
   * writes and deletes it.
   */
  promptFile: string;
}

/** The argv of a chat turn, fresh or resumed: only the sessionId changes. */
export function buildMuseArgs(opts: MuseExecArgsOptions): string[] {
  // `muse exec --json` is the canonical non-interactive entry: JSONL-only
  // stdout, every `muse: …` on stderr. Verified: 0 non-JSON lines over 13 stdout files.
  const args = ["exec", "--json"];
  // Reminders (`skill-reminder`, `verify-reminder`) are 14 task lines that
  // produce neither text nor tools: noise for a one-shot embedding.
  args.push("--disable-reminders");
  // Truly headless: when a tool asks the human, the question
  // self-cancels instead of hanging the turn with no tty. The provider does
  // not implement `resumeWithToolResponse` (one-shot, no mid-turn stdin),
  // so a question without this flag would be a turn hung until timeout.
  args.push("--user-input-auto-resolve");
  args.push("--session-id", opts.sessionId);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
  if (opts.approvalMode === "full-access") {
    args.push("--disable-approval", "--disable-sandbox");
  }
  args.push("--prompt-file", opts.promptFile);
  return args;
}

/**
 * The argv of a throwaway completion (auto-title, digest, SSE fallback).
 * No `--json`: text is read here, not events. No `--session-id`
 * but `--no-session-log`: a completion is not a conversation and must not
 * leave a session in the log on every call (both flags together are exit 2).
 */
export function buildMuseSingleShotArgs(opts: { model?: string | null; reasoningEffort?: string | null; promptFile: string }): string[] {
  const args = ["exec", "--no-session-log"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
  args.push("--prompt-file", opts.promptFile);
  return args;
}
