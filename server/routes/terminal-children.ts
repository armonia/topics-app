import type { AppContext } from "../types";
import { getDatabase } from "../db";
import { warnThrottled } from "../lib/warn-throttled";
import { withoutSuspendKey } from "../lib/terminal-suspend-key";
import fs from "fs";
import { realHome } from "../utils/path-env";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { normalizePromptSnippet, transcriptHasPrompt } from "../lib/claude-subagent-transcript";
import { readAgentProfiles } from "../lib/agent-profiles";
import { getSubagent, setSubagentState } from "../lib/subagent-store";
import { setCliChildStopper } from "../lib/native-subagents";
import { bootChildSweep, childPhase, cliChildPhaseNow, configureSubagentRuntime, reportChildEnd } from "../lib/subagent-runtime";
import { composerHoldsPrompt, promptAsPaste, trustDialogShowing, trustDialogStep } from "../lib/subagent-seed";
import { liveAgentCount } from "../services/agent-census";
import { effectiveDispatchCap, readGlobalCap, computeDispatchCapacity } from "../services/dispatch-capacity";
import { capMode, type DispatchAdmission } from "../../shared/board";
import { resolveAgentRuntime } from "../services/app-settings";
import type { SubAgentExitInfo } from "./subagent-exit";
import { type TerminalSession, sessionSockets, sessions, terminalActivity } from "./terminal-state";
import { readChildTranscriptLines, resolveChildTranscriptSessionId } from "./terminal-subagent-transcript";
import { getTerminalBuffer } from "./terminal-queries";
import { clearTerminalActivity, noteTerminalInput } from "./terminal-activity";
import { sendTerminalKill, sendToBridge } from "./terminal-bridge-send";
import { liveChildrenOf, tryParkSession } from "./terminal-registry";
import { _tracker, branchOfCwd, broadcastTerminalSessions, rosterReconciled } from "./terminal-shared";

// A sub-agent spawned FROM a topic chat (its `parentSessionKey` is `topic:<id>`)
// exits with no one watching: the chat turn that launched it completed long ago,
// so a promise like "ti aggiorno quando consegna" would leave the chat frozen
// forever. The topics router registers a handler (setSubAgentExitHandler) that
// wakes the parent chat by delivering the child's final result as a message, so
// the conversation reaches its end. Type + message-shaping live in a pure module.
let subAgentExitHandler: ((info: SubAgentExitInfo) => void) | null = null;
export function setSubAgentExitHandler(fn: ((info: SubAgentExitInfo) => void) | null): void {
  subAgentExitHandler = fn;
  if (fn && rosterReconciled) bootChildSweep();
}

// What the sub-agent runtime (`lib/subagent-runtime.ts`) needs of the terminal.
configureSubagentRuntime({
  liveChildren: () => [...sessions.values()].filter((s) => !!s.parentSessionKey),
  adoptTranscriptId: (child) => { resolveChildTranscriptSessionId(child); },
  readLines: (child) => readChildTranscriptLines(child),
  branchOf: (cwd) => branchOfCwd(cwd),
  park: (child, idleMs, beforeKill) => {
    const s = sessions.get(child.id);
    if (!s) return false;
    const outcome = tryParkSession(s.id, s, idleMs, 'sotto-agente finito e fermo', { allowSubAgent: true, turnEnded: true, beforeKill, caller: 'subagent-park' });
    // A finished child that stays up costs a CLI in RAM: say why, once in a while.
    if (!outcome.parked) warnThrottled(`subagent:retire:${child.id}`, `[Terminal] finished sub-agent ${child.id} not retired: ${outcome.reason}`);
    return outcome.parked;
  },
  broadcast: () => broadcastTerminalSessions(),
  handler: () => subAgentExitHandler,
});


// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Lets ONE Claude session (the parent/orchestrator) spawn and drive other
// interactive `claude` sessions (children) as sub-agents. Everything reuses the
// existing primitives: createSession (interactive PTY = subscription billing,
// NOT --print/SDK), the bridge write, getTerminalBuffer scrape, and the durable
// .jsonl transcript. The ownership guard is the security control — a parent can
// only touch children whose parentSessionKey == its own sessionKey — so the raw
// by-id /send and /buffer routes stay OFF-limits to the model; only these
// /agents/* routes are exposed via MCP.


/** Count how many spawned-agent ancestors `sessionKey` has (0 = a top-level
 *  orchestrator that was not itself spawned). Walks parentSessionKey chains that
 *  point at known terminal sessions; a chat-topic parent ("topic:..") isn't in
 *  the map, so the walk simply stops there. */
export function spawnedAgentDepth(sessionKey: string): number {
  let depth = 0;
  let cur = sessions.get(sessionKey);
  const seen = new Set<string>();
  while (cur?.parentSessionKey && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = sessions.get(cur.parentSessionKey);
  }
  return depth;
}

/**
 * Il tetto di concorrenza EFFETTIVO della board, letto qui e ora.
 *
 * Stessa coppia di funzioni che usa il tick del dispatcher, e non è una
 * ripetizione evitabile: il tick il suo numero se lo tiene in una closure che
 * questa rotta non vede, e chiedere il tetto a una closure altrui vorrebbe dire
 * legare la porta dello spawn al ciclo del dispatcher. Le due letture si
 * incontrano su `readGlobalCap`, che è l'unico posto dove è scritto cosa vuol
 * dire NULL in quella colonna.
 */
export function boardAgentCap(): number {
  try {
    // Gli agenti VIVI vanno passati: il freno vivo del tetto è un credito sul
    // budget di CPU della flotta, e senza sapere quanti ne stanno già girando
    // il loro costo verrebbe scontato dal tetto totale invece che dai posti
    // residui. È lo stesso conteggio che `boardSpawnRefusal` confronta col
    // tetto due righe più in là, quindi le due letture non possono divergere.
    const db = getDatabase();
    return effectiveDispatchCap(readGlobalCap(db), computeDispatchCapacity(liveAgentCount(db, null), undefined, resolveAgentRuntime() === "cli").recommended);
  } catch {
    // Nessuna lettura possibile: si torna al default del menu (3). Un tetto
    // sconosciuto non autorizza a non averne uno.
    return 3;
  }
}

/**
 * What the dispatcher's gate would answer for ONE SUB-AGENT right now, injected
 * by `server.ts` (the dispatcher is born after this router). Absent = the
 * machine cannot be asked, which the door reads as "let it through", like the
 * dispatcher without a sample.
 */
let childAdmissionPreview: (() => DispatchAdmission | null) | null = null;
export function setChildAdmissionPreview(fn: (() => DispatchAdmission | null) | null): void {
  childAdmissionPreview = fn;
}

/**
 * The mode the spawn door asks in. "By resources" ignores the number of agents
 * (so a card holding the whole machine cannot make every child a 429, and a
 * lone card cannot open three more unchecked) and asks the machine, with the
 * price of a child; "count" keeps the cap. An unreadable mode reads as count.
 */
export function boardSpawnMode(): { resources?: { admission: DispatchAdmission | null } } {
  try {
    if (capMode(readGlobalCap(getDatabase())) !== "resources") return {};
  } catch { return {}; }
  let admission: DispatchAdmission | null = null;
  try { admission = childAdmissionPreview?.() ?? null; } catch { /* unmeasurable: lets it through */ }
  return { resources: { admission } };
}

/**
 * A chat's live CLI children for the strip under the chat (chat-live-work): the
 * phase read now (off the transcript after a restart, never on trust) and the
 * tool the hooks say it is running. `routes/live-work.ts` makes the rows.
 */
export function liveCliChildren(parentSessionKey: string) {
  const db = getDatabase();
  return liveChildrenOf(parentSessionKey).map((s) => {
    const row = getSubagent(db, s.id);
    const tool = s.claudeSessionId ? _tracker?.getSession(s.claudeSessionId)?.lastTool : undefined;
    return {
      id: s.id, name: row?.name ?? s.name, createdAt: row?.createdAt ?? s.createdAt,
      phase: row ? cliChildPhaseNow(row) : childPhase(s.id),
      busy: terminalActivity.get(s.id)?.busy ?? false,
      reportedAt: row?.reportedAt ?? null,
      tool: tool ? { name: tool.name, input: tool.input as unknown } : null,
    };
  });
}

/**
 * The home whose `.claude/agents` the profiles are read from. The real home in
 * production; a test points it at a fake one, as it does the bridge socket.
 */
let agentProfilesHome: string | null = null;
export function _setAgentProfilesHome(home: string | null): void {
  agentProfilesHome = home;
}
export function agentProfilesFor(cwd: string) {
  return readAgentProfiles({ home: agentProfilesHome ?? realHome(), cwd });
}

/** An ended child of this parent, shaped as a session so `read_agent` reads its transcript. */
export function endedChildForRead(parentKey: string, agentId: string): TerminalSession | null {
  const row = getSubagent(getDatabase(), agentId);
  if (!row || row.parentSessionKey !== parentKey) return null;
  return {
    id: row.id, name: row.name, nameSource: "user", createdAt: row.createdAt, cwd: row.cwd, command: "claude",
    cols: 120, rows: 30, type: "claude-code", skipPermissions: true,
    claudeSessionId: row.claudeSessionId ?? undefined, parentSessionKey: row.parentSessionKey,
  };
}

/** The 404 of the agent routes. An id shaped like the CLI's built-in Agent tool
 *  (`a` + 16-17 hex) is said to be one: 11 `read_agent` calls passed such an
 *  id and read a bare "not found" they could not act on. */
export function subAgentNotFound(agentId: string): string {
  return /^a[0-9a-f]{16,17}$/.test(agentId)
    ? `sub-agent not found: "${agentId}" is the id of a built-in Agent tool call, not a spawn_agent agentId`
    : "sub-agent not found";
}

/** Ended children a `send_to_agent` is bringing back right now. */
export const childrenBeingResumed = new Set<string>();

/** Resolve a child the caller is allowed to drive, or null. The caller MUST be
 *  the child's recorded parent — this is the orchestrator's whole auth model. */
export function resolveOwnedChild(parentSessionKey: string, agentId: string): TerminalSession | null {
  const child = sessions.get(agentId);
  if (!child || child.parentSessionKey !== parentSessionKey) return null;
  return child;
}

/**
 * `stop_agent` on a live CLI child: the PTY goes, its turn is reported as
 * stopped by the parent (which wakes nobody). Returns its branch, read before
 * the kill. Also the CLI half of stopping a native child's whole tree.
 */
export function stopLiveCliChild(child: TerminalSession, caller: string): string | null {
  const childClaudeId = child.claudeSessionId;
  // Read BEFORE the kill: afterwards the session is gone and the branch
  // would be unrecoverable for whoever just asked for the stop. The
  // directory is NOT deleted here: the sweep decides (WORKTREE-09/10).
  const childBranch = branchOfCwd(child.cwd);
  sendTerminalKill(child.id, 'subagent-stop', caller);
  sessions.delete(child.id);
  const sockets = sessionSockets.get(child.id);
  if (sockets) {
    for (const ws of sockets) { try { ws.close(1000, "Sub-agent stopped"); } catch { /* the websocket may already be closed */ } }
    sessionSockets.delete(child.id);
  }
  try { getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [child.id]); }
  catch (e) { warnThrottled("terminal_sessions:subagent-stop", `[Terminal] terminal_sessions: deleting the row of stopped sub-agent ${child.id} failed:`, e); }
  if (childClaudeId) _tracker?.dropTerminalSession(childClaudeId);
  clearTerminalActivity(child.id);
  broadcastTerminalSessions();
  // Reaping a sub-agent via /stop is the primary way an orchestrator ends a
  // delegated task — report its turn here, because the pre-delete above
  // makes the bridge `exit` frame unable to (session gone).
  reportChildEnd(child, null, 'stopped');
  return childBranch;
}

// A native child's tree stop reaches its CLI children through here.
setCliChildStopper((id) => {
  const child = sessions.get(id);
  if (child) { stopLiveCliChild(child, 'native-child-stop'); return; }
  // A parked CLI child has no process: its row only closes.
  const row = getSubagent(getDatabase(), id);
  if (row && (row.state === "running" || row.state === "retired")) setSubagentState(getDatabase(), id, "stopped");
});

/**
 * `spawn_agent` creates an interactive Claude PTY. Codex bridge-only topics
 * cannot use that runtime, including through an old MCP tools/list response or
 * a direct HTTP request that bypasses the bridge profile filter.
 */
export function isCodexBridgeOnlyTopic(ctx: AppContext, sessionKey: string): boolean {
  try {
    const topic = ctx.db
      .query("SELECT provider, mcp_policy FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { provider?: string | null; mcp_policy?: string | null } | null;
    return topic?.provider === "codex" && topic.mcp_policy === "bridge-only";
  } catch {
    // Keep legacy/unmigrated databases on their established route behavior.
    return false;
  }
}

/**
 * Prompt bytes actually typed into a seeded child: filtered once with the
 * child session type. The filtered text drives both the typing and the echo
 * checks, so a prompt carrying ctrl+z cannot loop on retyping: the echo
 * probe looks for what was really written.
 */
export function seedPromptForSession(sessionType: string | undefined, prompt: string): string {
  return withoutSuspendKey(sessionType, prompt);
}

/** The transcript fingerprint must match the text the terminal actually received. */
export function seedPromptFingerprintForSession(sessionType: string | undefined, prompt: string): string {
  return normalizePromptSnippet(seedPromptForSession(sessionType, prompt));
}

type SeedPromptHandlerForTests = (childId: string, prompt: string, acceptSnippet?: string) => void | Promise<void>;
let seedPromptHandlerForTests: SeedPromptHandlerForTests | null = null;

/** Replace the asynchronous PTY seeder in route tests so they can inspect its inputs. */
export function _setSeedPromptHandlerForTests(handler: SeedPromptHandlerForTests | null): void {
  seedPromptHandlerForTests = handler;
}

/** Seed a freshly-spawned `claude` TUI with its first prompt. The TUI isn't
 *  ready to accept input the instant the PTY spawns, and Enter must arrive as a
 *  separate frame to submit — so we bounded-poll the scrollback for a readiness
 *  signal, then write the prompt and (after a beat) a lone CR. Fire-and-forget:
 *  the child runs async; the parent reads its output via read_agent. */

export async function seedAgentPrompt(childId: string, prompt: string, acceptSnippet?: string): Promise<void> {
  if (seedPromptHandlerForTests) {
    await seedPromptHandlerForTests(childId, prompt, acceptSnippet);
    return;
  }
  const typedPrompt = seedPromptForSession(sessions.get(childId)?.type, prompt);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const READY_HINTS = ["for shortcuts", "│ >", "╭─", "Bypassing", "Welcome to Claude"];

  // --- Readiness: wait for the input box to be drawn (best-effort, ~8s cap). ---
  let lastLen = -1, stableCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (!sessions.has(childId)) { console.warn(`[Terminal] seedAgentPrompt: ${childId} exited before its composer appeared`); return; }
    const buf = await getTerminalBuffer(childId);
    // Before READY_HINTS: the dialog's `╭─` borders satisfy them too (lib/subagent-seed.ts).
    if (buf && trustDialogShowing(buf)) {
      if (!(await acceptTrustDialog(childId))) return;
      lastLen = -1; stableCount = 0;
      continue;
    }
    if (buf && READY_HINTS.some(h => buf.includes(h))) break;
    if (buf.length > 0 && buf.length === lastLen) { if (++stableCount >= 2) break; }
    else stableCount = 0;
    lastLen = buf.length;
  }
  if (!sessions.has(childId)) return;

  // --- Phase 1: get the prompt TEXT actually into the composer. ---
  // The fragile part: a `write` sent before claude has installed its raw-mode
  // input handler (still spawning / loading MCP servers) is dropped on the floor
  // — nothing lands in the box, and no amount of later Enters can submit an empty
  // composer, so the sub-agent sits idle FOREVER and the chat that delegated to
  // it hangs waiting for a result that never comes (the ~1h55 freeze). So we type
  // and then VERIFY the text echoed back, re-typing (only when it's absent) until
  // it sticks. We never re-type once it's present, to avoid a doubled turn.
  let echoed = false;
  for (let attempt = 0; attempt < 6 && !echoed; attempt++) {
    if (!sessions.has(childId)) return;
    // The composer shows either the prompt's opening or, for a long one, a
    // `[Pasted text]` placeholder: both mean it is there (lib/subagent-seed.ts).
    if (!composerHoldsPrompt(await getTerminalBuffer(childId), typedPrompt)) {
      noteTerminalInput(childId);
      // As a paste: a plain write over 1022 bytes lost its head (lib/subagent-seed.ts).
      sendToBridge({ type: "write", id: childId, data: promptAsPaste(typedPrompt) });
    }
    for (let i = 0; i < 6; i++) { // ~1.8s for the echo to render
      await sleep(300);
      if (!sessions.has(childId)) return;
      if (composerHoldsPrompt(await getTerminalBuffer(childId), typedPrompt)) { echoed = true; break; }
    }
  }
  if (!echoed) {
    // Never confirmed the echo (unusual composer, or a buffer we can't scrape).
    // Fire it blind so we still try rather than strand the agent, then submit.
    noteTerminalInput(childId);
    sendToBridge({ type: "write", id: childId, data: promptAsPaste(typedPrompt) });
    await sleep(300);
  }

  // --- Phase 2: submit and CONFIRM acceptance; re-Enter only (never re-type). ---
  // Acceptance = the child's transcript now exists (claude wrote the opening user
  // turn), which also adopts the real claude-minted session id early. Re-Entering
  // (not re-typing) is safe against duplicating the turn if an Enter was swallowed
  // (bracketed-paste mode) while the composer still holds our text.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!sessions.has(childId)) return;
    noteTerminalInput(childId);
    sendToBridge({ type: "write", id: childId, data: "\r" });
    for (let i = 0; i < 12; i++) { // ~6s
      await sleep(500);
      const child = sessions.get(childId);
      if (!child) { console.warn(`[Terminal] seedAgentPrompt: ${childId} exited before accepting its prompt`); return; }
      if (childPromptAccepted(child, acceptSnippet)) return; // ✅ landed
    }
  }
  console.warn(`[Terminal] seedAgentPrompt: ${childId} never acknowledged its prompt (echoed=${echoed})`);
}

/** Accept the CLI's folder-trust dialog for a sub-agent: move `❯` onto «Yes» and
 *  only then press Enter (Enter on the default «No, exit» kills the child). The
 *  cwd was chosen by the parent agent, which already runs with full shell access
 *  there, so trusting it gives the child nothing the parent lacks. */
async function acceptTrustDialog(childId: string): Promise<boolean> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let step = 0; step < 14; step++) { // ~7s: the CLI drops keys until its handler is installed
    if (!sessions.has(childId)) return false;
    const next = trustDialogStep(await getTerminalBuffer(childId));
    if (next === "accept") {
      console.warn(`[Terminal] seedAgentPrompt: ${childId} hit the folder-trust dialog in its cwd, accepting it`);
      noteTerminalInput(childId);
      sendToBridge({ type: "write", id: childId, data: "\r" });
      await sleep(500);
      return true;
    }
    if (next === "down") {
      noteTerminalInput(childId);
      sendToBridge({ type: "write", id: childId, data: "\x1b[B" }); // arrow down
    }
    await sleep(500);
  }
  console.warn(`[Terminal] seedAgentPrompt: ${childId} is stuck on the folder-trust dialog, cursor never reached «Yes»; not pressing Enter`);
  return false;
}

/** True once a sub-agent has actually accepted its prompt: its transcript holds
 *  the user record carrying it. The file alone proves nothing, the CLI writes
 *  it at start-up (see `transcriptHasPrompt`). Runs discovery first, which also
 *  adopts the real session id, so the check doubles as early id-capture. */
function childPromptAccepted(child: TerminalSession, acceptSnippet?: string): boolean {
  resolveChildTranscriptSessionId(child);
  if (!child.claudeSessionId) return false;
  try {
    const lines = fs.readFileSync(claudeTranscriptPath(child.cwd, child.claudeSessionId), 'utf-8').split('\n');
    // A resumed child's transcript already holds its first prompt: the input
    // that resumed it is the one to look for.
    return transcriptHasPrompt(lines, acceptSnippet ?? child.spawnPromptSnippet ?? '');
  } catch {
    return false;
  }
}

