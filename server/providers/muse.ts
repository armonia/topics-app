/**
 * MuseProvider — wraps the Muse CLI (`muse exec`).
 *
 * Auto-detected when the `muse` (or $MUSE_BIN) binary is present.
 * Auth is delegated to the upstream CLI (`muse login`, OAuth Meta with the
 * token in the macOS keychain); this provider does not handle OAuth or keys.
 *
 * Implementation strategy (mirrors `CodexProvider`):
 *   - One-shot `muse exec --json` per message. Stdout is pure line-buffered
 *     JSONL (`payload_type` + `payload`, see `muse/WIRE.md`); stderr carries
 *     every `muse: …` line and never reaches the UI.
 *   - Resume via `--session-id`, persisted per Topics session in
 *     `muse_sessions`. A stored id whose log dir is gone falls back to fresh
 *     (with history) instead of resuming an empty session the CLI would
 *     silently re-create.
 *   - No usage events exist on the wire (measured 06/10: no `*usage*|*token*`
 *     in 35 events), so turns report duration only.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AIProvider,
  ChatMessage,
  CompletionResult,
  CompletionOptions,
  ProviderCapability,
  ProviderDiagnostic,
  ProviderDoneMessage,
  ProviderRequirement,
  StreamHandler,
} from "./types";
import { probeBinaryPath } from "../utils/executable";
import { isHumanHold } from "../lib/human-hold";
import { armTurnDeadline, type TurnDeadline } from "../lib/turn-deadline";
import { resolveMuseBin } from "../lib/muse-bin";
import { resolveMuseReasoningEffort } from "../lib/topics-agent-prompt";
import { getTopicWorkspaceForSession } from "../lib/agent-workspace";
import { buildMuseArgs, buildMuseSingleShotArgs } from "./muse/args";
import { readMuseModels, readMuseConfiguredModel, museDefaultModel, museContextWindows, museModelInfo } from "./muse/models";
import type { ModelInfo } from "../../shared/types";
import { getDatabase } from "../db";
import { applyJobQuota } from "../services/agent-job-quota";
import { demoteAgentCli } from "./agent-cli-priority";

// ============ Config ============

export interface MuseProviderConfig {
  type: "muse";
  model?: string;
  approvalMode?: "auto" | "full-access";
  defaultWorkspace?: string;
}

// ============ Constants ============

const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
export const KILL_GRACE_MS = 3_000;

/**
 * The turn's 30-minute cap, with the person's time taken out: while a question
 * or a permission is open (`isHumanHold`) it rearms instead of killing, and the
 * turn gets a whole window again once it is answered. Same rule as every other
 * clock that can end a turn (HOLD-01).
 */
export function armMuseTurnTimeout(opts: {
  sessionKey: string;
  onExpired: () => void;
  ms?: number;
  isHumanHold?: (sessionKey: string) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}): { clear: () => void } {
  const held = opts.isHumanHold ?? isHumanHold;
  const deadline: TurnDeadline = armTurnDeadline({
    ms: opts.ms ?? MESSAGE_TIMEOUT_MS,
    isWaitingForHuman: () => held(opts.sessionKey),
    onRearm: () => deadline.noteActivity(),
    onExpired: opts.onExpired,
    ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
    ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { clear: () => deadline.clear() };
}

const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Where the CLI reads auth (`auth.json`), model catalog and session logs,
  // plus the API key that wins over login (`muse login --help`).
  "META_API_KEY", "MUSE_AUTH_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
]);

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

// Binary resolution lives in the shared `lib/muse-bin` resolver so the chat
// provider and the interactive PTY route agree on where muse is.
const resolveMuseBinary = resolveMuseBin;

/** `auth.json` lives under `$XDG_CONFIG_HOME` when set, else `~/.config/muse`. */
export function museAuthPath(): string {
  return process.env.MUSE_AUTH_PATH
    || join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "muse", "auth.json");
}

/**
 * Whether `muse exec` can reach Meta: an API key in env, or a stored login.
 * Reads STRUCTURE only (`providers.meta.mechanism`): the same file carries
 * PII (name, email, avatar URL) that must never be logged.
 */
export function museHasStoredSession(authPath = museAuthPath()): boolean {
  if (process.env.META_API_KEY) return true;
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as { providers?: unknown };
    const providers = parsed.providers && typeof parsed.providers === "object"
      ? parsed.providers as Record<string, unknown> : null;
    const meta = providers?.meta && typeof providers.meta === "object"
      ? providers.meta as Record<string, unknown> : null;
    return !!meta && typeof meta.mechanism === "string" && meta.mechanism.length > 0;
  } catch {
    return false;
  }
}

// ============ Terminal + error extraction (pure, unit-testable) ============

/** Anything into a one-line human string; objects as compact JSON, never thrown. */
function museErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * The run's closing event (`run_terminal`, `muse/WIRE.md`): `terminal` is
 * `completed | failed | cancelled` today, open tomorrow — the caller treats
 * anything but `completed` as a failure. The payload also carries the FULL
 * reply text, the authoritative `result` when the deltas disagree.
 */
export function extractMuseTerminal(
  payload: Record<string, unknown>,
  payloadType: string,
): { status: string; text?: string; reason?: string } {
  const suffix = payloadType.startsWith("run.terminal.") ? payloadType.slice("run.terminal.".length) : "";
  const status = typeof payload.terminal === "string" && payload.terminal ? payload.terminal : (suffix || "unknown");
  const out: { status: string; text?: string; reason?: string } = { status };
  if (typeof payload.text === "string" && payload.text) out.text = payload.text;
  const reason = museErrorText(payload.reason);
  if (reason) out.reason = reason;
  return out;
}

// ============ Persisted session id (`muse exec --session-id`) ============

/**
 * Decide whether a turn resumes the topic's stored Muse session or starts a
 * fresh one. Pure (no DB, no filesystem) so the branch that matters most, "a
 * stale id must fall back cleanly", is unit-testable.
 */
export function resolveMuseInvocation(args: {
  storedSessionId: string | null;
  logExists: boolean;
}): { mode: "resume"; sessionId: string } | { mode: "fresh" } {
  if (args.storedSessionId && args.logExists) {
    return { mode: "resume", sessionId: args.storedSessionId };
  }
  return { mode: "fresh" };
}

/** Read-only lookup of a session's stored muse session id. Never inserts. */
function getMuseSessionId(db: ReturnType<typeof getDatabase>, sessionKey: string): string | null {
  try {
    const row = db
      .prepare(`SELECT muse_session_id FROM muse_sessions WHERE session_key = ?`)
      .get(sessionKey) as { muse_session_id?: string } | undefined;
    return row?.muse_session_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert the session id for `sessionKey`. Called right after spawn: unlike
 * Codex (which learns its thread id from `thread.started`), the sid is OURS —
 * we pass it in — so even an instantly-killed turn leaves a resumable id.
 */
function saveMuseSessionId(db: ReturnType<typeof getDatabase>, sessionKey: string, sessionId: string): void {
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO muse_sessions (session_key, muse_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_key) DO UPDATE SET muse_session_id = excluded.muse_session_id, updated_at = excluded.updated_at`
    ).run(sessionKey, sessionId, now, now);
  } catch {
    // Best-effort: a DB hiccup degrades to "next turn starts fresh", never a
    // crashed turn.
  }
}

/** Drop a stale session id (its log dir is gone) so the next lookup falls back to fresh. */
function forgetMuseSessionId(db: ReturnType<typeof getDatabase>, sessionKey: string): void {
  try {
    db.prepare(`DELETE FROM muse_sessions WHERE session_key = ?`).run(sessionKey);
  } catch { /* nothing to forget if the delete itself fails */ }
}

/**
 * Whether the CLI still holds this session's log (`~/.local/share/muse/
 * sessions/.msp-view-v1/<uuid>/`). This guard is what makes an orphaned sid
 * fall back to fresh WITH history: without it the CLI would silently re-create
 * an EMPTY session under the old id and the turn would run with no memory.
 *
 * Fail-open: when the sessions root itself is missing (a layout we no longer
 * recognise, a wiped data dir) the answer is true and the resume is attempted
 * — the mid-turn fallback below converts a dead resume into one slow turn.
 */
export function museSessionLogExists(sessionId: string): boolean {
  const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local/share");
  try {
    const root = join(dataHome, "muse", "sessions", ".msp-view-v1");
    if (!existsSync(root)) return true;
    return existsSync(join(root, sessionId));
  } catch {
    return true;
  }
}

// ============ Helpers ============

/**
 * Maximum non-system transcript turns to ship on a fresh turn. Muse's resume
 * carries native context server-side, so this only bounds the client-side
 * markdown preamble of a turn that starts a NEW session. System messages are
 * always preserved (pinned context: SOUL.md, project hints, ...).
 */
const MUSE_HISTORY_TURN_CAP = 20;

/**
 * Format a chat transcript as a markdown preamble for a fresh `muse exec`,
 * which otherwise has no memory of prior turns. Kept turns are labelled by
 * role; system messages flow through as `## Context` blocks.
 */
function renderHistoryAsPrompt(history: ChatMessage[]): string {
  const systemMessages = history.filter((m) => m.role === "system");
  const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");

  let truncated = false;
  let kept = conversational;
  if (conversational.length > MUSE_HISTORY_TURN_CAP) {
    kept = conversational.slice(-MUSE_HISTORY_TURN_CAP);
    truncated = true;
  }

  const lines: string[] = ["# Conversation so far"];
  if (truncated) {
    lines.push(
      "",
      `> _(Earlier ${conversational.length - kept.length} turns omitted; only the most recent ${kept.length} are shown.)_`
    );
  }

  for (const m of systemMessages) {
    lines.push("", "## Context", "", m.content);
  }
  for (const m of kept) {
    if (m.role === "user") {
      lines.push("", "## User", "", m.content);
    } else if (m.role === "assistant") {
      lines.push("", "## Assistant", "", m.content);
    }
  }
  return lines.join("\n");
}

// ============ Provider ============

/** Per-turn bookkeeping shared between the JSONL event router and the close
 *  handler. Held both in `sessionState` (keyed by sessionKey, for abort/event
 *  routing) and as a per-spawn local (`turnState`) so an overlapping newer
 *  turn can't swap the state out from under a dying child's close handler. */
interface MuseTurnState {
  /** Set when the user aborted this turn — close handler emits `onAborted` instead of `onError`. */
  aborted: boolean;
  /** Effective turn model (`run.model.configured`), when declared. */
  model?: string;
  /** Wall-clock turn duration captured at close. */
  startedAt: number;
  /** Tool calls seen this turn, keyed by muse task_id. */
  toolTasks: Map<string, { name: string; text: string; started: boolean; closed: boolean }>;
  /** `tool.result` speaks by call_id, everything else by task_id: the link. */
  callToTask: Map<string, string>;
  /** The run-closing event, when it arrives (`run.terminal.*`). */
  terminal?: { status: string; text?: string; reason?: string };
  /** A non-JSON stdout line violates the protocol: warned once. */
  warnedNonJson?: boolean;
}

export class MuseProvider implements AIProvider {
  readonly name = "muse";
  readonly capabilities: Set<ProviderCapability> = new Set([
    "streaming",
    "coding-tasks",
    "tools",
    "sessions",
    "abort",
    // `history` capability tells the chat route to forward the full transcript
    // every turn. A resumed Muse session carries native context server-side,
    // but a FRESH one (and the fresh retry of a dead resume) is a blank CLI:
    // without this it saw only the new message and forgot every prior turn.
    "history",
  ]);
  // Muse resume is native and unbounded, but fresh turns still need the
  // client-side transcript: `history-aware`, like codex. See
  // `server/context/adapt.ts`.
  readonly contextStrategy = "history-aware" as const;

  private config: MuseProviderConfig;
  private started = false;
  private activeChildren = new Map<string, ChildProcess>();
  /** The send waiting for this session's previous `muse exec` to exit (`previousTurnGone`), so a Stop reaches it. */
  private waitingSends = new Map<string, { cancelled: boolean; wake?: () => void }>();
  /**
   * Per-session bookkeeping that survives between event lines and the close
   * handler. Cleared in `child.on("close")`.
   */
  private sessionState = new Map<string, MuseTurnState>();

  constructor(config: MuseProviderConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this.started && resolveMuseBinary() !== null;
  }

  start(): void {
    this.started = true;
    console.log("[muse] Provider started");
  }

  stop(): void {
    this.started = false;
    for (const [, child] of this.activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
    }
    this.activeChildren.clear();
    console.log("[muse] Provider stopped");
  }

  /**
   * The stream watchdog asks about the child that owns THIS turn, not whether
   * some process with a matching pid happens to be alive. `muse exec` is a
   * one-shot child, so the map entry plus an unreported exit is the complete
   * ownership/liveness contract.
   */
  isTurnProcessAlive(sessionKey: string): boolean {
    const child = this.activeChildren.get(sessionKey);
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  /**
   * Is this session ours? Without it `resolveTurnAlive` never asks the probe
   * above, answers "cannot tell", and the stale-stream sweep closes a live
   * `muse exec` three minutes into a silent tool. The entry leaves the map
   * when the child exits, so "ours" is also "a turn of ours is running".
   */
  ownsSession(sessionKey: string): boolean {
    return this.activeChildren.has(sessionKey);
  }

  // --- Streaming chat ---

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[] },
  ): Promise<{ runId?: string; notSent?: boolean }> {
    // ONE `muse exec` PER SESSION AT A TIME. After a Stop the route closes the
    // turn at once, while the child takes up to KILL_GRACE_MS to die: a send
    // right after ("send now") started a second `muse exec --session-id` on
    // the same session, the two appending to the same log. The send waits here
    // for the previous child's exit; stopped meanwhile, it writes nothing.
    if (this.activeChildren.has(sessionKey)) {
      const ticket: { cancelled: boolean; wake?: () => void } = { cancelled: false };
      this.waitingSends.set(sessionKey, ticket);
      try { await this.previousTurnGone(sessionKey, ticket); }
      finally { if (this.waitingSends.get(sessionKey) === ticket) this.waitingSends.delete(sessionKey); }
      if (ticket.cancelled) return { runId: undefined, notSent: true };
    }

    const bin = resolveMuseBinary();
    if (!bin) {
      handler.onError("Muse CLI not found. Install it and run `muse login`.");
      return { runId: undefined };
    }

    const runId = crypto.randomUUID();
    // A turn that names no model inherits settings.json's. No out-of-catalog
    // guard is needed (unlike codex): an unknown `--model` falls back
    // server-side and the turn still succeeds (measured 06/10).
    const explicitModel = options?.model ?? this.config.model ?? undefined;

    const workspace = getTopicWorkspaceForSession(sessionKey) || this.config.defaultWorkspace || process.env.HOME || "/tmp";

    // Force the reasoning-effort tier explicitly — the muse mirror of the
    // `--effort` flag claude-code sessions get. Deterministic under launchd
    // and surfaced as the picker badge (snapshot-manager calls the same
    // resolver). Null means no override at all: the CLI default (`high`) wins.
    let topicEffort: string | null = null;
    try {
      const row = getDatabase().prepare("SELECT effort FROM topics WHERE session_key = ? LIMIT 1").get(sessionKey) as { effort?: string | null } | undefined;
      topicEffort = row?.effort ?? null;
    } catch { /* Unbound sessions retain the global default. */ }
    const reasoningEffort = resolveMuseReasoningEffort({ topicOverride: topicEffort });

    // Decide resume-vs-fresh before building argv: a resumed session lets Muse
    // carry native, unbounded context server-side, so this turn's prompt
    // (built further down) skips the client-side markdown transcript entirely.
    // A stored id whose log dir is gone is treated as absent rather than
    // resumed into the empty session the CLI would silently re-create.
    let db: ReturnType<typeof getDatabase> | null = null;
    try { db = getDatabase(); } catch { /* unit tests / early bootstrap: fresh every time */ }
    const storedSessionId = db ? getMuseSessionId(db, sessionKey) : null;
    const invocation = resolveMuseInvocation({
      storedSessionId,
      logExists: storedSessionId ? museSessionLogExists(storedSessionId) : false,
    });
    const sessionId = invocation.mode === "resume" ? invocation.sessionId : crypto.randomUUID();
    if (db && storedSessionId && invocation.mode === "fresh") {
      // Log gone (pruned, deleted data dir, ...): the stale pointer would
      // otherwise resume an empty session with no memory, forever.
      forgetMuseSessionId(db, sessionKey);
    }

    // The flag list lives in `muse/args.ts`, a pure function under snapshot:
    // it is the surface that breaks every CLI release. The decisions stay
    // here (which model, which effort, which session).
    const history = options?.history ?? [];
    const prompt = invocation.mode === "fresh" && history.length > 0
      ? renderHistoryAsPrompt(history) + "\n\n## Current message\n\n" + message
      : message;
    // `muse exec` does not read the prompt from stdin: it comes from a file
    // (`--prompt-file`, see `muse/args.ts`). Own directory per turn, deleted on close.
    const promptDir = mkdtempSync(join(tmpdir(), "topics-muse-prompt-"));
    const promptFile = join(promptDir, "prompt.md");
    writeFileSync(promptFile, prompt);
    const args = buildMuseArgs({
      model: explicitModel,
      sessionId,
      reasoningEffort,
      workspace,
      approvalMode: this.config.approvalMode,
      promptFile,
    });

    // The same core quota as claude-code and codex, for the same reason: the
    // provider is chosen per INSTALLATION, not per topic, and on a muse
    // machine the dispatcher spawns muse agents — which compile exactly like
    // the others. `buildSafeEnv()` stays the environment of EVERY session; the
    // quota merges ON TOP, and only when this topic is a dispatched task chat.
    const env = buildSafeEnv();
    try {
      const quota = applyJobQuota(getDatabase(), sessionKey, env);
      if (quota != null) {
        console.log(`[muse] job quota for dispatched ${sessionKey}: -j${quota} (rilettura viva attiva)`);
      }
    } catch { /* no fence: the session starts anyway, as it always has */ }

    this.runMuseTurn({
      sessionKey,
      bin,
      args,
      workspace,
      env,
      handler,
      explicitModel,
      invocationMode: invocation.mode,
      sessionId,
      prompt,
      message,
      history,
      reasoningEffort,
      promptDir,
      // A stale session id that survives `resolveMuseInvocation` (log still on
      // disk) can still die mid-turn: the CLI itself rejects it, the log is
      // corrupt, or the account state moved on. Without a fallback the id stays
      // in `muse_sessions` forever and every future turn repeats the same dead
      // resume — the only fix left is a manual DELETE. One fresh retry with the
      // full history turns a permanent break into a slow turn.
      allowResumeFallback: invocation.mode !== "fresh",
    });

    return { runId };
  }

  /**
   * Spawns one `muse exec` child and wires its stdout/stderr/close handlers.
   * Split out of `sendChat` so a resume that dies mid-turn can retry itself
   * once, fresh, without duplicating the spawn/wiring logic — see
   * `allowResumeFallback` below.
   */
  private runMuseTurn(params: {
    sessionKey: string;
    bin: string;
    args: string[];
    workspace: string;
    env: NodeJS.ProcessEnv;
    handler: StreamHandler;
    explicitModel?: string;
    invocationMode: "resume" | "fresh";
    sessionId: string;
    prompt: string;
    message: string;
    history: ChatMessage[];
    reasoningEffort: string | null;
    promptDir: string;
    allowResumeFallback: boolean;
    idPrefix?: string;
  }): void {
    const { sessionKey, bin, args, workspace, env, handler, explicitModel, invocationMode, sessionId, message, history, reasoningEffort, promptDir, allowResumeFallback, idPrefix } = params;

    const child = spawn(bin, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    // A card's CLI steps aside for the person (KANBAN-78); its children inherit.
    demoteAgentCli(sessionKey, workspace, child.pid);
    // Keep a direct handle to THIS turn's state: the maps are keyed by
    // sessionKey and a newer turn overwrites both entries (e.g. the chat
    // route's timeout aborts this turn and the queue moves on while this
    // child is still dying). The close/error handlers below must read their
    // OWN state and only delete map entries they still own — an unconditional
    // delete would strip the NEWER turn's entries, leaving its "stop" button
    // pointing at nothing while the process keeps running.
    const turnState: MuseTurnState = {
      aborted: false,
      startedAt: Date.now(),
      toolTasks: new Map(),
      callToTask: new Map(),
      ...(explicitModel ? { model: explicitModel } : {}),
    };
    // Prepended to every tool id this process reports: the fresh retry of a
    // failed resume feeds the same handler, so its calls land in the same chat
    // message as the resume's. (Kept for parity with codex; muse task ids are
    // UUIDs and do not repeat across processes.)
    void idPrefix;
    this.activeChildren.set(sessionKey, child);
    this.sessionState.set(sessionKey, turnState);
    try { saveMuseSessionId(getDatabase(), sessionKey, sessionId); } catch { /* next turn just starts fresh */ }

    let fullText = "";
    const rl = createInterface({ input: child.stdout! });

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Stdout is pure JSONL by contract (measured: 0 non-JSON lines across 13
      // captures). A stray line is a protocol violation, NOT text: surfacing
      // it as a delta would print tracebacks and paths into the chat.
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        if (!turnState.warnedNonJson) {
          turnState.warnedNonJson = true;
          console.warn(`[muse] non-JSON stdout line ignored (${trimmed.slice(0, 120)})`);
        }
        return;
      }
      const surfaced = this.routeMuseEvent(sessionKey, event, handler, fullText);
      if (surfaced) fullText += surfaced;
    });

    let stderrText = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderrText += d.toString();
      if (stderrText.length > 4096) stderrText = stderrText.slice(-4096);
    });

    const timeout = armMuseTurnTimeout({
      sessionKey,
      onExpired: () => {
        try { child.kill("SIGTERM"); } catch {}
        handler.onError("Muse turn timed out after 30 minutes");
        // SIGKILL fallback if it ignores SIGTERM, so the close handler runs and
        // we don't leak an orphan child. Mirrors abort()'s grace-window guard.
        setTimeout(() => {
          if (this.activeChildren.get(sessionKey) === child) {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, KILL_GRACE_MS);
      },
    });

    child.on("close", (code) => {
      timeout.clear();
      // Owner-scoped cleanup (see turnState above): never strip a newer turn's
      // entries, and read THIS turn's state, not whatever the map holds now.
      if (this.activeChildren.get(sessionKey) === child) this.activeChildren.delete(sessionKey);
      try { rl.close(); } catch {}
      try { rmSync(promptDir, { recursive: true, force: true }); } catch { /* un prompt orfano in tmp: innocuo */ }

      const state = turnState;
      if (this.sessionState.get(sessionKey) === turnState) this.sessionState.delete(sessionKey);

      const terminalFailed = !!state.terminal && state.terminal.status !== "completed";
      const failed = code !== 0 || terminalFailed;

      // A resumed session that dies mid-turn (not a user abort) leaves its
      // stored id pointing at a resume that will fail the exact same way
      // forever, since `resolveMuseInvocation` only drops an id whose LOG DIR
      // is missing, not one whose resume just failed. Forget it and retry once,
      // fresh, with the full history: the turn is slower but no longer
      // permanently broken.
      if (failed && !state?.aborted && invocationMode !== "fresh" && allowResumeFallback) {
        try { forgetMuseSessionId(getDatabase(), sessionKey); } catch { /* next turn just tries resume again */ }
        const freshSessionId = crypto.randomUUID();
        const freshDir = mkdtempSync(join(tmpdir(), "topics-muse-prompt-"));
        const freshFile = join(freshDir, "prompt.md");
        const freshPrompt = history.length > 0
          ? renderHistoryAsPrompt(history) + "\n\n## Current message\n\n" + message
          : message;
        writeFileSync(freshFile, freshPrompt);
        const freshArgs = buildMuseArgs({
          model: explicitModel,
          sessionId: freshSessionId,
          reasoningEffort,
          workspace,
          approvalMode: this.config.approvalMode,
          promptFile: freshFile,
        });
        this.runMuseTurn({
          sessionKey, bin, args: freshArgs, workspace, env, handler, explicitModel,
          invocationMode: "fresh", sessionId: freshSessionId, prompt: freshPrompt, message, history,
          reasoningEffort, promptDir: freshDir,
          allowResumeFallback: false, idPrefix: "retry:",
        });
        return;
      }

      const done: ProviderDoneMessage = {};
      // No usage on the wire (measured 06/10): duration only.
      if (state) done.durationMs = Date.now() - state.startedAt;
      // The terminal event carries the FULL reply: authoritative when the
      // deltas disagree (or never arrived). Else the accumulated deltas.
      const result = (state?.terminal?.text ?? fullText).trim();
      if (result) done.result = result;

      // Aborted by the user (we sent SIGINT). Emit `aborted` rather than
      // `error` so the UI shows the partial assistant text without a red
      // error stub. Falls through to `onDone` if `onAborted` isn't implemented.
      if (state?.aborted) {
        if (handler.onAborted) handler.onAborted(done);
        else handler.onDone(done);
        return;
      }

      if (terminalFailed) {
        const reason = state!.terminal!.reason;
        handler.onError(reason ? `Muse run ${state!.terminal!.status}: ${reason}` : `Muse run ${state!.terminal!.status}`);
        return;
      }

      if (code === 0) {
        // Strict close: a zero exit WITHOUT the terminal event is a truncated
        // stream, not a success — and it is also what makes the
        // `run_terminal → onDone` mapping mutation-catchable (BAR-7). The CLI
        // always closes with `run.terminal.*` (3/3 meta captures + echo).
        if (!state?.terminal) {
          handler.onError("Muse turn ended without a terminal event");
          return;
        }
        handler.onDone(done);
      } else {
        // Sanitize stderr: don't echo full upstream errors to the UI (may leak
        // tokens/paths). Log full tail server-side, surface a generic message.
        const tail = stderrText.trim().split("\n").slice(-3).join("\n");
        if (tail) console.warn(`[muse] exit ${code}: ${tail}`);
        handler.onError(`Muse exited with code ${code}`);
      }
    });

    child.on("error", (err) => {
      timeout.clear();
      // Owner-scoped, same as the close handler.
      if (this.activeChildren.get(sessionKey) === child) this.activeChildren.delete(sessionKey);
      if (this.sessionState.get(sessionKey) === turnState) this.sessionState.delete(sessionKey);
      try { rmSync(promptDir, { recursive: true, force: true }); } catch { /* see above */ }
      handler.onError(err.message);
    });
  }

  // --- Routing for JSONL events from `muse exec --json` ---

  /**
   * Returns the text that was surfaced as a delta (so the caller can keep its
   * cumulative buffer in sync), or `null` if the event didn't produce any.
   * Side effects: invokes the relevant `handler.*` callbacks and mutates the
   * per-session bookkeeping (tool tasks, terminal, model).
   *
   * The dispatch key is `payload_type`; the shapes below are the ones measured
   * on the meta provider on 06/10 (`muse/WIRE.md`). Anything else is ignored
   * (forward-compat): the CLI grows new event kinds every release.
   */
  private routeMuseEvent(
    sessionKey: string,
    event: Record<string, unknown>,
    handler: StreamHandler,
    fullTextRef: string,
  ): string | null {
    const state = this.sessionState.get(sessionKey);
    if (!state) return null;
    const payloadType = typeof event.payload_type === "string" ? event.payload_type : null;
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown> : null;
    if (!payloadType || !payload) return null;

    // The model's text, in N chunks to concatenate (2 on the measured tool
    // turn, 1 on echo and on the simple turn).
    if (payloadType === "run.output.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text.length > 0) {
        handler.onTextDelta(text, fullTextRef + text);
        return text;
      }
      return null;
    }

    // The run's closing event. Recorded, not acted on: the close handler owns
    // the single turn-end decision (`onDone` vs `onError` vs fresh retry), so a
    // failed run cannot emit both here and there.
    if (payloadType.startsWith("run.terminal.")) {
      state.terminal = extractMuseTerminal(payload, payloadType);
      return null;
    }

    // The model actually serving this turn — the only honest label for the
    // context ring the day the CLI falls back mid-turn.
    if (payloadType === "run.model.configured") {
      if (typeof payload.model_id === "string" && payload.model_id) state.model = payload.model_id;
      return null;
    }

    if (payloadType.startsWith("task.lifecycle.")) {
      return this.routeMuseTaskEvent(sessionKey, state, payloadType, payload, handler);
    }

    // The authoritative tool verdict: `call_id`, full `text`, and
    // `correlation_facts{tool_name, outcome}`. It arrives AFTER the task's own
    // `completed` (measured), so normally it is a duplicate to drop; when the
    // task events were lost it is the only trace of the call.
    if (payloadType === "tool.result") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : null;
      const facts = payload.correlation_facts && typeof payload.correlation_facts === "object"
        ? payload.correlation_facts as Record<string, unknown> : null;
      const name = facts && typeof facts.tool_name === "string" && facts.tool_name ? facts.tool_name : "tool";
      const outcome = facts && typeof facts.outcome === "string" ? facts.outcome : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      const taskId = (callId && state.callToTask.get(callId)) || null;
      // A synthetic entry (see below) is keyed by call_id itself, with no
      // callToTask link: without this lookup a repeated verdict doubles.
      const task = taskId ? state.toolTasks.get(taskId) : (callId ? state.toolTasks.get(callId) : undefined);
      if (task) {
        if (task.closed) return null;
        task.closed = true;
        if (!task.started) { task.started = true; handler.onToolStart(taskId!, task.name, undefined); }
        handler.onToolResult(taskId!, text || task.text, outcome !== "success");
        return null;
      }
      // No known task for this call: announce and close at once, so the tool
      // does not vanish from the UI. Keyed by call_id, already closed, so a
      // repeated verdict for the same call is dropped instead of doubling.
      const id = callId || crypto.randomUUID();
      handler.onToolStart(id, name, undefined);
      handler.onToolResult(id, text, outcome !== "success");
      state.toolTasks.set(id, { name, text, started: true, closed: true });
      return null;
    }

    // `runtime.*`, `session.*`, `turn.input.user`, `run.lifecycle.started`,
    // `task.stream.linked`, and everything unknown: ignored.
    return null;
  }

  /**
   * One tool call's life, in task events: `proposed` (`task_kind:
   * "tool.<name>"`) names it, `side_effect_intent` (`operation: "tool:<name>"`,
   * `idempotency_key: "tool:<call_id>"`) links it to the later `tool.result`,
   * `started` runs it, `output` streams `chunk`s, `completed`/`failed` closes
   * it. Non-tool tasks (model turns, reminders) and the phase noise
   * (`accepted`/`scheduled`/`status`) are ignored.
   */
  private routeMuseTaskEvent(
    _sessionKey: string,
    state: MuseTurnState,
    payloadType: string,
    payload: Record<string, unknown>,
    handler: StreamHandler,
  ): string | null {
    void _sessionKey;
    const inner = payload.event && typeof payload.event === "object"
      ? payload.event as Record<string, unknown> : null;
    const taskId = typeof payload.task_id === "string" ? payload.task_id
      : (inner && typeof inner.task_id === "string" ? inner.task_id : null);
    if (!inner || !taskId) return null;

    if (payloadType === "task.lifecycle.proposed") {
      const taskKind = typeof inner.task_kind === "string" ? inner.task_kind : "";
      if (taskKind.startsWith("tool.")) {
        const name = taskKind.slice("tool.".length) || "tool";
        if (!state.toolTasks.has(taskId)) state.toolTasks.set(taskId, { name, text: "", started: false, closed: false });
      }
      return null;
    }

    if (payloadType === "task.lifecycle.side_effect_intent") {
      const op = typeof inner.operation === "string" ? inner.operation : "";
      if (op.startsWith("tool:")) {
        const name = op.slice("tool:".length) || "tool";
        if (!state.toolTasks.has(taskId)) state.toolTasks.set(taskId, { name, text: "", started: false, closed: false });
        const key = typeof inner.idempotency_key === "string" ? inner.idempotency_key : "";
        if (key.startsWith("tool:")) state.callToTask.set(key.slice("tool:".length), taskId);
      }
      return null;
    }

    const task = state.toolTasks.get(taskId);
    // Unknown task (a model turn, a reminder) or an already-closed call: a
    // `failed` here is not the turn's verdict — the terminal event carries that.
    if (!task || task.closed) return null;

    if (payloadType === "task.lifecycle.started") {
      if (!task.started) {
        task.started = true;
        handler.onToolStart(taskId, task.name, undefined);
      }
      return null;
    }

    if (payloadType === "task.lifecycle.output") {
      const chunk = typeof inner.chunk === "string" ? inner.chunk : "";
      if (chunk) {
        task.text += chunk;
        handler.onToolUpdate?.(taskId, task.text);
      }
      return null;
    }

    if (payloadType === "task.lifecycle.completed") {
      task.closed = true;
      // A `completed` without a `started` (lost event): announce first, so the
      // result lands on a row instead of nowhere.
      if (!task.started) { task.started = true; handler.onToolStart(taskId, task.name, undefined); }
      handler.onToolResult(taskId, task.text, false);
      return null;
    }

    if (payloadType === "task.lifecycle.failed") {
      task.closed = true;
      if (!task.started) { task.started = true; handler.onToolStart(taskId, task.name, undefined); }
      handler.onToolResult(taskId, museErrorText(inner.reason), true);
      return null;
    }

    return null;
  }

  // --- Non-streaming completion ---

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult> {
    const bin = resolveMuseBinary();
    if (!bin) return { content: "Muse CLI not found." };

    const prompt = messages
      .map((m) => m.role === "system" ? `[System]\n${m.content}` :
                  m.role === "assistant" ? `[Assistant]\n${m.content}` :
                  m.content)
      .join("\n\n");

    const workspace = this.config.defaultWorkspace || process.env.HOME || "/tmp";

    const promptDir = mkdtempSync(join(tmpdir(), 'topics-muse-prompt-'));
    const promptFile = join(promptDir, "prompt.md");
    writeFileSync(promptFile, prompt);

    // Only forward --model when explicitly configured; otherwise let the CLI
    // pick from settings.json. Mirrors sendChat.
    const args = buildMuseSingleShotArgs({
      model: options?.model ?? this.config.model,
      reasoningEffort: resolveMuseReasoningEffort(),
      promptFile,
    });

    try {
      return await new Promise<CompletionResult>((resolve, reject) => {
        // The installed CLI may be a launcher wrapping a versioned child.
        // Own a group so a deadline closes both and their inherited pipes.
        const ownedGroup = process.platform !== "win32";
        const child = spawn(bin, args, {
          detached: ownedGroup,
          cwd: workspace,
          stdio: ["pipe", "pipe", "pipe"],
          env: buildSafeEnv(),
        });

        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            if (ownedGroup && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { /* The process may already have closed. */ }
        }, Math.min(MESSAGE_TIMEOUT_MS, Math.max(1, options?.timeoutMs ?? MESSAGE_TIMEOUT_MS)));

        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) { reject(new Error("Muse completion timed out")); return; }
          if (code !== 0) {
            if (stderr) console.warn(`[muse] complete exit ${code}: ${stderr.slice(0, 500)}`);
            resolve({ content: `Error: Muse exited with code ${code}` });
            return;
          }
          resolve({ content: stdout.trim() });
        });

        child.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } finally {
      try { rmSync(promptDir, { recursive: true, force: true }); } catch { /* see above */ }
    }
  }

  // --- Abort ---

  /**
   * Cancel the in-flight Muse turn for `sessionKey`.
   *
   * Strategy: SIGINT → let the CLI flush its in-flight events → SIGKILL
   * fallback after a grace window if it doesn't exit cleanly. Marking
   * `aborted: true` on the session state lets the close handler emit
   * `onAborted` (with the partial assistant text) instead of an error stub.
   *
   * We deliberately do NOT clear `activeChildren` here — `child.on("close")`
   * is the single point that owns cleanup. Clearing early would race the
   * final stdout drain and lose post-SIGINT lines.
   */
  /** Resolves when no `muse exec` of this session is alive, or the send is stopped. */
  private async previousTurnGone(sessionKey: string, ticket: { cancelled: boolean; wake?: () => void }): Promise<void> {
    for (;;) {
      const child = this.activeChildren.get(sessionKey);
      if (!child || ticket.cancelled) return;
      await new Promise<void>((resolve) => { ticket.wake = resolve; child.once("close", () => resolve()); });
    }
  }

  async abort(sessionKey: string): Promise<void> {
    // A send waiting for the previous child to exit is the turn being stopped:
    // it never spawns. Its caller closes the stream.
    const waiting = this.waitingSends.get(sessionKey);
    if (waiting) { waiting.cancelled = true; waiting.wake?.(); }
    const child = this.activeChildren.get(sessionKey);
    if (!child) return;
    const state = this.sessionState.get(sessionKey);
    if (state) state.aborted = true;
    try { child.kill("SIGINT"); } catch {}
    setTimeout(() => {
      // Still alive after the grace window? Force-kill so the close handler
      // runs and the user isn't stuck with a phantom stream.
      if (this.activeChildren.get(sessionKey) === child) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, KILL_GRACE_MS);
  }

  /**
   * `/clear`: forget the stored session so the next turn runs a fresh
   * `muse exec` instead of resuming the old session, which would carry every
   * message the user just saw disappear. A turn still running is stopped
   * first, as the user asked to drop it. The log dir stays on disk: it is
   * Muse's history, we just never resume it again.
   */
  async resetSession(sessionKey: string): Promise<void> {
    await this.abort(sessionKey);
    try { forgetMuseSessionId(getDatabase(), sessionKey); } catch { /* no DB: nothing stored to forget */ }
    console.log(`[muse] resetSession: ${sessionKey} starts a new session on the next turn`);
  }

  // --- Diagnostics ---

  async diagnose(): Promise<ProviderDiagnostic> {
    const requirements: ProviderRequirement[] = [];

    const binPath = resolveMuseBinary();
    const probe = binPath
      ? await probeBinaryPath(binPath)
      : { available: false };
    requirements.push({
      key: "muse-cli",
      label: "Muse CLI installed",
      present: probe.available,
      hint: probe.available ? undefined : "Install Muse: https://www.meta.ai/code",
    });

    const session = museHasStoredSession();
    requirements.push({
      key: "muse-session",
      label: "Active Muse session",
      present: session,
      hint: session ? undefined : "Run in terminal: muse login",
    });

    const allOk = requirements.every((r) => r.present);
    return {
      name: this.name,
      // Same convention as claude-code: missing setup → unavailable, not error.
      status: allOk ? "ready" : "unavailable",
      binaryPath: probe.path,
      version: probe.version,
      requirements,
    };
  }

  async listModels(): Promise<string[]> {
    // The CLI caches the user's available models under
    // `$XDG_DATA_HOME/muse/model-catalog/*.json`. Reading it here means the
    // picker shows exactly what the account can call. Empty list signals "use
    // whatever the CLI has configured".
    return readMuseModels().map(model => model.slug);
  }

  /** The window Muse works with, declared from its own cache. */
  contextWindows(): Record<string, number> {
    return museContextWindows(readMuseModels());
  }

  /** Label, description and generation from the same cache. */
  modelInfo(): Record<string, ModelInfo> {
    return museModelInfo(readMuseModels());
  }

  /**
   * The same tier that lands in `--reasoning-effort` every turn: same
   * resolver, so the picker badge never tells a different story.
   * Declared by the provider instead of guessed from the name inside the
   * snapshot manager (see `AIProvider.effortTier`).
   */
  effortTier(): string | undefined {
    return resolveMuseReasoningEffort() ?? undefined;
  }

  /**
   * The default the CLI would pick without `--model`: the configured one
   * in settings.json when the catalog confirms it, otherwise the catalog
   * `is_default`, otherwise the static fallback. Never null: the picker always
   * has a row to show.
   */
  defaultModel(): string | null {
    return museDefaultModel(readMuseConfiguredModel(), readMuseModels());
  }
}
