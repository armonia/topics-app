import type { AppContext, RouteHandler } from "../types";
import type { TerminalSessionType } from "../../shared/terminal-session-types";
import { spawn } from "child_process";
import { resolve, basename, dirname, join } from "path";
import { createInterface } from "readline";
import { getDatabase } from "../db";
import { shouldCompressFrame } from "../lib/ws-compression";
import { createHash } from "crypto";
import net from "net";
import fs from "fs";
import { tmpdir } from "os";
import { augmentPath, realHome } from "../utils/path-env";
import { timingSafeEqualStr } from "../utils";
import { readState } from "../services/daemon-state";
import { resolveCodexBin } from "../lib/codex-bin";
import { envDataDir } from "../lib/data-dir";
import { resolveClaudeBin } from "../lib/claude-bin";
import { resolveKimiBin } from "../lib/kimi-bin";
import { discoverCodexSessionId, codexRolloutExists, codexRolloutPath } from "../lib/codex-session";
import { deriveCodexSessionTitle } from "../lib/codex-transcript-title";
import { discoverOpencodeSessionId, deriveOpencodeSessionTitle } from "../lib/opencode-session";
import { classifyFrame, countsAsActivity, isInputEcho, isResizeRepaint } from "../lib/pty-activity";
// The same verdict the AI bridge already reached for the same question: a late
// pong is not a dead daemon if bytes are still arriving. See `startBridgeWatchdog`.
import { bridgeWatchdogStep } from "../lib/bridge-watchdog";
import { createIdempotencyCache } from "../lib/idempotency-cache";
import { isClientCwdAccepted } from "../lib/broad-cwd";
import { registerFleetSocket, registerFleetSessionSource } from "../lib/fleet-usage";
import { listSessionCliPids } from "../providers/session-pids";
import { decidePark, idleParkThresholdMs, summarizeRefusals } from "../lib/terminal-idle-park";
import type { ParkRefusal } from "../lib/terminal-idle-park";
import { decideOnRestart } from "../lib/terminal-restart-policy";
import { recordRetirement } from "../services/retirement";
import { renderScreen, screenToText } from "../lib/terminal-screen";
import type { ClaudeSessionTracker } from "../lib/claude-session-tracker";
import { writeMcpConfigForSession, cleanupMcpConfigForSession } from "../providers/claude-code";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { discoverClaudeSubAgentSessionId, normalizePromptSnippet } from "../lib/claude-subagent-transcript";
import { boardSpawnRefusal, liveAgentCount } from "../services/agent-census";
import { effectiveDispatchCap, readGlobalCap, computeDispatchCapacity } from "../services/dispatch-capacity";
import { resolveAgentRuntime } from "../services/app-settings";
import { deriveClaudeSessionTitle } from "../lib/claude-transcript-title";
import { parseJsonlLine, splitJsonlChunk } from "../lib/claude-session-state";
import { topicsAgentSystemPrompt, resolveClaudeEffort, resolveCodexReasoningEffort, topicEffortFor } from "../lib/topics-agent-prompt";
import type { SubAgentExitInfo } from "./subagent-exit";
export type { SubAgentExitInfo } from "./subagent-exit";

interface TerminalSession {
  id: string;
  name: string;
  /** How `name` was set: 'default' (the generated "Terminal N"), 'auto'
   *  (derived from the Claude session's evolving topic — still refreshable), or
   *  'user' (a manual rename, frozen so auto-naming won't overwrite it). */
  nameSource: 'default' | 'auto' | 'user';
  createdAt: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  topicId?: string;
  type: TerminalSessionType;
  skipPermissions: boolean;
  claudeSessionId?: string;
  /** OS pid of the PTY's root process (reported by the bridge on create /
   *  reattach). Used by the process detector to attribute listening ports
   *  started under this session to it. */
  ptyPid?: number;
  /** sessionKey of the orchestrator that spawned this session as a sub-agent
   *  (see routes `/api/sessions/:sessionKey/agents/*`). Undefined for every
   *  human-/chat-created session. The ownership guard keys off this so a parent
   *  can only drive the children it spawned, and the UI nests them under it. */
  parentSessionKey?: string;
  /** Normalised fingerprint of a sub-agent's opening prompt, kept so the
   *  transcript-discovery (which matches the child's real .jsonl by its first
   *  user turn — claude-code ignores our pre-assigned --session-id) can run at
   *  spawn AND as a self-healing fallback in the wake path. Sub-agents only. */
  spawnPromptSnippet?: string;
}

/** Un id di sessione Claude finisce dritto in un argv (`--resume <id>`): passa
 *  solo se ha la forma di un uuid, mai una stringa arbitraria dal body. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * L'id da riprendere quando si apre un NUOVO pane terminale, o `undefined` per
 * partire da una sessione nuova.
 *
 * `createSession` sa già fare le due cose (`--resume <id>` se l'id c'è,
 * `--session-id <nuovo>` altrimenti), ma l'handler POST passava `undefined` e
 * basta: il client l'id lo mandava (`closedTabRecord.ts`) e il server lo
 * buttava. Riaprire una tab Claude Code chiusa faceva così ripartire una
 * sessione VUOTA con lo stesso aspetto — e non c'era modo di dire "apri QUESTA
 * sessione come pane terminale", pur avendone l'id.
 *
 * Due condizioni, nessuna delle due cosmetica:
 *  • solo per i tipi claude — su una shell un id di sessione non significa
 *    niente, e passarlo avvierebbe un `--resume` a un binario che non lo sa
 *    leggere;
 *  • solo se è un uuid — questo valore arriva da un body HTTP e finisce in un
 *    argv.
 */
export function resumeIdForNewSession(
  raw: unknown,
  sessionType: TerminalSessionType,
): string | undefined {
  if (sessionType !== 'claude-code' && sessionType !== 'claude-code-team') return undefined;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return undefined;
  if (!UUID_RE.test(id)) {
    console.warn(`[Terminal] claudeSessionId ignorato: non è un uuid`);
    return undefined;
  }
  return id;
}

const sessions = new Map<string, TerminalSession>();
const sessionSockets = new Map<string, Set<any>>();
// Ids with an in-flight POST /reload, to reject a concurrent second reload of the
// same session (double right-click → "Ricarica", two clients) that would race the
// kill→recreate sequence.
const reloadingSessionIds = new Set<string>();
// Same guard for POST /revive, and it is not optional decoration. `/revive` had
// none, so two clients clicking the dormant tab together (or a client retrying a
// slow request) both passed the `status = 'dormant'` read and both called
// `createSession` for the SAME id: two PTYs, one map entry. The bridge `exit`
// frame is keyed by id alone, with no pid or generation, so the FIRST of the two
// to die tore down the survivor — closing its sockets and deleting its row — and
// the surviving PTY then existed in neither the session map nor the DB.
//
// It holds the in-flight PROMISE, not just the id, and that is the whole
// difference: the loser AWAITS the winner and gets the same session back. When
// this was a Set the loser got a 409, which no caller could tell apart from a
// real failure — `closedTabRecord.reopenClosedTab` fell through to
// `POST /api/terminal/sessions` and minted a SECOND terminal (the "two tabs, one
// full one empty" duplication its own comment warns about), and
// `SingleTerminalPane`'s auto-revive gave up and left the "Sessione scaduta"
// overlay on a session that was coming back at that very moment, with nothing to
// re-trigger it. Serialisation is a server-side concern; making every client
// implement a retry for it is how one of them gets it wrong.
const revivingSessions = new Map<string, Promise<TerminalSession>>();

// A sub-agent spawned FROM a topic chat (its `parentSessionKey` is `topic:<id>`)
// exits with no one watching: the chat turn that launched it completed long ago,
// so a promise like "ti aggiorno quando consegna" would leave the chat frozen
// forever. The topics router registers a handler (setSubAgentExitHandler) that
// wakes the parent chat by delivering the child's final result as a message, so
// the conversation reaches its end. Type + message-shaping live in a pure module.
let subAgentExitHandler: ((info: SubAgentExitInfo) => void) | null = null;
export function setSubAgentExitHandler(fn: ((info: SubAgentExitInfo) => void) | null): void {
  subAgentExitHandler = fn;
}

// A terminal can open a browser pane (contextId `term-<id>`). Deleting the
// terminal session must also tear that browser down, else the context lived on
// after its owner was gone (a `term-*` Playwright context found alive exactly
// this way). terminal.ts has no browserService handle, so server.ts injects a
// closer that broadcasts the pane close + destroys the server-side context.
let terminalBrowserCloser: ((contextId: string) => void) | null = null;
export function setTerminalBrowserCloser(fn: ((contextId: string) => void) | null): void {
  terminalBrowserCloser = fn;
}

/** Read a just-exited sub-agent's final assistant message from its OWN on-disk
 *  transcript (which survives the PTY death). A short retry covers the transcript
 *  flush lag right at exit. Best-effort: returns '' when nothing is recoverable. */
async function readSubAgentFinalResult(child: TerminalSession): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 800 : 700));
    try {
      const out = await readAgentOutput(child, 0);
      const texts = out.events
        .filter((e) => e.type === 'assistant' && e.text)
        .map((e) => (e.text as string).trim())
        .filter(Boolean);
      if (texts.length) return texts[texts.length - 1];
      // No clean assistant text via the pre-assigned claudeSessionId — claude-code
      // mints its own id for sub-agents, so the transcript lives under a DIFFERENT
      // file. Self-heal by discovering the real id, then read once more. (The
      // spawn-time capture usually already fixed this; this is the belt for a
      // server restart or a missed capture.)
      if (out.source === 'buffer' && resolveChildTranscriptSessionId(child)) {
        const out2 = await readAgentOutput(child, 0);
        const texts2 = out2.events
          .filter((e) => e.type === 'assistant' && e.text)
          .map((e) => (e.text as string).trim())
          .filter(Boolean);
        if (texts2.length) return texts2[texts2.length - 1];
      }
    } catch {
      // transcript not ready / unreadable — retry
    }
  }
  return '';
}

/** Discover a sub-agent's REAL transcript id (claude-code ignores the pre-assigned
 *  `--session-id` for children) and adopt it onto the session + DB row so every
 *  subsequent transcript read hits the right .jsonl. No-op unless this is a
 *  sub-agent with a recorded prompt fingerprint. Returns true when it adopted a
 *  new id. Cheap and idempotent — safe to call from the read/wake paths. */
function resolveChildTranscriptSessionId(child: TerminalSession): boolean {
  if (!child.parentSessionKey?.startsWith('topic:') || !child.spawnPromptSnippet) return false;
  // If the currently-recorded id already resolves to a real transcript, keep it.
  if (child.claudeSessionId && fs.existsSync(claudeTranscriptPath(child.cwd, child.claudeSessionId))) {
    return false;
  }
  const found = discoverClaudeSubAgentSessionId({
    cwd: child.cwd,
    promptSnippet: child.spawnPromptSnippet,
    sinceMs: Date.parse(child.createdAt) || 0,
  });
  if (!found || found === child.claudeSessionId) return false;
  const prev = child.claudeSessionId;
  child.claudeSessionId = found;
  try {
    getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [found, child.id]);
  } catch (e) {
    console.warn(`[Terminal] sub-agent session-id adopt failed for ${child.id}:`, e);
  }
  // Re-key the phase tracker onto the id claude actually uses (its hooks carry
  // the minted id, so the pre-assigned registration never matched).
  if (prev) _tracker?.dropTerminalSession(prev);
  _tracker?.registerTerminalSession(found, { cwd: child.cwd });
  return true;
}

/** After a sub-agent PTY launches, poll for the transcript claude actually wrote
 *  (matched by cwd + the child's opening prompt) and adopt its id, mirroring the
 *  codex id-capture. Bounded, self-cancelling, unref'd. Best-effort — the wake
 *  path re-attempts discovery if this misses. */
function scheduleClaudeSubAgentIdCapture(childId: string): void {
  let attempts = 0;
  const poll = () => {
    const child = sessions.get(childId);
    if (!child) return; // stopped before the transcript appeared
    if (resolveChildTranscriptSessionId(child)) {
      broadcastTerminalSessions();
      return;
    }
    if (++attempts < 20) {
      const t = setTimeout(poll, 1000);
      t.unref?.();
    }
  };
  const t = setTimeout(poll, 1000);
  t.unref?.();
}

/** Wake the parent CHAT when a sub-agent it spawned finishes, so a chat that
 *  delegated work ("Monitoro X e ti aggiorno quando consegna") reaches its end
 *  instead of sitting frozen: the launching turn already completed and no
 *  background loop watches a Path-B (MCP spawn_agent) PTY child. Best-effort +
 *  async (transcript read has retry lag); `deliverSubAgentExit` dedups on childId
 *  so the two reap paths that both call this — the bridge `exit` frame and the
 *  explicit `/stop` endpoint (which pre-deletes the session from the map, so the
 *  exit frame can't see it) — never double-deliver. */
function wakeParentTopicOnChildExit(child: TerminalSession, exitCode: number | null): void {
  if (!child.parentSessionKey?.startsWith('topic:') || !subAgentExitHandler) return;
  const parentSessionKey = child.parentSessionKey;
  void (async () => {
    const result = await readSubAgentFinalResult(child);
    try {
      subAgentExitHandler?.({ parentSessionKey, childId: child.id, name: child.name, result, exitCode });
    } catch (err) {
      console.warn(`[Terminal] subAgentExitHandler failed for ${child.id}:`, err);
    }
  })();
}

/**
 * Look up a live terminal session by its id. Used by the browser open-pane
 * endpoint to resolve a terminal-originated `open_browser_pane` call (the MCP
 * bridge passes the terminal id as the session-key) when no chat topic matches.
 */
export function getTerminalSessionById(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

/**
 * Active Claude PTY sessions with a known root pid, for the process detector
 * (routes/processes.ts). It walks each ptyPid's descendant tree to attribute
 * listening ports to the session — so a server Claude starts with a bare shell
 * command still shows up in the Processes panel. Shell sessions are excluded:
 * the feature targets servers Claude launches.
 */
/**
 * Ogni sessione PTY viva col pid di testa del suo albero, per l'attribuzione
 * delle risorse (`lib/fleet-usage.ts`).
 *
 * Diversa da `getClaudeSessionsForDetection`, che filtra le sole sessioni Claude
 * perché il rilevatore di porte cerca i server che Claude avvia: qui serve TUTTO
 * ciò che consuma, e una shell aperta consuma quanto il resto.
 */
export function getFleetSessionRefs(): { sessionId: string; name: string; pid: number }[] {
  const out: { sessionId: string; name: string; pid: number }[] = [];
  const seen = new Set<string>();
  for (const s of sessions.values()) {
    if (!s.ptyPid || s.ptyPid <= 0) continue;
    seen.add(s.id);
    out.push({ sessionId: s.id, name: s.name, pid: s.ptyPid });
  }
  // Le CHAT, non solo i terminali. Una chat con un agente al lavoro ha un
  // albero di processi suo quanto un terminale — semplicemente lo spawna
  // l'ai-bridge invece del pty-bridge, e il pid finisce in un registro diverso
  // (`providers/session-pids.ts`, che esisteva già per ancorare le shell in
  // background). Senza questo pezzo la funzione copriva solo le sessioni PTY, e
  // su una macchina dove si lavora in chat il tooltip diceva sempre «non
  // misurato» pur essendoci gigabyte da attribuire.
  //
  // I PTY vincono sui doppioni: se la stessa sessione compare in entrambi i
  // registri, il pid del PTY è quello dell'albero completo.
  for (const { sessionKey, pid } of listSessionCliPids()) {
    if (!sessionKey || pid <= 0 || seen.has(sessionKey)) continue;
    seen.add(sessionKey);
    out.push({ sessionId: sessionKey, name: sessions.get(sessionKey)?.name ?? sessionKey, pid });
  }
  return out;
}

export function getClaudeSessionsForDetection(): { ptyPid: number; cwd: string; sessionId: string; name: string }[] {
  const out: { ptyPid: number; cwd: string; sessionId: string; name: string }[] = [];
  for (const s of sessions.values()) {
    if (s.type !== 'claude-code' && s.type !== 'claude-code-team') continue;
    if (!s.ptyPid || s.ptyPid <= 0) continue;
    out.push({ ptyPid: s.ptyPid, cwd: s.cwd, sessionId: s.id, name: s.name });
  }
  return out;
}

// --- Per-session pty activity tracking ----------------------------------
// All pty output flows through handleBridgeMessage's "data" case, so this is
// the single point where we can tell whether a session (notably claude-code)
// is producing output. We mark a session busy on output and idle after a
// quiet window; the active→idle transition is the "task finished" signal.
// Broadcast over the app WS so every client reacts — independent of whether
// a terminal pane is mounted (the old client-only pty pulse missed those).
const TERMINAL_IDLE_MS = 1500;
interface TerminalActivity { busy: boolean; timer: ReturnType<typeof setTimeout> | null; lastAt: number; }
const terminalActivity = new Map<string, TerminalActivity>();
// Last visible-text signature per session, used to filter cosmetic repaints
// (e.g. the animated "/goal active" statusline) so they don't count as pty
// activity and pin a session "busy" forever. See lib/pty-activity.ts.
const lastVisibleSig = new Map<string, string>();
// Sessioni RIATTACCATE il cui prossimo frame pty va consumato come BASELINE.
//
// PERCHÉ. Un riavvio del server azzera `lastVisibleSig`, quindi il primo frame
// di ogni pty sopravvissuto non ha un precedente con cui confrontarsi e
// `classifyFrame` non può che dichiararlo NON cosmetico. Ma quel frame è il
// ridisegno di uno schermo che esisteva già — la riattaccata stessa lo provoca —
// non lavoro nuovo. Contarlo costa due cose, misurate entrambe il 2026-08-09
// sullo stesso terminale: un `busy → finished` fasullo 1,5 s dopo (che sul
// client diventa il banner «Lavoro completato» di un lavoro chiuso da giorni) e
// una `reviveOnPtyActivity` che riaccende lo spinner su una sessione ferma da
// mezz'ora (fase `running` alle 11:35 con il transcript fermo alle 11:05 e zero
// byte da consumare: nessuna riga scritta, quindi nessun lavoro).
//
// Il guard di resize non copre questo caso: il ridisegno arriva senza che noi
// abbiamo inoltrato un resize, o fuori dalla sua finestra. È la stessa dottrina
// del «primo frame è solo baseline» che il notificatore ha già lato client
// (isRealPhaseTransition): un frame che non si può attribuire non annuncia
// niente. Vale solo per le riattaccate — uno spawn nuovo non ha uno schermo
// precedente, e il suo primo frame è lavoro vero.
const awaitingBaselineFrame = new Set<string>();

/** La sessione `id` è stata riadottata da un roster preesistente (riavvio del
 *  server / bridge): il suo prossimo frame è un ridisegno, non lavoro. */
function noteTerminalReattached(id: string) {
  awaitingBaselineFrame.add(id);
}
// Time (ms) of the last keystroke we forwarded to each session's pty. An output
// frame arriving within INPUT_ECHO_WINDOW_MS of this is the user's input being
// echoed/redrawn (typing, an autocomplete menu, prompt reflow) — NOT the
// process working — so it must not mark the session busy or revive it. This is
// the fix for "just typing into a Claude Code prompt raises the loading
// spinner". See lib/pty-activity.ts → isInputEcho.
const lastInputAt = new Map<string, number>();
// Time (ms) of the last resize we forwarded to each session's pty. The SIGWINCH
// repaint that follows changes the screen (lines rewrap at the new width)
// WITHOUT the process doing work, so an output frame arriving within
// RESIZE_REPAINT_WINDOW_MS of a resize must not mark the session busy — the fix
// for "loading a caso al resize / all'apertura tab". A wider window than input
// echo because a full repaint round-trips the bridge and can lag a few frames.
// See lib/pty-activity.ts → isResizeRepaint.
const lastResizeAt = new Map<string, number>();

/** Record that the user just sent input to a session's pty (any write: a typed
 *  char, a paste, Enter, an arrow key). Stamped from every write path so the
 *  data handler can recognise the resulting echo frames. */
function noteTerminalInput(id: string) {
  lastInputAt.set(id, Date.now());
}

/** Record that we just resized a session's pty (window/pane resize, divider
 *  drag, sidebar toggle, tab show, focus regain). The data handler treats the
 *  resulting SIGWINCH repaint as non-work so it doesn't flash the spinner. */
function noteTerminalResize(id: string) {
  lastResizeAt.set(id, Date.now());
}

function markTerminalActivity(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  let a = terminalActivity.get(id);
  if (!a) { a = { busy: false, timer: null, lastAt: 0 }; terminalActivity.set(id, a); }
  a.lastAt = Date.now();
  if (!a.busy) {
    a.busy = true;
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: true, kind: session.type });
  }
  if (a.timer) clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a!.busy = false;
    a!.timer = null;
    // active→idle = the session stopped producing output → likely finished a
    // turn. `finished:true` lets the client raise a notification (it filters
    // to claude-code). `kind` carries the session type for that decision.
    _broadcastToAll?.({ type: 'terminal:activity', id, busy: false, finished: true, kind: session.type });
    // Codex has no hooks (claude-hooks drives autoNameClaudeSession), so this
    // busy→idle transition IS its turn boundary: re-derive the tab name from
    // the rollout's latest user prompt. Guarded on a captured rollout id; a
    // no-op once the user renamed the tab. Best-effort, never throws.
    if (session.type === 'codex' && session.claudeSessionId) {
      try { autoNameCodexSession(session.claudeSessionId); } catch { /* best-effort */ }
    } else if (session.type === 'opencode') {
      // opencode has no hooks and mints its session id + AI title only after the
      // first prompt, so busy→idle is its turn boundary: (lazily) discover the
      // opencode session and pull its title. No captured id needed up-front.
      try { autoNameOpencodeSession(session.id); } catch { /* best-effort */ }
    }
  }, TERMINAL_IDLE_MS);
}

function clearTerminalActivity(id: string) {
  const a = terminalActivity.get(id);
  if (a?.timer) clearTimeout(a.timer);
  terminalActivity.delete(id);
  lastVisibleSig.delete(id);
  lastInputAt.delete(id);
  lastResizeAt.delete(id);
  awaitingBaselineFrame.delete(id);
  // Tell clients to drop any loading state for this session (no `finished`:
  // an exit isn't a completed turn).
  if (a?.busy) _broadcastToAll?.({ type: 'terminal:activity', id, busy: false });
}

/**
 * How long (ms) the PTY for a claude session has been quiet, or null if we have
 * no activity record for it (unknown session, or one that never emitted). Busy
 * → 0. The phase reaper uses this to demote a `running` session ONLY when its
 * PTY has been genuinely silent (not just because a phase hook was missed).
 * Keyed by claudeSessionId because that's the tracker's key; we map it back to
 * the terminal session id via the `sessions` roster.
 */
export function getClaudeSessionPtyIdleMs(claudeSessionId: string): number | null {
  for (const [id, s] of sessions) {
    if (s.claudeSessionId !== claudeSessionId) continue;
    const a = terminalActivity.get(id);
    if (!a) return null;
    if (a.busy) return 0;
    return a.lastAt ? Date.now() - a.lastAt : null;
  }
  return null;
}

// Idempotency cache for POST /api/terminal/sessions retries.
// Client sends X-Idempotency-Key on reopen (paneId:closedAt) so a transient
// 5xx on the HEAD probe doesn't spawn duplicate pty sessions when the client
// retries the POST. 60 s TTL — long enough to cover any realistic retry.
// Logic + tests live in ../lib/idempotency-cache; this is the route's singleton.
const idempotencyCache = createIdempotencyCache();

// --- Bridge connection (Unix domain socket) ---
let bridgeSocket: net.Socket | null = null;
let bridgeReady = false;
let bridgeConnecting = false;
let bridgeReadyResolvers: (() => void)[] = [];

// Pending buffer requests: sessionId -> callback
const pendingBufferRequests = new Map<string, ((data: Uint8Array) => void)[]>();

function getSocketPath(): string {
  // Explicit override — set ONLY by the E2E harness (global-setup.ts) so a
  // test run gets its own isolated bridge. Without this, the socket is derived
  // from cwd, which the test server shares with the dev/prod server: the test
  // reconcile would then see the live server's Claude PTYs as orphans and kill
  // them (the "running a test wipes my sessions" bug). Production leaves this
  // unset, so its socket path is byte-identical to before — same bridge, live
  // sessions reattach across a server reload.
  const override = process.env.TOPICS_PTY_SOCKET;
  if (override) return override;
  // Defense-in-depth: derive the socket from the DATA INSTANCE, not just cwd.
  // Production leaves DATA_DIR unset (→ cwd alone → byte-identical socket as
  // before). Any server with a custom DATA_DIR — i.e. EVERY test server — gets
  // a DISTINCT socket, so a misconfigured test server (e.g. a restart that
  // forgot to set TOPICS_PTY_SOCKET) can NEVER attach to the production bridge
  // and reconcile-kill its live PTYs. cwd stays in the basis so two checkouts
  // never collide.
  const dataDir = envDataDir();
  const basis = dataDir ? `${process.cwd()}\0${dataDir}` : process.cwd();
  const hash = createHash('md5').update(basis).digest('hex').slice(0, 8);
  // On Windows the pipe is NOT a file: `/tmp/...` does not exist and `net.connect`
  // on such a path fails with ENOENT, which the rest of this file reads as "no
  // bridge" — i.e. terminals that never open. The canonical name of a named pipe is
  // `\\.\pipe\<name>`, and the hash sits inside it unchanged, so the per-instance
  // isolation described above holds word for word.
  if (process.platform === 'win32') return `\\\\.\\pipe\\topics-pty-bridge-${hash}`;
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

let SOCKET_PATH = getSocketPath();

// The bridge is detached and launchd-reparented, so no ppid walk from the server
// can find it — nor the tree of `claude` CLIs, MCP servers and headless Chromes
// underneath it, which is where most of Topics' RAM actually lives. Declaring the
// socket lets /api/system/status resolve it by command line. See server/lib/fleet-usage.ts.
registerFleetSocket("pty-bridge", SOCKET_PATH);

/**
 * Test seam — puntare il bridge a un altro socket DOPO l'import.
 *
 * Il path si calcola una volta sola, all'import, e in produzione è giusto così
 * (né TOPICS_PTY_SOCKET né DATA_DIR cambiano dopo il boot). Ma sotto `bun test`
 * tutti i file girano nello STESSO processo: il primo che importa questo modulo
 * congela il socket per tutti gli altri, quindi un test con il suo bridge finto
 * non potrebbe mai farsi ascoltare. Cambiare la const in una lettura viva
 * risolveva il test e ne rompeva altri (i file che vengono prima si mettevano a
 * spawnare bridge veri su path nuovi): questa porta la muove solo su richiesta
 * esplicita, e in produzione nessuno la chiama — comportamento identico a prima.
 * `null` ripristina il path derivato dall'ambiente corrente.
 */
export function _setPtyBridgeSocketPath(p: string | null): void {
  SOCKET_PATH = p ?? getSocketPath();
  registerFleetSocket("pty-bridge", SOCKET_PATH);
}
// Le sessioni vive col loro pid di testa, per l'attribuzione per-sessione.
// Registrata come funzione, non come snapshot: l'insieme cambia a ogni
// create/exit e va letto al momento del campionamento, non a import time.
registerFleetSessionSource(getFleetSessionRefs);

/**
 * Append-only stderr sink for the detached bridge, parked next to its socket so
 * a test/prod instance keeps its own (the socket path already encodes the data
 * instance). Returns null if the file can't be opened — losing the bridge's log
 * is survivable, failing to spawn the bridge is not.
 */
function bridgeLogPath(): string {
  // On Windows the socket is a named pipe: its "name" (`\\.\pipe\...`) is not a
  // filesystem directory, so nothing can be parked next to it. The log goes to TEMP
  // with the pipe's name inside its own, so two instances stay distinct exactly as
  // they do on unix.
  if (process.platform === 'win32') {
    const leaf = SOCKET_PATH.split('\\').pop() || 'topics-pty-bridge';
    return join(tmpdir(), `${leaf}.log`);
  }
  return join(dirname(SOCKET_PATH), `${basename(SOCKET_PATH, ".sock")}.log`);
}

/**
 * The bridge's pidfile. Same story as the log: beside the socket on unix, in TEMP on
 * Windows — and it MUST match the bridge's own `transport::pid_path_for`, which is
 * what writes it. If the two halves pick different paths, `recycleBridge` never finds
 * the owner to retire and a degraded bridge stays there forever.
 */
function bridgePidPath(): string {
  if (process.platform === 'win32') {
    const leaf = SOCKET_PATH.split('\\').pop() || 'topics-pty-bridge';
    return join(tmpdir(), `${leaf}.pid`);
  }
  return SOCKET_PATH.replace(/\.sock$/, '.pid');
}

/**
 * "Is a bridge already listening?" — a filesystem question on unix (the socket is a
 * file) and not one at all on Windows: `existsSync` on `\\.\pipe\...` ALWAYS answers
 * false, even with a healthy bridge on the other end. Used as a guard before
 * connecting, that answer meant "no bridge, ever" — i.e. terminals that never open.
 * On Windows the question is deferred to the connection attempt, the only thing that
 * actually knows.
 */
function socketMightExist(): boolean {
  if (process.platform === 'win32') return true;
  return fs.existsSync(SOCKET_PATH);
}

/**
 * Why the bridge's log could not be opened, on the occasions it could not.
 *
 * Without this, `stdio` falls back to `'ignore'` and the bridge's stderr goes
 * nowhere: the bridge writes its reason and nobody collects it. The resulting
 * error then says "no log at <path>", which reads as "the bridge said nothing"
 * when what it means is "we were not listening". Those are opposite diagnoses
 * and they send you looking in two different places.
 */
let bridgeLogOpenError: string | null = null;

/** The message of a failed `spawn`, when it failed. See the note at the call. */
let bridgeSpawnError: string | null = null;

function openBridgeLog(): number | null {
  try {
    fs.mkdirSync(dirname(bridgeLogPath()), { recursive: true });
    bridgeLogOpenError = null;
    return fs.openSync(bridgeLogPath(), "a");
  } catch (e) {
    bridgeLogOpenError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/**
 * L'ultima riga di stderr del ponte, per METTERLA nell'errore.
 *
 * «Failed to connect to PTY bridge after spawning» dice che è andata male, non
 * PERCHÉ: il motivo il ponte l'ha scritto nel suo log, e nessuno lo leggeva. È
 * costato un'indagine intera — le spec E2E del terminale erano rosse da
 * settimane con un timeout su `.xterm-rows` («il terminale non compare»), e la
 * causa era una riga già scritta qui dentro: «Self-test failed: posix_spawnp
 * failed.», cioè `spawn-helper` di node-pty senza bit di esecuzione (vedi
 * scripts/fix-node-pty-exec-bit.ts). Un errore che si porta dietro la sua
 * ragione vale un pomeriggio.
 */
function lastBridgeLogLine(): string | null {
  try {
    const lines = fs.readFileSync(bridgeLogPath(), "utf-8").trim().split("\n");
    return lines[lines.length - 1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * WHY THE BRIDGE DID NOT ANSWER, in the words that send you to the right place.
 *
 * Pure on purpose: this is the only part of bridge startup worth asserting on,
 * and reaching it through `initBridge` would mean spawning a real process and
 * waiting three seconds for it not to appear. Same cut as `routes/sessionStatus.ts`
 * and `routes/clearPolicy.ts` - the decision moves to where a test can reach it,
 * the caller keeps the plumbing.
 *
 * The four cases are ordered by how early they happen, and that order is the
 * point. A spawn that failed explains everything after it, so it wins over a
 * stale line left in the log by a PREVIOUS bridge - the log is append-only and
 * outlives the process that wrote it, so trusting it first would report the
 * last death instead of this one.
 */
export function bridgeFailureDetail(i: {
  /** `error` from the spawn: the bridge was never born. */
  spawnError?: string | null;
  /** Last stderr line: it was born and said why it died. */
  logLine?: string | null;
  /** Why its log could not be opened: it may have said why, and we discarded it. */
  logOpenError?: string | null;
  logPath: string;
}): string {
  if (i.spawnError) return ` Lo spawn e' fallito: ${i.spawnError}.`;
  if (i.logLine) return ` Il ponte dice: ${i.logLine}`;
  if (i.logOpenError) {
    return (
      ` Il suo log non si e' potuto aprire (${i.logPath}): ${i.logOpenError}.` +
      " Lo stderr del ponte e' stato scartato, quindi questo messaggio non sa perche' sia morto."
    );
  }
  return ` Nessun log in ${i.logPath}: il ponte e' partito e non ha scritto niente prima di sparire.`;
}

/**
 * A bundled PTY bridge the compiled sidecar can spawn on a virgin install (where
 * there's no external bridge and Bun itself can't run node-pty): a self-contained
 * **Rust** bridge binary shipped as a Tauri sidecar, pointed at via
 * TOPICS_PTY_BRIDGE_BIN (desktop-tauri lib.rs). ~0.5 MB, zero Node dependency;
 * a wire-compatible port of pty-bridge.mjs.
 *
 * (A legacy bundled-Node flavour — TOPICS_NODE_BIN + TOPICS_PTY_BRIDGE_PATH — was
 * removed in the 2026-07 env audit; every shipped bundle uses the Rust sidecar.)
 *
 * The DATA_DIR-derived short socket (getSocketPath) keeps this sidecar's bridge from
 * ever touching a real server's — the 2026-07-02 isolation invariant holds either way.
 * Returns the command to spawn (`cmd` + leading `args`), or null when none is bundled
 * so the plain standalone kill-switch path is unchanged.
 */
function bundledBridge(): { cmd: string; args: string[] } | null {
  const rustBin = process.env.TOPICS_PTY_BRIDGE_BIN;
  if (rustBin) return { cmd: rustBin, args: [] };
  return null;
}

/**
 * Self-contained / standalone mode: the app runs from a compiled sidecar bundle
 * with no external PTY bridge (set by the Tauri shell — desktop-tauri lib.rs
 * decide_upstream_and_spawn). When set, the server NEVER connects to or spawns the
 * bridge: on a virgin machine there is none, the compiled binary can't spawn one
 * (pty-bridge.mjs resolves to a virtualized path), and — critically — a sidecar that
 * accidentally shares a checkout's cwd must be STRUCTURALLY unable to reconcile-kill
 * a real server's live PTYs (the 2026-07-02 incident). Terminal endpoints answer 503.
 *
 * EXCEPTION: a bundledBridge() (the shell-provided Rust bridge binary) re-enables
 * terminals — the sidecar spawns it against its OWN isolated socket, so the
 * standalone concerns above no longer apply.
 *
 * Read LIVE (not a module-const) so a test can flip the env per-case, and accept two
 * spellings: TOPICS_DISABLE_PTY_BRIDGE (precise) and TOPICS_EMBEDDED (the broader
 * "self-contained bundle" flag) — either enables standalone mode.
 */
export function isPtyBridgeDisabled(): boolean {
  if (bundledBridge()) return false;
  return process.env.TOPICS_DISABLE_PTY_BRIDGE === "1" || process.env.TOPICS_EMBEDDED === "1";
}

/** 503 body for terminal endpoints when the PTY bridge is disabled (standalone). */
function ptyBridgeUnavailable(): Response {
  return new Response(
    JSON.stringify({ error: "terminals not available in standalone mode" }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

// Exported ONLY for the standalone-gate unit test (assert no connect/spawn when the
// flag is set). Not part of the router's public surface otherwise.
export async function ensureBridge(): Promise<void> {
  // Standalone bundle: no external bridge, ever. Returning here makes every call
  // site inert (startup reconcile, reconnect handlers, per-request ensures), so no
  // socket is ever opened and reconcileSessions can never send a `kill`.
  if (isPtyBridgeDisabled()) return;
  if (bridgeReady && bridgeSocket && !bridgeSocket.destroyed) return;
  if (bridgeConnecting) {
    // Wait for the in-flight connection attempt
    return new Promise<void>((resolve) => { bridgeReadyResolvers.push(resolve); });
  }

  bridgeConnecting = true;

  try {
    // Try connecting to existing bridge
    const connected = await tryConnect();
    if (connected) {
      bridgeConnecting = false;
      bridgeReadyResolvers.forEach(r => r());
      bridgeReadyResolvers = [];
      return;
    }

    // No bridge running — spawn one. In a bundled sidecar the shell hands us the
    // bridge command to run (bundledBridge → the Rust sidecar binary, or a legacy
    // bundled Node + pty-bridge.mjs); a normal server uses `node` off PATH and the
    // sibling pty-bridge.mjs. augmentPath() gives the child the same PATH-hardening
    // every PTY spawn gets, so a launchd/sidecar minimal PATH still resolves deps.
    const bb = bundledBridge();
    const cmd = bb?.cmd ?? "node";
    const baseArgs = bb?.args ?? [resolve(import.meta.dir, "../pty-bridge.mjs")];
    // Bridge stderr goes to a LOG FILE, never 'inherit'. Inheriting makes
    // `detached` a lie: the bridge outlives us still holding OUR stderr open,
    // so anything reading this process through a pipe (`| tee`, a test runner)
    // never sees EOF and hangs until killed. A file fd is ours to close the
    // moment the child has it.
    bridgeSpawnError = null;
    const logFd = openBridgeLog();
    // `--parent-pid` is how the bridge decides it has been abandoned. Without it
    // it can only guess from its own ppid, and a server that dies while the
    // bridge is still booting used to leave it immortal (see the orphan monitor
    // in pty-bridge.mjs). An older bundled bridge ignores the extra flag.
    const child = spawn(cmd, [...baseArgs, "--socket", SOCKET_PATH, "--parent-pid", String(process.pid)], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
      env: { ...process.env, PATH: augmentPath() },
    });
    /**
     * THE SPAWN ERROR HAS TO BE COLLECTED, or it is lost by construction.
     *
     * `detached` + `unref()` detach the child from this process, but they do
     * not change the fact that a failed spawn emits `error` on THIS object:
     * ENOENT when the command is not there, EACCES when it is there and is not
     * executable. With no listener that event has no recipient, and on an
     * `EventEmitter` an unheard `error` is worse than lost: Node rethrows it.
     *
     * EACCES is the concrete case, not a hypothesis. It is node-pty's
     * `spawn-helper` without its exec bit, the same fault the note on
     * `lastBridgeLogLine` records as having cost a whole investigation. That
     * time the bridge did start and did write its reason to the log; when it
     * never starts there is no log to read, and the final error said "no log
     * at ...". That accused the bridge of being mute when it was never born.
     */
    child.once("error", (e: Error) => { bridgeSpawnError = e.message; });
    child.unref();
    if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* already closed */ } }

    // Wait for bridge to create socket (poll up to 3 seconds)
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      // A bridge that never started will not start during the remaining wait.
      // Without this, every terminal opened on a broken install pays the full
      // three seconds to learn something already known at the first tick.
      if (bridgeSpawnError) break;
      if (socketMightExist()) {
        const ok = await tryConnect();
        if (ok) break;
      }
    }

    if (!bridgeReady) {
      // Three possible reasons, and they must be told apart because each
      // sends you to a different place: the bridge was never BORN (spawn
      // failed), it was born and said why it died (the log), or we were not
      // listening (log could not be opened). Before, every case wore the
      // third one's words.
      const detail = bridgeFailureDetail({
        spawnError: bridgeSpawnError,
        logLine: lastBridgeLogLine(),
        logOpenError: bridgeLogOpenError,
        logPath: bridgeLogPath(),
      });
      throw new Error(
        `Failed to connect to PTY bridge after spawning (${cmd} --socket ${SOCKET_PATH})` + detail,
      );
    }
  } finally {
    bridgeConnecting = false;
    bridgeReadyResolvers.forEach(r => r());
    bridgeReadyResolvers = [];
  }
}

function tryConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!socketMightExist()) { resolve(false); return; }

    const socket = net.connect(SOCKET_PATH, () => {
      bridgeSocket = socket;
      bridgeReady = true;
      lastPongAt = Date.now();
      setupSocketReader(socket);
      startBridgeWatchdog();
      console.log("[Terminal] Connected to PTY bridge daemon");
      resolve(true);
    });

    socket.on('error', () => {
      resolve(false);
    });

    // Timeout after 1 second
    setTimeout(() => {
      if (!bridgeReady) {
        socket.destroy();
        resolve(false);
      }
    }, 1000);
  });
}

function setupSocketReader(socket: net.Socket) {
  const rl = createInterface({ input: socket });
  rl.on("line", (line: string) => {
    // Any line at all is proof of life, even one we cannot parse. The watchdog
    // reads this, not just the pong.
    lastByteAt = Date.now();
    try {
      handleBridgeMessage(JSON.parse(line));
    } catch {}
  });

  socket.on('close', () => {
    bridgeReady = false;
    bridgeSocket = null;
    console.log("[Terminal] Bridge socket closed, will reconnect on next use");
    // Auto-reconnect after a short delay, then RECONCILE. If the bridge process
    // itself died (not just a socket blip), `ensureBridge` spawns a FRESH, empty
    // bridge — its PTYs are gone. Without reconciling, the surviving claude-code
    // sessions stay in our in-memory/DB map advertised as alive, but the new
    // bridge has no PTY for them, so every terminal WS connect replays an empty
    // buffer → permanently blank Claude tabs until a full server restart. Re-
    // running reconcileSessions re-spawns each survivor with `--resume` (and
    // parks the unrevivable ones as dormant), exactly like boot does. It is
    // idempotent: if we reconnected to a bridge that still owns the PTYs, the
    // bridge's `list` reports them and reconcile only reattaches — no double
    // spawn. broadcastTerminalSessions afterwards pushes the refreshed list.
    setTimeout(() => {
      ensureBridge()
        .then(() => reconcileSessions())
        .then(() => broadcastTerminalSessions())
        .catch(() => {});
    }, 500);
  });

  socket.on('error', () => {
    bridgeReady = false;
    bridgeSocket = null;
  });
}

/**
 * One line per session per silent window, not one per keystroke.
 *
 * Typing during a reconnect produces a burst: the same message repeated dozens
 * of times says nothing the first one did not, and buries the reconnect lines
 * that explain it. The counter is reported when the burst ends.
 */
const droppedInput = new Map<string, { n: number; since: number }>();
function noteDroppedInput(sessionId: string, err: unknown): void {
  const now = Date.now();
  const prev = droppedInput.get(sessionId);
  if (prev && now - prev.since < 10_000) {
    prev.n++;
    return;
  }
  if (prev) {
    console.warn(`[Terminal] ${prev.n} keystroke(s) dropped for ${sessionId} while the bridge was down`);
  }
  droppedInput.set(sessionId, { n: 1, since: now });
  console.warn(`[Terminal] keystroke dropped for ${sessionId}: ${String((err as Error)?.message ?? err)}`);
}

function sendToBridge(msg: any) {
  if (!bridgeSocket || bridgeSocket.destroyed) {
    throw new Error("Bridge not connected");
  }
  bridgeSocket.write(JSON.stringify(msg) + "\n");
}

// --- Create-ack tracking ---
// Pending POST /sessions calls park here until the bridge replies with
// {type:'created', id} or {type:'error', error}. Without this gate the
// API returned 200 even when pty.spawn threw inside the bridge — the
// user got an empty terminal pane and no clue why.
const pendingCreates = new Map<string, { resolve: (pid: number) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function awaitBridgeCreate(id: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    // A second create for the same id used to overwrite the entry and LEAK its
    // timer: the first waiter never resolved nor rejected (its map entry was
    // gone), and its orphan timer later fired a `pendingCreates.delete(id)` that
    // stole the ack belonging to the SECOND create. Fail the earlier waiter
    // explicitly and clear its timer, so at most one create is outstanding per
    // id and the caller sees a real error instead of a hang.
    const prev = pendingCreates.get(id);
    if (prev) {
      clearTimeout(prev.timer);
      pendingCreates.delete(id);
      prev.reject(new Error(`Superseded by a newer create for session ${id}`));
    }
    const timer = setTimeout(() => {
      // Only drop the entry if it is still OURS: a later create may have
      // replaced it between the timer firing and this line.
      if (pendingCreates.get(id)?.timer === timer) pendingCreates.delete(id);
      reject(new Error(`Bridge did not ack create within ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCreates.set(id, { resolve, reject, timer });
  });
}

// --- Bridge spawn-failure circuit breaker ---
// After N consecutive 'error' replies from the bridge, treat the bridge
// itself as degraded (the posix_spawnp incident: native node-pty can
// stop spawning anything if the process loses its Aqua session).
// Force a respawn so the next create lands on a fresh bridge.
let consecutiveSpawnErrors = 0;
const SPAWN_ERROR_LIMIT = 3;

function recycleBridge(reason: string) {
  console.warn(`[Terminal] Recycling bridge: ${reason}`);
  if (bridgeSocket && !bridgeSocket.destroyed) {
    try { bridgeSocket.destroy(); } catch {}
  }
  bridgeSocket = null;
  bridgeReady = false;
  // Try to send a SIGTERM to whatever owns the pidfile — see bridge
  // checkExistingBridge for the same logic on the bridge side.
  try {
    const pidPath = bridgePidPath();
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}
  // ensureBridge will respawn on next demand.
  ensureBridge().catch(() => {});
}

function handleBridgeMessage(msg: any) {
  switch (msg.type) {
    case "created": {
      consecutiveSpawnErrors = 0;
      const pending = pendingCreates.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCreates.delete(msg.id);
        pending.resolve(msg.pid);
      }
      break;
    }
    case "error": {
      // `exists` is the bridge refusing a SECOND create for an id it already
      // has (the double /revive). Its PTY layer is perfectly healthy, so it
      // must not feed the circuit breaker: three of these would recycle the
      // bridge and take every live terminal down with it.
      if (msg.code !== "exists") consecutiveSpawnErrors++;
      // Failed creates: surface to whoever was awaiting that id, if
      // any. The bridge sends `{type:'error', error, id?}` from the
      // catch block in handleMessage — but it doesn't know the id, so
      // we fall back to failing every pending create.
      if (msg.id && pendingCreates.has(msg.id)) {
        const pending = pendingCreates.get(msg.id)!;
        clearTimeout(pending.timer);
        pendingCreates.delete(msg.id);
        pending.reject(new Error(msg.error || 'Bridge error'));
      } else {
        for (const [id, pending] of pendingCreates) {
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error || 'Bridge error'));
          pendingCreates.delete(id);
        }
      }
      if (consecutiveSpawnErrors >= SPAWN_ERROR_LIMIT) {
        consecutiveSpawnErrors = 0;
        recycleBridge(`${SPAWN_ERROR_LIMIT} consecutive spawn errors`);
      }
      break;
    }
    case "data": {
      const session = sessions.get(msg.id);
      if (!session) break;
      // Central activity signal (loading + finished) — independent of whether
      // any client has the terminal pane mounted. Skip two kinds of frame that
      // change the screen without the PROCESS doing work:
      //   1. cosmetic repaints — an animated statusline redraws the same
      //      visible text forever and would otherwise pin the session "busy".
      //   2. input echo — the user typing/pasting/navigating the prompt makes
      //      the TUI echo or redraw the input line within a few ms; counting
      //      that as activity is the "just typing raises the spinner" bug (and
      //      it would revive a dormant session). isInputEcho gates on how long
      //      ago we forwarded a keystroke to this pty. See lib/pty-activity.ts.
      //   3. resize repaint — a window/pane resize (or a tab becoming visible,
      //      which re-fits xterm) sends SIGWINCH; the TUI repaints at the new
      //      width, rewrapping lines so the frame looks non-cosmetic. That
      //      redraw is the user's resize, not the process working — counting it
      //      is the "loading a caso al resize / all'apertura tab" bug.
      const { cosmetic, sig } = classifyFrame(lastVisibleSig.get(msg.id), msg.data);
      lastVisibleSig.set(msg.id, sig);
      const inAt = lastInputAt.get(msg.id);
      const echo = isInputEcho(inAt !== undefined ? Date.now() - inAt : null);
      const rsAt = lastResizeAt.get(msg.id);
      const resizeEcho = isResizeRepaint(rsAt !== undefined ? Date.now() - rsAt : null);
      //   4. primo frame dopo una RIATTACCATA — il ridisegno dello schermo che
      //      c'era già. `lastVisibleSig` è appena stato seminato qui sopra, che
      //      è tutto ciò che serve; contarlo come attività produce un
      //      `finished` fasullo e una revive fasulla. Vedi awaitingBaselineFrame.
      // La somma delle quattro sta in `countsAsActivity` (lib/pty-activity.ts),
      // pura e testata: qui restano solo i segnali.
      const baseline = awaitingBaselineFrame.delete(msg.id);
      if (countsAsActivity({ baseline, cosmetic, inputEcho: echo, resizeEcho })) {
        markTerminalActivity(msg.id);
        // Real output revives a session the reaper demoted to dormant while it
        // was merely silent (missed Stop hook), so the loading dots come back.
        // No-op unless the phase is actually dormant.
        if (session.claudeSessionId && (session.type === 'claude-code' || session.type === 'claude-code-team')) {
          _tracker?.notePtyActivity(session.claudeSessionId);
        }
      }
      // Forward to connected WebSocket clients (buffer is in bridge).
      //
      // The compress flag is decided per write, and for PTY output the size rule
      // is what does the work: a keystroke echo is 1 B, a cursor move 7 B, a
      // line of output 73 B, so nothing latency critical ever reaches the
      // compressor. What DOES cross one MTU here is a full screen redraw or a
      // scrollback flush, and that is the most compressible traffic on this
      // server: 1,927 B of redraw gzip to 41 B. See server/lib/ws-compression.ts.
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        const bytes = typeof msg.data === "string" ? msg.data.length : msg.data.byteLength;
        for (const ws of sockets) {
          const compress = shouldCompressFrame({ type: null, bytes, remote: ws.data.remote === true });
          try { ws.send(msg.data, compress); } catch { sockets.delete(ws); }
        }
      }
      break;
    }
    case "exit": {
      const exitedSession = sessions.get(msg.id);
      sessions.delete(msg.id);
      clearTerminalActivity(msg.id);
      // Remove the per-session MCP bridge config written at spawn. A resumable
      // (dormant) claude session rewrites it on revive, so clearing it now is
      // safe — claude isn't running between exit and revive. No-op for shells.
      if (exitedSession?.type === 'claude-code' || exitedSession?.type === 'claude-code-team') {
        cleanupMcpConfigForSession(msg.id);
      }
      const sockets = sessionSockets.get(msg.id);
      if (sockets) {
        for (const ws of sockets) {
          try { ws.close(1000, "Session ended"); } catch {}
        }
        sessionSockets.delete(msg.id);
      }
      if (exitedSession) {
        // Preserve claude-code sessions with a claudeSessionId so the user can
        // click "Resume" and relaunch claude with --resume <sessionId>.
        //
        // BUT: a session that exits within a few seconds of creation —
        // especially with a non-zero code — is a launch failure (e.g. the
        // upstream claude session referenced by --resume is gone). Marking
        // such a session as 'dormant' makes the project window auto-revive
        // it on every reload, which immediately exits again, producing the
        // "chat appears then closes" flicker. Treat those as dead: DELETE
        // the row so they stop haunting the UI.
        const ageMs = Date.now() - new Date(exitedSession.createdAt).getTime();
        const failedQuickly = ageMs < 3000 && msg.exitCode !== 0;
        const canResume = (exitedSession.type === 'claude-code' || exitedSession.type === 'claude-code-team')
          && !!exitedSession.claudeSessionId
          && !failedQuickly;
        try {
          if (canResume) {
            getDatabase().run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [msg.id]);
          } else {
            if (failedQuickly) {
              console.warn(`[Terminal] Session ${msg.id} exited in ${ageMs}ms with code ${msg.exitCode} — deleting (failed launch).`);
            }
            getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [msg.id]);
          }
        } catch {}
        // Mirror the lifecycle into the phase tracker so the loading signal
        // clears: dormant (resumable) → not loading; otherwise forget it.
        if (exitedSession.claudeSessionId && (exitedSession.type === 'claude-code' || exitedSession.type === 'claude-code-team')) {
          if (canResume) {
            _tracker?.noteDormant(exitedSession.claudeSessionId);
          } else {
            if (failedQuickly) _tracker?.notePtyCrash(exitedSession.claudeSessionId, msg.exitCode ?? 1);
            _tracker?.dropTerminalSession(exitedSession.claudeSessionId);
          }
        }
      }
      // A dying orchestrator must not leave drivable orphan sub-agents behind.
      cascadeKillChildren(msg.id);
      broadcastTerminalSessions();
      // Wake the parent CHAT when a sub-agent it spawned exits on its own (or via
      // cascade). The explicit /stop reap path can't reach here — it pre-deletes
      // the session so `exitedSession` would be null — so /stop calls the helper
      // itself. Guarded to topic-parented children inside the helper.
      if (exitedSession) {
        wakeParentTopicOnChildExit(exitedSession, typeof msg.exitCode === 'number' ? msg.exitCode : null);
      }
      break;
    }
    case "list": {
      // Response to reconciliation request — handled by reconcileSessions
      handleListResponse(msg.sessions || []);
      break;
    }
    case "buffer": {
      // Response to buffer request
      const callbacks = pendingBufferRequests.get(msg.id);
      if (callbacks) {
        const data = msg.data ? Buffer.from(msg.data, 'base64') : new Uint8Array(0);
        for (const cb of callbacks) cb(new Uint8Array(data));
        pendingBufferRequests.delete(msg.id);
      }
      break;
    }
    case "pong": {
      lastPongAt = Date.now();
      // A real pong is the only thing that disarms the escalation: a reconnect
      // must not, or a daemon that accepts connections and answers nothing
      // would loop through soft resets forever and never be SIGTERMed.
      recycleArmedAt = 0;
      break;
    }
  }
}

// --- Bridge liveness watchdog ---
/*
 * Ping every 30s. A bridge that is genuinely wedged (one-way socket break,
 * hung daemon) has to be recycled, because nothing else will unstick it.
 *
 * A LATE PONG IS NOT A DEAD BRIDGE, and treating it as one is expensive here in
 * a way it is not elsewhere: `recycleBridge` SIGTERMs the daemon, whose
 * `shutdown()` walks every session and calls `s.pty.kill()`. Every terminal on
 * the machine dies, including the ones that were mid-turn. Measured in
 * `topics-server.log` on 2026-08-21: 31 recycles, 31 of them for `no pong in
 * 60s`, and two of those are sandwiched between the OTHER bridge's watchdog
 * lines, i.e. it was the SERVER that was stalled, not the daemon. The loss is
 * on the record: one recycle is followed by ten `Failed to recreate session
 * <uuid>: Bridge not connected`.
 *
 * So the verdict is the one `ai-bridge-client.ts` already reached for the same
 * question: `shouldRecycleSocket` is only true when the pong is late AND no
 * BYTES have arrived either. A pong rides the same queue as everything else and
 * can sit behind tens of MB of replay; a byte in that window proves the daemon
 * is alive and talking.
 *
 * And when it is true, it escalates in two steps instead of one. First a plain
 * socket reset, which costs nothing (the `close` handler reconnects and
 * reconciles) and cures the one-way break. The SIGTERM, which is the one that
 * kills PTYs, only fires if the bridge is STILL mute after that, so the case
 * the watchdog was born for is still covered.
 */
let lastPongAt = Date.now();
/** Last byte received from the daemon, whoever it was for. See `setupSocketReader`. */
let lastByteAt = Date.now();
/** When the soft stage fired. Cleared by a real pong, never by a reconnect. */
let recycleArmedAt = 0;
let watchdogStarted = false;
function startBridgeWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  setInterval(() => {
    if (!bridgeReady || !bridgeSocket || bridgeSocket.destroyed) return;
    try { bridgeSocket.write(JSON.stringify({ type: 'ping' }) + '\n'); }
    catch { recycleBridge('ping write failed'); return; }
    setTimeout(() => {
      const now = Date.now();
      const action = bridgeWatchdogStep(now, lastPongAt, lastByteAt, recycleArmedAt);
      if (action === 'ok') return;
      if (action === 'soft-reset') {
        recycleArmedAt = now;
        console.warn('[Terminal] Bridge mute for 60s (no pong, no bytes): resetting the socket, PTYs untouched');
        if (bridgeSocket && !bridgeSocket.destroyed) {
          try { bridgeSocket.destroy(); } catch {}
        }
        bridgeSocket = null;
        bridgeReady = false;
        return;
      }
      recycleArmedAt = 0;
      recycleBridge('still mute 30s after a socket reset');
    }, 5_000);
  }, 30_000).unref();
}

// --- Session reconciliation ---
let reconcileResolver: ((sessions: { id: string; pid: number }[]) => void) | null = null;

function handleListResponse(bridgeSessions: { id: string; pid: number }[]) {
  if (reconcileResolver) {
    reconcileResolver(bridgeSessions);
    reconcileResolver = null;
  }
}

/**
 * Last-resort restore when the bridge never answers `list` (link down). The
 * bridge's PTYs may still be alive, so we must NOT recreate/kill — that's what
 * orphans them. Instead repopulate the in-memory map straight from the DB
 * (without pids) so the client can still attempt to attach to surviving PTYs; a
 * later successful reconcile fills in the pids and prunes anything truly gone.
 */
function restoreDbSessionsOptimistically(): void {
  const db = getDatabase();
  const dbRows = db.query("SELECT * FROM terminal_sessions").all() as any[];
  let restored = 0;
  for (const row of dbRows) {
    if (sessions.has(row.id)) continue;
    sessions.set(row.id, {
      id: row.id,
      name: row.name,
      nameSource: (row.name_source as 'default' | 'auto' | 'user') || 'default',
      createdAt: row.created_at || new Date().toISOString(),
      cwd: row.cwd,
      command: row.command,
      cols: row.cols || 120,
      rows: row.rows || 30,
      topicId: row.topic_id || undefined,
      type: row.type || 'shell',
      skipPermissions: row.skip_permissions !== 0,
      claudeSessionId: row.claude_session_id || undefined,
      ptyPid: undefined,
      parentSessionKey: row.parent_session_key || undefined,
    });
    sessionSockets.set(row.id, new Set());
    noteTerminalReattached(row.id);
    if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
      _tracker?.registerTerminalSession(row.claude_session_id, { cwd: row.cwd || undefined });
    }
    restored++;
  }
  console.log(`[Terminal] Optimistically restored ${restored} session(s) from DB (bridge unreachable, PTYs preserved)`);
}

/**
 * Il roster in memoria è già stato confrontato con la verità (il bridge, o il DB
 * quando il bridge non risponde), oppure è ancora quello vuoto del boot?
 *
 * PERCHÉ ESISTE. `Bun.serve` parte senza attendere `reconcileSessions` (lanciato
 * fire-and-forget in `createTerminalRouter`), quindi c'è una finestra in cui
 * `GET /api/terminal/sessions` risponde **200 con `[]`** — indistinguibile, per chi
 * la riceve, da "non c'è nessuna sessione". Il client la prendeva per oro colato:
 * la scriveva nello stato E nella cache `terminal-sessions-cache` di localStorage,
 * avvelenandola per il caricamento successivo. Da lì una pane terminale VIVA si
 * ritrova `sessionListed === false` ed è a un riaggancio sfortunato dall'overlay
 * "Sessione scaduta".
 *
 * È la stessa lezione che questo file ha già imparato una volta, dieci righe più
 * sotto: distinguere "una risposta reale, anche vuota" da "NESSUNA risposta"
 * (`answered.ok`). Lì valeva per il bridge, qui vale per chi interroga noi.
 */
/** Il roster è confrontato con la verità: chi lo legge può fidarsi di un vuoto.
 *  Esce di qui SOLO come campo `reconciled` di `terminal:sessions` (in fondo al
 *  file): è quello il canale che il client ascolta. C'era anche un getter
 *  `isRosterReconciled()` esportato, che non ha mai avuto un chiamante — due
 *  porte sullo stesso bit, e una murata. */
let rosterReconciled = false;

async function reconcileSessions(attempt = 0): Promise<void> {
  // Standalone bundle: no bridge to reconcile against. Short-circuit so we don't
  // burn the 8× reconnect-retry cycle against a socket that will never answer.
  // Niente da riconciliare ⇒ il roster è autorevole da subito, non "mai".
  if (isPtyBridgeDisabled()) {
    rosterReconciled = true;
    broadcastTerminalSessions();
    return;
  }
  // Ask the bridge which PTYs are still alive. CRITICAL: distinguish a real
  // answer (even an empty list) from NO answer (a timeout). The old code
  // resolved a timed-out `list` to `[]` and then ran the destructive branch
  // below (recreate every DB session with --resume, kill "orphans"). So if a
  // server reload reconciled BEFORE the bridge link was ready, it silently
  // orphaned the user's live Claude PTYs — the "This terminal session has
  // expired" bug that appeared after an update. On no-answer we reconnect +
  // retry, and NEVER touch state we can't see.
  const answered = await new Promise<{ ok: boolean; sessions: { id: string; pid: number }[] }>((resolve) => {
    let settled = false;
    reconcileResolver = (s) => { if (!settled) { settled = true; resolve({ ok: true, sessions: s }); } };
    try { sendToBridge({ type: "list" }); } catch { /* not connected yet — let the timeout drive a retry */ }
    setTimeout(() => {
      if (!settled) { settled = true; reconcileResolver = null; resolve({ ok: false, sessions: [] }); }
    }, 2000);
  });

  if (!answered.ok) {
    if (attempt < 8) {
      console.warn(`[Terminal] bridge 'list' unanswered (attempt ${attempt + 1}/8) — reconnecting + retrying; live PTYs left untouched`);
      await ensureBridge().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      return reconcileSessions(attempt + 1);
    }
    // ~8s of silence: bridge link is down but its PTYs may still be alive. Do
    // NOT recreate/kill (that orphans them) — restore from DB optimistically.
    console.error("[Terminal] bridge 'list' never answered after retries — restoring DB sessions WITHOUT reconcile to preserve live PTYs");
    restoreDbSessionsOptimistically();
    // Il bridge non ha risposto, ma il roster ora contiene ciò che il DB sa: è la
    // migliore verità disponibile, e tenerlo "non autorevole" per sempre
    // lascerebbe i client senza un vuoto di cui fidarsi mai più.
    rosterReconciled = true;
    broadcastTerminalSessions();
    return;
  }

  const bridgeSessions = answered.sessions;
  const bridgeIds = new Set(bridgeSessions.map(s => s.id));

  // Get DB sessions
  const db = getDatabase();
  const dbRows = db.query("SELECT * FROM terminal_sessions").all() as any[];
  const dbIds = new Set(dbRows.map((r: any) => r.id));
  // pid the bridge reported for each surviving PTY — used to repopulate
  // session.ptyPid after a reload (in-memory state was reset) so the process
  // detector can keep attributing listening ports to the right session.
  const bridgePidById = new Map(bridgeSessions.map(s => [s.id, s.pid]));

  // Bridge has session + DB has it → restore in-memory entry
  for (const row of dbRows) {
    if (bridgeIds.has(row.id)) {
      // Session is alive in bridge — just add to in-memory map
      if (!sessions.has(row.id)) {
        sessions.set(row.id, {
          id: row.id,
          name: row.name,
          nameSource: (row.name_source as 'default' | 'auto' | 'user') || 'default',
          createdAt: row.created_at || new Date().toISOString(),
          cwd: row.cwd,
          command: row.command,
          cols: row.cols || 120,
          rows: row.rows || 30,
          topicId: row.topic_id || undefined,
          type: row.type || 'shell',
          skipPermissions: row.skip_permissions !== 0,
          claudeSessionId: row.claude_session_id || undefined,
          ptyPid: bridgePidById.get(row.id),
          parentSessionKey: row.parent_session_key || undefined,
        });
        sessionSockets.set(row.id, new Set());
        noteTerminalReattached(row.id);
        // Re-register with the phase tracker (in-memory state was lost on
        // restart). The next hook OR the transcript tail (cwd-derived path)
        // re-establishes the live phase; until then il client resta su una fase
        // a RIPOSO (`dormant` per una riattaccata), non sull'euristica pty.
        if (row.claude_session_id && (row.type === 'claude-code' || row.type === 'claude-code-team')) {
          _tracker?.registerTerminalSession(row.claude_session_id, { cwd: row.cwd || undefined });
        }
        console.log(`[Terminal] Reattached to surviving session ${row.id} (${row.type})`);
      }
    }
  }

  // Bridge has session, DB doesn't → orphaned, kill it
  for (const bs of bridgeSessions) {
    if (!dbIds.has(bs.id)) {
      console.log(`[Terminal] Killing orphaned bridge session ${bs.id}`);
      sendToBridge({ type: "kill", id: bs.id });
    }
  }

  // DB has session, bridge doesn't → parcheggia, rilancia o rimuovi.
  // CHI fa cosa lo decide `lib/terminal-restart-policy.ts`, che è puro e ha i
  // suoi test: qui restano solo gli effetti.
  for (const row of dbRows) {
    if (!bridgeIds.has(row.id)) {
      const isClaude = row.type === 'claude-code' || row.type === 'claude-code-team';
      // Il transcript si guarda solo dove conta (tipi claude con un id di
      // ripresa): è l'unico caso in cui la sua assenza cambia la decisione, e
      // uno `stat` per riga a ogni avvio non si regala.
      const hasTranscript = isClaude && row.claude_session_id
        ? (() => { try { return fs.existsSync(claudeTranscriptPath(row.cwd, row.claude_session_id)); } catch { return false; } })()
        : false;
      const decision = decideOnRestart({
        type: row.type || 'shell',
        claudeSessionId: row.claude_session_id,
        hasTranscript,
      });

      if (decision.action === 'drop') {
        console.log(`[Terminal] Rimossa ${row.type} ${row.id}: transcript assente, non ripristinabile`);
        try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [row.id]); } catch { /* swallow */ }
      } else if (decision.action === 'park') {
        console.log(`[Terminal] Parcheggiata ${row.type} ${row.id} (dormiente, si rianima al focus)`);
        try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch { /* swallow */ }
      } else {
        // Codex — RECREATE (don't park dormant) so the pane re-enters the live
        // roster and the client reattaches, exactly like claude-code does with
        // --resume. createSession resumes the prior conversation when we
        // captured a rollout id (row.claude_session_id) and its rollout still
        // exists, else relaunches a fresh codex in the same cwd.
        //
        // Why recreate instead of dormant: a dormant row is only auto-revived
        // by the PROJECT layout (GET /sessions/dormant?cwd=); a STANDALONE
        // (non-project) codex pane has no revive path, so parking it dormant
        // stranded it as "[Session expired]". Recreating here gives standalone
        // AND project codex the same restart-survival, with no client changes.
        console.log(`[Terminal] Recreating codex session ${row.id}${row.claude_session_id ? ' with resume' : ' (fresh)'}`);
        try {
          await createSession(
            row.id, row.name, row.cwd, undefined,
            row.cols || 120, row.rows || 30,
            row.topic_id || undefined, 'codex',
            row.skip_permissions !== 0, row.claude_session_id || undefined,
            row.parent_session_key || undefined,
            (row.name_source as 'default' | 'auto' | 'user') || 'default',
          );
        } catch (err: any) {
          // Transient boot failure (bridge not ready, spawn error): park dormant
          // so a later project-window /revive can retry, rather than losing the
          // row. The 1h sweep is shell-only (type='shell'), so a dormant codex
          // row survives until then.
          console.warn(`[Terminal] Failed to recreate codex session ${row.id}: ${err.message} — parking dormant`);
          try { db.run("UPDATE terminal_sessions SET status = 'dormant' WHERE id = ?", [row.id]); } catch {}
        }
      }
    }
  }

  // Da qui il roster è confrontato con la verità del bridge: un vuoto ora
  // significa davvero "nessuna sessione". Il broadcast porta la promozione ai
  // client già connessi, che altrimenti resterebbero con l'ultimo roster
  // ricevuto e senza sapere che ora può essere creduto.
  rosterReconciled = true;
  broadcastTerminalSessions();
}

// --- Buffer request from bridge ---
function requestBuffer(sessionId: string): Promise<Uint8Array> {
  return new Promise((resolve) => {
    if (!bridgeReady) { resolve(new Uint8Array(0)); return; }
    const existing = pendingBufferRequests.get(sessionId) || [];
    existing.push(resolve);
    pendingBufferRequests.set(sessionId, existing);
    sendToBridge({ type: "buffer", id: sessionId });
    // Timeout after 1 second
    setTimeout(() => {
      const cbs = pendingBufferRequests.get(sessionId);
      if (cbs) {
        for (const cb of cbs) cb(new Uint8Array(0));
        pendingBufferRequests.delete(sessionId);
      }
    }, 1000);
  });
}

/**
 * Read a terminal session's scrollback buffer as decoded text.
 * Used by the Master proposal ingest (interactive-claude-primitive AD-2):
 * scrape the human-driven `claude` PTY's output — NOT a model call, so it
 * stays on the subscription. Returns "" if the bridge is down or times out.
 */
/**
 * Quante sessioni di terminale hanno un client ATTACCATO adesso.
 *
 * È il segnale «c'è qualcuno al lavoro» che la modalità notturna aspetta. Si
 * conta chi è attaccato, non chi è vivo: una sessione viva che nessuno sta
 * guardando — un agente dimenticato, una tab lasciata aperta — non è una
 * presenza, e contarla terrebbe il turno notturno bloccato per sempre.
 */
/**
 * Fotografia delle sessioni vive per il censimento delle orfane: id, se
 * qualcuno è attaccato, e se è un sotto-agente.
 *
 * Tre fatti e non uno, perché il censimento deve risparmiare per motivi
 * diversi: chi è guardato adesso, e chi ha un padre invece di una tab.
 */
export function listTerminalSessionSnapshot(): Array<{ id: string; attached: boolean; isSubAgent: boolean }> {
  const out: Array<{ id: string; attached: boolean; isSubAgent: boolean }> = [];
  for (const [id, s] of sessions) {
    out.push({
      id,
      attached: (sessionSockets.get(id)?.size ?? 0) > 0,
      isSubAgent: !!s.parentSessionKey,
    });
  }
  return out;
}

export function countAttachedTerminalSessions(): number {
  let n = 0;
  for (const set of sessionSockets.values()) if (set.size > 0) n++;
  return n;
}

/**
 * Quanti AGENTI in un terminale stanno producendo output adesso.
 *
 * Serve al riepilogo (la barra di stato e la presence Discord), e colma un buco
 * che quel riepilogo aveva dalla nascita: «quante sessioni stanno lavorando»
 * contava i turni in streaming (`activeStreams`, cioè le chat e i task della
 * board) e basta. Una `claude-code` che macina in una tab terminale non passa
 * di lì, quindi non veniva contata: il posto in cui questa applicazione fa
 * lavorare gli agenti più spesso era proprio quello che il numero non vedeva.
 *
 * La shell resta fuori: `cat` di un file lungo è output, non un agente al
 * lavoro. È la stessa esclusione — e per la stessa ragione — che applica il
 * conteggio del client (`useAgentActivityCounts`), così le due letture della
 * stessa barra non possono raccontare due cose diverse.
 */
export function countBusyAgentTerminals(): number {
  let n = 0;
  for (const [id, a] of terminalActivity) {
    if (!a.busy) continue;
    const s = sessions.get(id);
    if (!s || s.type === "shell") continue;
    n++;
  }
  return n;
}

export async function getTerminalBuffer(sessionId: string): Promise<string> {
  const bytes = await requestBuffer(sessionId);
  return new TextDecoder().decode(bytes);
}

// --- Session management ---
async function createSession(id: string, name: string, cwd: string, command?: string, cols = 120, rows = 30, topicId?: string, sessionType: TerminalSessionType = 'shell', skipPermissions = true, claudeSessionId?: string, parentSessionKey?: string, nameSource: 'default' | 'auto' | 'user' = 'default'): Promise<TerminalSession> {
  let file: string;
  let args: string[];
  const isClaudeKind = sessionType === 'claude-code' || sessionType === 'claude-code-team';

  let resolvedClaudeSessionId = claudeSessionId;
  if (isClaudeKind && !resolvedClaudeSessionId) {
    resolvedClaudeSessionId = crypto.randomUUID();
  }

  if (isClaudeKind) {
    // Absolute path where possible: the server runs under launchd (and, on a
    // fresh install, the Tauri sidecar's bundled Node) with a bare PATH that
    // excludes ~/.local/bin, Homebrew, etc. A plain `claude` then ENOENTs and the
    // pane exits instantly (blank tab). Falls back to the bare name so a
    // full-PATH dev shell still works, and so a machine without claude installed
    // surfaces a clear "command not found" rather than nothing. Mirrors codex.
    file = resolveClaudeBin() ?? 'claude';
    args = [];
    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    } else if (resolvedClaudeSessionId) {
      args.push('--session-id', resolvedClaudeSessionId);
    }
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    // Nudge the agent to launch servers via the Topics MCP (run_script) so they
    // show up in the Processes panel instead of leaking into the bare shell.
    // --append-system-prompt works in interactive mode and is additive to the
    // project's own CLAUDE.md.
    args.push('--append-system-prompt', topicsAgentSystemPrompt());
    // Start the interactive session at the same effort tier a Warp shell would
    // ("ultracode" = xhigh). The server runs under launchd with no CLAUDE_EFFORT
    // in its env, and the user's global effortLevel defaults to low, so without
    // an explicit flag every Topics PTY would start at low effort. Tunable via
    // TOPICS_CLAUDE_EFFORT (set "off" to defer to the CLI's own settings).
    // L'override per-topic (migration 033, il selettore nel model picker) vince
    // su ogni default — ma solo se glielo si passa: `resolveClaudeEffort()` senza
    // argomento salta il primo ramo della sua catena, e questo percorso lo
    // chiamava così. Il risultato è che il selettore era MORTO sul terminale
    // interattivo: un topic messo a "medium" apriva comunque un PTY a xhigh, e
    // sul percorso chat (claude-code.ts, che l'override lo passa) lo stesso topic
    // si comportava diversamente. Due superfici, due effort, un solo selettore.
    const claudeEffort = resolveClaudeEffort(topicEffortFor(getDatabase(), topicId));
    if (claudeEffort) args.push('--effort', claudeEffort);
    // Bridge the Topics MCP server into the interactive CLI so a terminal
    // Claude Code can surface a browser pane next to itself (the chat path
    // does the same in providers/claude-code.ts). We key the config by the
    // terminal session id — the MCP tool POSTs to
    // /api/sessions/<id>/browser/open-pane, which the endpoint resolves to
    // THIS terminal (not a chat topic) and opens the browser in the same
    // group as the terminal pane, for both standalone and project layouts.
    // The generated config carries the `topics` bridge plus a curated set of
    // the user's global MCP servers; when scoped we add `--strict-mcp-config`
    // so the CLI uses ONLY that set (otherwise it stays additive and nothing
    // the user had is lost). Policy lives in writeMcpConfigForSession and is
    // env-tunable (TOPICS_SESSION_MCP_ALLOW/DENY/INHERIT_ALL). Cleaned up in
    // the `exit` handler below.
    try {
      const { path: mcpPath, strict } = writeMcpConfigForSession(id);
      args.push('--mcp-config', mcpPath);
      if (strict) args.push('--strict-mcp-config');
    } catch (err) {
      // Non-fatal: a missing bridge just means no open_browser_pane tool.
      console.warn(`[Terminal] MCP config write failed for ${id}:`, err);
    }
  } else if (sessionType === 'codex') {
    // Codex (OpenAI CLI) — spawned the same interactive-PTY way as `claude`,
    // with none of the Claude-specific plumbing (no session-id/--resume, no
    // MCP bridge config, no tracker registration, no skip-permissions flag).
    // Codex sessions carry no claude_session_id, so the dormant sweep treats
    // them like shells (no resumable pointer we track).
    //
    // Resolve the ABSOLUTE path: Codex ships inside Codex.app (not on PATH),
    // and under launchd the server's PATH excludes both Homebrew and the app
    // bundle — a bare `codex` ENOENTs silently, leaving a blank pane. The
    // shared resolver (used by the chat provider too) finds the bundle binary.
    file = resolveCodexBin() ?? 'codex';
    // RESUME the prior conversation when we captured a rollout id for this row
    // AND codex's rollout file still exists on disk (the codex analogue of the
    // claude `--resume` + transcript-exists guard). `claudeSessionId` here is
    // the generic resumable-pointer slot — NOT a claude id; for codex it holds
    // the UUID codex minted for its ~/.codex/sessions rollout, captured
    // post-spawn by scheduleCodexIdCapture (see lib/codex-session.ts). Codex
    // mints its own id, so we never pass --session-id; on a fresh launch
    // claudeSessionId is undefined and we start clean, then capture the id.
    if (claudeSessionId && codexRolloutExists(claudeSessionId)) {
      args = ['resume', claudeSessionId];
    } else {
      args = [];
    }
    // Same explicit reasoning-effort override the chat path passes (see
    // providers/codex.ts): deterministic tier under launchd, and the user's
    // own config.toml value wins over our default. `-c` is a global codex
    // flag, valid after `resume` too.
    const codexEffort = resolveCodexReasoningEffort();
    if (codexEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(codexEffort)}`);
  } else if (sessionType === 'opencode') {
    // opencode (open-source agent CLI) pinned to the free Cerebras provider
    // (GLM-4.7 — quasi-Opus, no-train). Two things it needs that the launchd
    // server's bare env lacks: CEREBRAS_API_KEY (the user keeps it in ~/.zshrc)
    // and Homebrew on PATH (opencode lives in /opt/homebrew/bin). So we launch
    // it inside a login+interactive shell that sources the user's profile —
    // exactly what happens when they type `opencode` in their own terminal —
    // and `exec` hands the PTY straight to opencode. No session tracking, no
    // MCP bridge: like codex/shell, opencode carries no claude_session_id.
    // Default to gemma-4-31b (instruct, NOT a reasoning model). The Cerebras
    // reasoning models on this account (zai-glm-4.7, gpt-oss-120b) make opencode
    // replay an unsupported `reasoning_content` field and 400 on the 2nd turn —
    // reproduced even on opencode 1.17.17 + @ai-sdk/cerebras. Gemma emits no
    // reasoning trace, so multi-turn is bug-proof (verified). Weaker than GLM,
    // but reliable; switch to zai-glm-4.7 manually inside opencode when the
    // upstream reasoning-replay fix lands. Model catalog is account-specific
    // (GET /v1/models): only gemma-4-31b / gpt-oss-120b / zai-glm-4.7 here.
    file = process.env.SHELL || '/bin/zsh';
    args = ['-lic', 'exec opencode -m cerebras/gemma-4-31b'];
  } else if (sessionType === 'kimi-code') {
    // Kimi Code (Moonshot AI's CLI) — spawned the same interactive-PTY way as
    // codex: no session-id/--resume, no MCP bridge config, no tracker
    // registration. It carries no claude_session_id, so the dormant sweep and
    // `decideOnRestart` treat it like shell/codex (see terminal-restart-policy.ts).
    //
    // Resolve the ABSOLUTE path: the installer drops the binary at
    // ~/.kimi-code/bin/kimi and does not reliably reach the bare PATH a
    // launchd-spawned server inherits (see lib/kimi-bin.ts).
    file = resolveKimiBin() ?? 'kimi';
    args = [];
  } else if (command) {
    const parts = command.split(" ");
    file = parts[0];
    args = parts.slice(1);
  } else if (process.platform === 'win32') {
    // The default shell on Windows. `/bin/zsh` does not exist there, and without
    // this the "shell" tab asked to launch a nonexistent file: the bridge answered
    // with a spawn error and the tab died the moment it opened.
    //
    // PowerShell rather than `cmd.exe`: it is the interactive shell a Windows user
    // expects, and `-NoLogo` drops the copyright banner that would otherwise eat the
    // first lines of every terminal. `TOPICS_SHELL` overrides it.
    file = process.env.TOPICS_SHELL || 'powershell.exe';
    args = ['-NoLogo'];
  } else {
    file = process.env.SHELL || "/bin/zsh";
    args = ["-l"];
  }

  let env: Record<string, string | null> | undefined;
  if (isClaudeKind) {
    // Pin HOME to the user's REAL home. The pty-bridge inherits whatever HOME the
    // server (or a sandbox ancestor) was launched with; if that's a throwaway dir
    // (e.g. /tmp/tcs-h-XXXX) every `claude` would read an empty ~/.claude.json
    // there and re-onboard, losing the user's account/settings/MCP/history.
    // realHome() is $HOME-independent, so this anchors claude to the real config.
    env = { CLAUDECODE: null, PATH: augmentPath(), HOME: realHome() };
    // Master Topic mode: enable Claude Code Agent Teams (experimental).
    // Sub-safe pattern — `claude` runs interactive in PTY, lead delegates
    // to teammates via shared task list (see spec MASTER-01).
    if (sessionType === 'claude-code-team') {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
  } else if (sessionType === 'codex') {
    // Same PATH augmentation as claude: under launchd the server has a
    // minimal PATH (no Homebrew), so a bare `codex` would ENOENT silently.
    // HOME pinned to the real home for the same reason as claude — codex reads
    // its auth/config from ~/.codex and would lose it under a sandbox HOME.
    env = { PATH: augmentPath(), HOME: realHome() };
  } else if (sessionType === 'opencode') {
    // HOME → real home so the login shell reads the user's ~/.zshrc (where
    // CEREBRAS_API_KEY + Homebrew PATH live) and opencode finds its config at
    // ~/.config/opencode. PATH augmented as a belt-and-suspenders fallback.
    env = { PATH: augmentPath(), HOME: realHome() };
  } else if (sessionType === 'kimi-code') {
    // Same reasoning as codex: PATH augmented for a launchd-minimal env, HOME
    // pinned to the real home so kimi reads its own auth/config, not a sandbox one.
    env = { PATH: augmentPath(), HOME: realHome() };
  }

  // IS THE CLI ACTUALLY THERE? If not, say so HERE.
  //
  // The branches above fall back to the bare name (`?? 'claude'`) counting on a
  // "command not found" the user reads in the terminal. On macOS that line does
  // arrive, because the shell prints it. On Windows it does not: the process
  // never starts, the PTY hits EOF the instant it opens, and the user sees a tab
  // that appears and stays empty — exactly the reported defect ("it opens Claude
  // Code as a tab, but nothing actually opens", 2026-08-26).
  //
  // A missing agent is not a fault: it is the normal state of a fresh machine,
  // and it deserves to be named along with how to install it. The check is on the
  // RESOLVED path, not on a spawn attempt: if the resolver found nothing and the
  // branch fell back to the bare name, `Bun.which` is the last word before
  // actually trying.
  if (sessionType !== 'shell' && !command) {
    const bare = !file.includes('/') && !file.includes('\\');
    if (bare && !Bun.which(file)) {
      const howToInstall: Record<string, string> = {
        'claude': 'https://claude.com/product/claude-code',
        'codex': 'npm i -g @openai/codex',
        'opencode': 'npm i -g opencode-ai',
        'kimi': 'curl https://code.kimi.com/kimi-code/install.sh | bash',
      };
      const base = file.replace(/\.(exe|cmd|bat)$/i, '');
      const hint = howToInstall[base];
      throw new Error(
        `"${base}" is not installed on this machine` +
        (hint ? `. Install it with: ${hint}` : '') +
        `. Topics runs the CLI you already have; it does not bundle it.`,
      );
    }
  }

  // Await the bridge's ack before populating in-memory + DB. If the
  // bridge can't actually spawn (broken native addon, missing
  // binary, lost session context), throw — the API handler returns
  // 502 and the user sees a real error instead of an empty xterm
  // pane that silently never produces output.
  const ackPromise = awaitBridgeCreate(id);
  let ptyPid: number | undefined;
  // Stamp the spawn instant so the codex rollout-id discovery (below) only
  // considers a rollout written at/after this launch, not a stale one.
  const spawnTimeMs = Date.now();
  try {
    sendToBridge({ type: "create", id, shell: file, args, cwd, cols, rows, ...(env ? { env } : {}) });
    ptyPid = await ackPromise; // bridge resolves the create-ack with the PTY pid
  } catch (err) {
    pendingCreates.delete(id);
    throw err;
  }

  // A plain shell born with the generic add-menu label ("Shell") or "Terminal N"
  // gets a more useful default: the working directory's basename (e.g. the repo
  // name). Kept name_source='default' so a later user rename (PATCH → 'user')
  // still wins, and claude/codex are untouched (they auto-name from their
  // transcript/rollout). Only when the caller didn't pass a user name.
  if (sessionType === 'shell' && nameSource === 'default') {
    const dirName = basename(cwd);
    if (dirName) name = dirName;
  }

  const session: TerminalSession = {
    id,
    name,
    nameSource,
    createdAt: new Date().toISOString(),
    cwd,
    command: sessionType === 'claude-code' ? 'claude' : (command || file),
    cols,
    rows,
    topicId,
    type: sessionType,
    skipPermissions,
    claudeSessionId: resolvedClaudeSessionId,
    ptyPid,
    parentSessionKey,
  };

  sessions.set(id, session);
  sessionSockets.set(id, new Set());

  try {
    getDatabase().run(
      `INSERT OR REPLACE INTO terminal_sessions (id, name, name_source, cwd, command, type, topic_id, cols, rows, skip_permissions, created_at, claude_session_id, parent_session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, nameSource, cwd, session.command, sessionType, topicId || null, cols, rows, skipPermissions ? 1 : 0, session.createdAt, resolvedClaudeSessionId || null, parentSessionKey || null]
    );
  } catch (err) {
    // NEVER swallow silently: a failed persist means the session won't survive a
    // server/bridge restart (reconcileSessions has no DB row to reattach or
    // revive). A swallowed CHECK-constraint violation on `type` is exactly how
    // codex/claude-code-team panes vanished on restart before migration 029
    // widened the constraint — log loudly so the next such mismatch is obvious.
    console.error(`[Terminal] FAILED to persist session ${id} (type=${sessionType}) — it will NOT survive a restart:`, err);
  }

  // Register topic-less claude sessions with the tracker so their hooks resolve
  // and drive the authoritative phase signal. Topic-bound ones already have a
  // claude_code_sessions row owned by the chat provider — registerTerminalSession
  // is a no-op for those.
  if (isClaudeKind && resolvedClaudeSessionId) {
    _tracker?.registerTerminalSession(resolvedClaudeSessionId, { cwd });
  }

  // Codex mints its session UUID itself (no --session-id to pre-assign), so we
  // discover it from the rollout codex writes shortly after start and persist
  // it as the resumable pointer. Runs for BOTH a fresh launch and a resume:
  // resuming may append to the same rollout or spawn a child, and either way we
  // want the pointer to track the latest so the NEXT restart resumes current
  // state. Best-effort + async — failure just leaves the pane non-resumable.
  if (sessionType === 'codex') {
    scheduleCodexIdCapture(id, cwd, spawnTimeMs);
  }

  return session;
}

/**
 * After a codex PTY launches, poll ~/.codex/sessions for the rollout it just
 * wrote (matched by cwd + recency) and stash its UUID on the terminal_sessions
 * row's resumable-pointer slot (`claude_session_id`) + the in-memory session,
 * then rebroadcast so the roster carries it. Bounded, self-cancelling (stops if
 * the pane is closed), and `unref`'d so it never holds the process open.
 */
function scheduleCodexIdCapture(sessionId: string, cwd: string, sinceMs: number): void {
  let attempts = 0;
  const poll = () => {
    if (!sessions.has(sessionId)) return; // pane closed before we captured it
    const found = discoverCodexSessionId({ cwd, sinceMs });
    if (found) {
      const s = sessions.get(sessionId);
      if (s && s.claudeSessionId !== found) {
        s.claudeSessionId = found;
        try {
          getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [found, sessionId]);
        } catch (e) {
          console.warn(`[Terminal] codex session-id persist failed for ${sessionId}:`, e);
        }
        broadcastTerminalSessions();
        // The rollout now exists (its first user_message is written), so give
        // the tab a real label immediately instead of waiting for the first
        // idle transition. Best-effort — no-ops if nothing usable yet.
        autoNameCodexSession(found);
      }
      return;
    }
    if (++attempts < 12) {
      const t = setTimeout(poll, 1000);
      t.unref?.();
    }
  };
  const t = setTimeout(poll, 800);
  t.unref?.();
}

/**
 * Auto-label a Claude Code terminal tab from its session topic, unless the user
 * has manually renamed it. Called on each Stop / UserPromptSubmit hook so the
 * tab tracks the topic as it evolves; no-ops when the derived title is unchanged
 * or the name is user-owned. Best-effort — never throws into the hook path.
 * Updates the in-memory session + the persisted row, then re-broadcasts the
 * roster so every client relabels live.
 */
export function autoNameClaudeSession(claudeSessionId: string, transcriptPath?: string): void {
  if (!claudeSessionId) return;
  let target: TerminalSession | undefined;
  for (const s of sessions.values()) {
    if (s.claudeSessionId === claudeSessionId &&
        (s.type === "claude-code" || s.type === "claude-code-team")) { target = s; break; }
  }
  if (!target || target.nameSource === "user") return; // a manual rename wins

  const file = (transcriptPath && transcriptPath.trim())
    ? transcriptPath
    : claudeTranscriptPath(target.cwd, claudeSessionId);
  const title = deriveClaudeSessionTitle(file);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/**
 * Safety-net sweep: re-derive the auto-name for EVERY live Claude session, not
 * just the one whose hook fired. `autoNameClaudeSession` is normally driven by
 * the UserPromptSubmit/Stop hooks (claude-hooks), but a session whose hooks never
 * reach the server — started outside the app flow, or a `claude_session_id` that
 * drifted after a `--resume` — keeps the generic "Claude Code" label forever even
 * though its transcript already carries a perfectly good title. This closes that
 * gap. Cheap and idempotent: autoNameClaudeSession no-ops when the name is
 * user-owned, unchanged, or underivable (missing transcript), and transcript
 * reads are incremental via the scan cache. Best-effort — never throws.
 */
export function sweepAutoNameClaudeSessions(): void {
  for (const s of sessions.values()) {
    if ((s.type === "claude-code" || s.type === "claude-code-team") &&
        s.nameSource !== "user" && s.claudeSessionId) {
      try { autoNameClaudeSession(s.claudeSessionId); } catch { /* best-effort */ }
    }
  }
}

// Kick a first sweep once the boot reconcile has populated the session map, then
// keep a low-frequency net running so a session that never gets a hook still
// picks up its title within a minute. Unref'd — never holds the process open.
const AUTO_NAME_SWEEP_MS = 45_000;
setTimeout(() => {
  try { sweepAutoNameClaudeSessions(); } catch { /* best-effort */ }
  try { sweepAutoNameOpencodeSessions(); } catch { /* best-effort */ }
}, 8_000).unref?.();
setInterval(() => {
  try { sweepAutoNameClaudeSessions(); } catch { /* best-effort */ }
  try { sweepAutoNameOpencodeSessions(); } catch { /* best-effort */ }
}, AUTO_NAME_SWEEP_MS).unref?.();

/**
 * Auto-label a Codex terminal tab from its rollout's user prompts (Codex has no
 * `ai-title` event, so the label tracks the user's own text — see
 * codex-transcript-title.ts). The Codex analogue of autoNameClaudeSession:
 * no-ops until the rollout id has been captured (scheduleCodexIdCapture can lag
 * a few seconds), when the derived title is unchanged, or once the user has
 * renamed the tab (name_source='user'). Best-effort — never throws into the
 * caller (the id-capture success branch or the per-turn idle transition).
 * `codexRolloutId` is the UUID stored on the session's resumable-pointer slot
 * (`claudeSessionId`).
 */
export function autoNameCodexSession(codexRolloutId: string): void {
  if (!codexRolloutId) return;
  let target: TerminalSession | undefined;
  for (const s of sessions.values()) {
    if (s.claudeSessionId === codexRolloutId && s.type === "codex") { target = s; break; }
  }
  if (!target || target.nameSource === "user") return; // a manual rename wins

  const path = codexRolloutPath(codexRolloutId);
  if (!path) return; // rollout not written/discovered yet
  const title = deriveCodexSessionTitle(path);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] codex auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/**
 * Auto-label an opencode terminal tab from the AI title opencode itself wrote
 * into its SQLite `session` row. Unlike claude (hooks) and codex (rollout id
 * captured post-spawn), opencode's session id + title only exist AFTER the first
 * user prompt, so this takes the TERMINAL session id and lazily discovers the
 * opencode `ses_…` id (by cwd + recency) the first time it can, stashing it on
 * the resumable-pointer slot (`claudeSessionId`) for O(1) lookups thereafter.
 * Driven by the busy→idle turn boundary (opencode has no hooks) + the sweep.
 * No-ops until a real (non-placeholder) title exists, when unchanged, or once the
 * user renamed the tab. Best-effort — never throws into the caller.
 */
export function autoNameOpencodeSession(terminalSessionId: string): void {
  const target = sessions.get(terminalSessionId);
  if (!target || target.type !== "opencode" || target.nameSource === "user") return;

  let ocId = target.claudeSessionId;
  if (!ocId) {
    const sinceMs = Date.parse(target.createdAt) || 0;
    ocId = discoverOpencodeSessionId({ cwd: target.cwd, sinceMs }) ?? undefined;
    if (!ocId) return; // opencode hasn't minted a session row yet (no prompt sent)
    target.claudeSessionId = ocId;
    try {
      getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [ocId, target.id]);
    } catch (e) {
      console.warn(`[Terminal] opencode session-id persist failed for ${target.id}:`, e);
    }
  }

  const title = deriveOpencodeSessionTitle(ocId);
  if (!title || title === target.name) return;

  target.name = title;
  target.nameSource = "auto";
  try {
    getDatabase().run(
      "UPDATE terminal_sessions SET name = ?, name_source = 'auto' WHERE id = ?",
      [title, target.id],
    );
  } catch (e) {
    console.warn(`[Terminal] opencode auto-name persist failed for ${target.id}:`, e);
  }
  broadcastTerminalSessions();
}

/** Safety-net sweep for opencode tabs (analogue of sweepAutoNameClaudeSessions):
 *  opencode's AI title can land a few seconds AFTER the busy→idle that triggered
 *  the first attempt, so a low-frequency re-check catches it. Idempotent. */
export function sweepAutoNameOpencodeSessions(): void {
  for (const s of sessions.values()) {
    if (s.type === "opencode" && s.nameSource !== "user") {
      try { autoNameOpencodeSession(s.id); } catch { /* best-effort */ }
    }
  }
}

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

/** Max spawned-agent ancestry depth (a top-level orchestrator's child = 1). */
const MAX_AGENT_DEPTH = 3;
/** Max live children per parent — a runaway parent can't fork unbounded PTYs. */
const MAX_CHILDREN_PER_PARENT = 5;

/** Count how many spawned-agent ancestors `sessionKey` has (0 = a top-level
 *  orchestrator that was not itself spawned). Walks parentSessionKey chains that
 *  point at known terminal sessions; a chat-topic parent ("topic:..") isn't in
 *  the map, so the walk simply stops there. */
function spawnedAgentDepth(sessionKey: string): number {
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
function boardAgentCap(): number {
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

/** Live children of a parent (present in the in-memory `sessions` map). */
function liveChildrenOf(parentSessionKey: string): TerminalSession[] {
  return Array.from(sessions.values()).filter(s => s.parentSessionKey === parentSessionKey);
}

/** Resolve a child the caller is allowed to drive, or null. The caller MUST be
 *  the child's recorded parent — this is the orchestrator's whole auth model. */
function resolveOwnedChild(parentSessionKey: string, agentId: string): TerminalSession | null {
  const child = sessions.get(agentId);
  if (!child || child.parentSessionKey !== parentSessionKey) return null;
  return child;
}

/** Hard-gate the /agents/* routes and the raw terminal send/buffer routes.
 *  spawn_agent launches `claude --dangerously-skip-permissions` with a
 *  caller-supplied prompt — arbitrary code execution — and the server binds
 *  0.0.0.0, so an UNGUARDED route would be unauthenticated RCE for any LAN
 *  peer / local process.
 *
 *  Two credentials are accepted, either one suffices:
 *   1. The DAEMON token (`Authorization: Bearer <64-hex>` or `X-Daemon-Token`),
 *      the same 32-byte secret `~/.topics/daemon-state.json` hands to
 *      `/__daemon/*` — the PRIMARY path. It is Topics' own credential: written
 *      by the running server, readable only by the user who owns the file, and
 *      re-read on every call so a rotation takes effect at once.
 *      It replaced the old per-agent `X-Agent-Token` (a pbkdf2 hash column on
 *      `agent_profiles`) when the named-agent roster was removed: nothing could
 *      mint one any more, so keeping it would have been a gate with no key.
 *   2. The shared GATEWAY_TOKEN (`x-gateway-token`) — kept for backward
 *      compatibility with the MCP bridge, but no longer REQUIRED. OpenClaw is
 *      dismissed; we must not depend on its secret for a core function.
 *
 *  The ownership guard on send/read/stop is defence-in-depth ON TOP of this,
 *  never instead of it. */
function agentAuthOk(req: Request): boolean {
  // Native daemon auth (Topics-owned). Read fresh so a rotated state file
  // applies immediately, exactly like the /__daemon/* gate in server.ts.
  try {
    const state = readState();
    if (state?.token) {
      const bearer = req.headers.get("authorization")?.match(/^Bearer\s+([0-9a-f]{64})$/i)?.[1] ?? "";
      const header = req.headers.get("x-daemon-token") || "";
      if (timingSafeEqualStr(bearer, state.token) || timingSafeEqualStr(header, state.token)) return true;
    }
  } catch {}
  // Legacy gateway token (retro-compat; unset ⇒ this path simply doesn't match).
  const expected = process.env.GATEWAY_TOKEN;
  if (expected && timingSafeEqualStr(req.headers.get("x-gateway-token") || "", expected)) {
    return true;
  }
  return false;
}

/** Kill every live child of a parent that just exited/was deleted. Children are
 *  model-spawned ephemerals, so orphaning them (leaving drivable PTYs with a
 *  dead owner) is worse than reaping them. */
function cascadeKillChildren(parentSessionKey: string) {
  for (const child of liveChildrenOf(parentSessionKey)) {
    try { sendToBridge({ type: "kill", id: child.id }); } catch {}
    // The bridge's `exit` frame will clean up maps/DB/tracker for each child.
  }
}

/** Seed a freshly-spawned `claude` TUI with its first prompt. The TUI isn't
 *  ready to accept input the instant the PTY spawns, and Enter must arrive as a
 *  separate frame to submit — so we bounded-poll the scrollback for a readiness
 *  signal, then write the prompt and (after a beat) a lone CR. Fire-and-forget:
 *  the child runs async; the parent reads its output via read_agent. */
async function seedAgentPrompt(childId: string, prompt: string): Promise<void> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const READY_HINTS = ["for shortcuts", "│ >", "╭─", "Bypassing", "Welcome to Claude"];
  // A distinctive fingerprint of the prompt AS IT RENDERS in the composer, robust
  // to line-wrapping: strip ANSI/box-drawing/whitespace so a prompt reflowed
  // across the input box's bordered lines still matches contiguously.
  const echoProbe = stripForEcho(prompt).slice(0, 20);

  // --- Readiness: wait for the input box to be drawn (best-effort, ~8s cap). ---
  let lastLen = -1, stableCount = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (!sessions.has(childId)) return; // child died before we could seed
    const buf = await getTerminalBuffer(childId);
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
    const seen = stripForEcho(await getTerminalBuffer(childId));
    if (!seen.includes(echoProbe)) {
      noteTerminalInput(childId);
      sendToBridge({ type: "write", id: childId, data: prompt });
    }
    for (let i = 0; i < 6; i++) { // ~1.8s for the echo to render
      await sleep(300);
      if (!sessions.has(childId)) return;
      if (stripForEcho(await getTerminalBuffer(childId)).includes(echoProbe)) { echoed = true; break; }
    }
  }
  if (!echoed) {
    // Never confirmed the echo (unusual composer, or a buffer we can't scrape).
    // Fire it blind so we still try rather than strand the agent, then submit.
    noteTerminalInput(childId);
    sendToBridge({ type: "write", id: childId, data: prompt });
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
      if (!child) return;
      if (childPromptAccepted(child)) return; // ✅ landed
    }
  }
  console.warn(`[Terminal] seedAgentPrompt: ${childId} never acknowledged its prompt (echoed=${echoed})`);
}

/** Normalize terminal text for echo-matching: drop ANSI escape sequences,
 *  box-drawing glyphs and ALL whitespace, lowercased — so a prompt wrapped across
 *  the composer's bordered lines collapses back to a contiguous string we can
 *  substring-match against the prompt's own fingerprint. */
function stripForEcho(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][0-9A-B]/g, "") // charset selects
    .replace(/[─-╿▀-▟]/g, "") // box drawing + block elements
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** True once a sub-agent has actually accepted its prompt — i.e. claude wrote the
 *  opening user turn, so a transcript for it now exists on disk. Runs discovery
 *  (which also adopts the real, claude-minted session id onto the session) so the
 *  check doubles as early id-capture. */
function childPromptAccepted(child: TerminalSession): boolean {
  if (child.claudeSessionId && fs.existsSync(claudeTranscriptPath(child.cwd, child.claudeSessionId))) return true;
  return resolveChildTranscriptSessionId(child);
}

interface AgentReadEvent { type: 'assistant' | 'tool_use'; text?: string; name?: string; input?: unknown; }

/** Pull the visible text out of an assistant transcript line. */
function assistantTextFromRaw(raw: any): string {
  const content = raw?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

/** Read a child's structured output from its durable .jsonl transcript (clean
 *  assistant text + tool calls, no ANSI/TUI noise), paging from a byte offset.
 *  Falls back to a raw scrollback scrape when the transcript hasn't been
 *  flushed yet (the first second of a session). */
async function readAgentOutput(
  child: TerminalSession,
  since: number,
): Promise<{ events: AgentReadEvent[]; nextOffset: number; source: "jsonl" | "buffer"; buffer?: string }> {
  if (child.claudeSessionId) {
    const path = claudeTranscriptPath(child.cwd, child.claudeSessionId);
    try {
      // Polled repeatedly by the MCP orchestrator (one poll per monitored
      // sub-agent) — async fs so growing transcripts never block the loop.
      const size = (await fs.promises.stat(path)).size;
      let start = Number.isFinite(since) && since >= 0 ? since : 0;
      if (start > size) start = 0; // file truncated/rotated — re-read from top
      if (start === size) return { events: [], nextOffset: size, source: "jsonl" };
      const fd = await fs.promises.open(path, "r");
      try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, start);
        const chunk = buf.toString("utf-8");
        const { lines, remainder } = splitJsonlChunk(chunk);
        // Re-read the partial last line next call by stopping the offset before it.
        const nextOffset = size - Buffer.byteLength(remainder, "utf-8");
        const events: AgentReadEvent[] = [];
        for (const line of lines) {
          const ev = parseJsonlLine(line);
          if (!ev) continue;
          if (ev.type === "assistant") {
            const text = assistantTextFromRaw(ev.raw);
            if (text) events.push({ type: "assistant", text });
          } else if (ev.type === "tool_use") {
            events.push({ type: "tool_use", name: ev.name, input: ev.input });
          }
          // user / tool_result / summary / other are intentionally skipped.
        }
        return { events, nextOffset, source: "jsonl" };
      } finally {
        await fd.close();
      }
    } catch {
      // No transcript yet → fall through to the raw buffer.
    }
  }
  const buffer = await getTerminalBuffer(child.id);
  return { events: [], nextOffset: Number.isFinite(since) ? since : 0, source: "buffer", buffer };
}

// Broadcast current terminal sessions list via WS
let _broadcastToAll: ((msg: OutboundMessage) => void) | null = null;
import type { OutboundMessage } from "../../shared/ws-outbound";
// Claude session tracker — the authoritative phase machine. Terminal claude
// sessions register here so their hook-driven phase (running/tool-running)
// becomes the solid "is it working" signal, instead of fragile pty bytes.
let _tracker: ClaudeSessionTracker | null = null;
function broadcastTerminalSessions() {
  if (!_broadcastToAll) return;
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
    command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
    topicId: s.topicId, type: s.type,
    // claudeSessionId lets the client map a claude-code pane to its phase in
    // the tracker (the authoritative loading signal).
    claudeSessionId: s.claudeSessionId || null,
    // Sub-agent parentage: lets the roster nest children under the orchestrator
    // that spawned them. null for human-/chat-created sessions.
    parentSessionKey: s.parentSessionKey || null,
    // Authoritative busy snapshot. Lets clients reconcile loading state from
    // the roster instead of relying solely on incremental terminal:activity
    // deltas (which are lost on server restart, WS reconnect, or a dropped
    // message → otherwise a finished session spins forever).
    busy: terminalActivity.get(s.id)?.busy ?? false,
  }));
  // `reconciled` dice se un `sessions: []` va creduto. Campo aggiuntivo, non
  // sostitutivo: i client vecchi continuano a leggere solo `sessions`.
  _broadcastToAll({ type: 'terminal:sessions', sessions: list, reconciled: rosterReconciled });
}

/**
 * Il ritiro di una sessione di terminale, in un posto solo.
 *
 * PERCHE' NON E' PIU' DENTRO LA `DELETE`. Era il corpo del gestore HTTP, quindi
 * l'unico modo di ritirare una sessione era che un client mandasse quella
 * richiesta. Ma il ritiro nasce anche da altre due parti — la cascata di una tab
 * chiusa (`services/pane-retirement-cascade.ts`) e il riconcilio al boot
 * (`services/retirement.ts#reconcile`) — e ognuna che si scrivesse da sola le
 * proprie pulizie e' esattamente il modo in cui questa sottoparte e' arrivata ad
 * avere tre registri. Sette conseguenze, tutte necessarie, tutte facili da
 * dimenticare: la PTY, i socket, la riga, la fase nel tracker, i timer di
 * attivita', i sotto-agenti, il browser che quella sessione aveva aperto.
 *
 * Ritorna `false` se non c'era niente da ritirare (ne' in memoria ne' nel DB):
 * al chiamante HTTP serve per il 404, agli altri due non cambia niente — su un
 * id sconosciuto e' un no-op, che e' la proprieta' che rende sicuro rigirare il
 * riconcilio.
 */
export function retireTerminalSession(id: string): boolean {
  const session = sessions.get(id);
  const db = getDatabase();
  const dbRow = db.query("SELECT id, claude_session_id, type FROM terminal_sessions WHERE id = ?").get(id) as any;
  if (!session && !dbRow) return false;
  // L'id della sessione claude va preso PRIMA di cancellare riga e mappa,
  // altrimenti la fase nel tracker resta appesa per la vita del server (la
  // mappa `terminalStates` si svuota solo da qui).
  const claudeSessionId: string | undefined = session?.claudeSessionId || dbRow?.claude_session_id || undefined;
  const sessionType: string | undefined = session?.type || dbRow?.type;
  if (session) {
    sendToBridge({ type: "kill", id });
    sessions.delete(id);
    const sockets = sessionSockets.get(id);
    if (sockets) {
      for (const ws of sockets) {
        try { ws.close(1000, "Session killed"); } catch {}
      }
    }
    sessionSockets.delete(id);
  }
  try { db.run("DELETE FROM terminal_sessions WHERE id = ?", [id]); } catch {}
  if (claudeSessionId && (sessionType === 'claude-code' || sessionType === 'claude-code-team')) {
    _tracker?.dropTerminalSession(claudeSessionId);
  }
  // Il bookkeeping per-sessione (timer busy + lastVisibleSig + lastInputAt). Il
  // percorso di uscita della PTY lo fa gia', ma un ritiro esplicito non ci
  // passa: senza questa riga quelle mappe crescevano per la vita del server.
  clearTerminalActivity(id);
  // I sotto-agenti che questa sessione ha generato: nessuna PTY orfana e
  // pilotabile resta dietro.
  cascadeKillChildren(id);
  // Il browser che questo terminale puo' aver aperto (contextId `term-<id>`).
  // Best-effort: nessun contesto = no-op innocuo.
  terminalBrowserCloser?.(`term-${id}`);
  broadcastTerminalSessions();
  return true;
}

/**
 * Parcheggia le sessioni Claude ferme da troppo: uccide la PTY, la riga resta.
 *
 * Le chat hanno un reaper di inattività (15 min) e un tetto di vita (2 ore); i
 * terminali agente non avevano né l'uno né l'altro. Misurate il 2026-08-02:
 * tredici `claude --resume` vive da tre giorni e cinque ore, ~15% di CPU e
 * 0,9 GB per sessioni ferme a un prompt.
 *
 * Non serve inventare il ripristino: uccidere la PTY fa scattare il percorso di
 * uscita qui sopra (caso "exit"), che per una sessione claude con un
 * `claude_session_id` marca la riga `dormant` e chiama `noteDormant` invece di
 * cancellarla. Da lì `POST /sessions/:id/revive` la rilancia con `--resume`, e
 * il client la rianima da solo quando la pane torna attiva.
 *
 * CHI si parcheggia lo decide `lib/terminal-idle-park.ts`, che è puro e ha 28
 * test: un reaper su questo sottosistema ha già ucciso turni vivi una volta.
 * Qui si raccolgono i fatti e si esegue.
 */
export interface ParkSweepResult {
  parked: string[];
  /** Chi NON e' stato parcheggiato e perche'. Un parcheggio che non si spiega e' un parcheggio che nessuno puo' smentire. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Il parcheggio di UNA sessione: raccoglie i fatti, chiede a `decidePark`, e se
 * il permesso c'è uccide la PTY.
 *
 * Estratta perche' i chiamanti sono due — il giro di inattivita' e quello delle
 * ORFANE (`motivo`) — e devono passare per gli STESSI cancelli. Un secondo
 * percorso con la sua copia dei controlli e' esattamente il modo in cui, fra sei
 * mesi, una condizione viene aggiunta da una parte sola.
 */
function tryParkSession(
  id: string,
  s: TerminalSession,
  thresholdMs: number,
  motivo: string,
): { parked: true } | { parked: false; reason: ParkRefusal } {
  const activity = terminalActivity.get(id);
  const phase = s.claudeSessionId ? (_tracker?.getSession(s.claudeSessionId)?.phase ?? null) : null;
  const decision = decidePark(
    {
      id,
      type: s.type,
      claudeSessionId: s.claudeSessionId,
      busy: activity?.busy ?? false,
      // Nessuna misura di attività = non lo sappiamo. `decidePark` rifiuta, ed
      // è voluto: trattare "mai visto" come "ferma da sempre" è il modo
      // classico di reapare qualcosa di vivo.
      idleMs: activity?.lastAt ? Date.now() - activity.lastAt : null,
      attachedClients: sessionSockets.get(id)?.size ?? 0,
      hasTranscript:
        !!s.claudeSessionId && fs.existsSync(claudeTranscriptPath(s.cwd, s.claudeSessionId)),
      phase,
    },
    thresholdMs,
  );
  if (!decision.park) return { parked: false, reason: decision.reason };

  // Un sotto-agente non si parcheggia da solo: lo governa il suo orchestratore
  // (cascadeKillChildren), e farlo sparire da sotto cambierebbe il conteggio
  // dei figli vivi senza che nessuno l'abbia chiesto.
  if (s.parentSessionKey) return { parked: false, reason: "sub-agent" };

  console.log(
    `[Terminal] Parcheggio ${id} (${s.type}) — ${motivo}, ferma da ` +
      `${Math.round((Date.now() - (activity?.lastAt ?? 0)) / 60_000)} min, nessun client attaccato. ` +
      `Torna con --resume alla prossima apertura.`,
  );
  sendToBridge({ type: "kill", id });
  // Il resto — riga a `dormant`, `noteDormant`, chiusura dei socket, broadcast
  // — lo fa il percorso di uscita quando il bridge conferma la morte della
  // PTY. Non lo si anticipa qui: due strade che scrivono lo stesso stato sono
  // due strade che possono divergere.
  return { parked: true };
}

export function parkIdleClaudeSessions(thresholdMs: number): ParkSweepResult {
  const parked: string[] = [];
  // `ParkRefusal` e non `string`: il motivo finisce in un log che lo traduce in
  // prosa (`refusalLabel`), e con `string` un motivo nuovo scritto a mano si
  // stamperebbe come `undefined` invece di rompere la compilazione.
  const skipped: Array<{ id: string; reason: ParkRefusal }> = [];
  for (const [id, s] of sessions) {
    const r = tryParkSession(id, s, thresholdMs, "nessuna attività");
    if (r.parked) parked.push(id);
    else skipped.push({ id, reason: r.reason });
  }
  // Una passata che non parcheggia niente deve dire PERCHE'. I motivi c'erano
  // gia' — raccolti in `skipped` e restituiti — ma vivevano solo come stringhe
  // in un valore di ritorno che nessuno stampava: dal log, «non ha parcheggiato»
  // e «non ha nemmeno guardato» erano la stessa cosa.
  if (skipped.length > 0) {
    console.log(`[Terminal] Passata di parcheggio: ${summarizeRefusals(skipped)}.`);
  }
  return { parked, skipped };
}

/**
 * Parcheggia le sessioni che il censimento ha giudicato ORFANE — quelle che
 * nessuna struttura di `ui_state` referenzia, cioè che nessuna finestra mostra e
 * che quindi nessun gesto umano può chiudere.
 *
 * PASSA DAGLI STESSI CANCELLI del giro di inattività, e non è prudenza
 * decorativa: «orfana» è un giudizio su ciò che è scritto in `ui_state`, e da
 * solo non sa niente di un turno in corso, di una PTY che sta scrivendo adesso o
 * di un transcript sparito dal disco. La soglia di inattività resta perché resta
 * il suo motivo — una sessione che ha appena stampato qualcosa non è ferma,
 * qualunque cosa dica il registro delle pane.
 *
 * Chi decide QUANDO si arriva qui (due censimenti consecutivi, `ui_state` non
 * vuoto, interruttore acceso) è `lib/orphan-park-policy.ts`. Qui si esegue.
 */
export function parkOrphanSessions(ids: readonly string[], thresholdMs: number): ParkSweepResult {
  const parked: string[] = [];
  const skipped: Array<{ id: string; reason: ParkRefusal }> = [];
  for (const id of ids) {
    const s = sessions.get(id);
    // Sparita fra il censimento e adesso: non c'è più niente da parcheggiare.
    if (!s) continue;
    const r = tryParkSession(id, s, thresholdMs, "nessuna interfaccia la mostra");
    if (r.parked) parked.push(id);
    else skipped.push({ id, reason: r.reason });
  }
  if (skipped.length > 0) {
    console.log(`[Terminal] Orfane non parcheggiate: ${summarizeRefusals(skipped)}.`);
  }
  return { parked, skipped };
}

export function createTerminalRouter(ctx: AppContext, tracker?: ClaudeSessionTracker): RouteHandler {
  const { json, readJSON, errorResponse, matchRoute } = ctx;
  _broadcastToAll = ctx.broadcastToAll;
  if (tracker) _tracker = tracker;

  // Connect to bridge and reconcile sessions (async, fire-and-forget)
  ensureBridge()
    .then(() => reconcileSessions())
    .then(() => broadcastTerminalSessions())
    .catch((err) => console.error("[Terminal] Bridge init failed:", err.message));

  // Parcheggio delle sessioni ferme. SPENTO se `TOPICS_TERMINAL_IDLE_PARK_MS`
  // non c'è, che è il default: vedi `idleParkThresholdMs` per il perché (una
  // sessione parcheggiata si vede, finché la pane non la rianima).
  const parkThresholdMs = idleParkThresholdMs(process.env);
  if (parkThresholdMs !== null) {
    // Si guarda ogni minuto, non ogni soglia: la soglia è quanto una sessione
    // dev'essere ferma, non ogni quanto la si controlla.
    const timer = setInterval(() => {
      try { parkIdleClaudeSessions(parkThresholdMs); }
      catch (err) { console.warn(`[Terminal] sweep di parcheggio fallito:`, (err as Error).message); }
    }, 60_000);
    timer.unref?.();
    console.log(
      `[Terminal] Parcheggio sessioni ferme attivo: soglia ${Math.round(parkThresholdMs / 60_000)} min.`,
    );
  }

  return async function terminalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // Standalone bundle (no PTY bridge): the terminal endpoints answer 503 with a
    // clear reason rather than trying to reach a bridge that isn't there. Scoped
    // TIGHTLY to the routes THIS router owns — the terminal API and the sub-agent
    // orchestrator (/api/sessions/:key/agents/*). NOT the whole /api/sessions/
    // prefix: processes.ts owns /api/sessions/:key/scripts/* (the process registry),
    // which is bridge-independent and must keep working standalone. Returning null
    // for anything else preserves the dispatcher's fall-through.
    if (isPtyBridgeDisabled() && (
      pathname === "/api/terminal" ||
      pathname.startsWith("/api/terminal/") ||
      /^\/api\/sessions\/[^/]+\/agents(\/|$)/.test(pathname)
    )) {
      return ptyBridgeUnavailable();
    }

    if (method === "GET" && pathname === "/api/terminal/sessions") {
      // Lazy cleanup: delete dormant SHELL sessions older than 1 hour.
      //
      // Claude-code sessions (those with a `claude_session_id`) are NEVER
      // auto-deleted: their transcript lives forever under ~/.claude/projects
      // and the row is just a resumable pointer to it. Deleting it by age —
      // as this query used to, keyed on `created_at` — silently lost a user's
      // long-running Claude work the moment it went dormant >1h after creation,
      // even if they used it 30s ago. Those sessions must survive indefinitely
      // (and across restarts) so they stay revivable. Only shells, which carry
      // no resumable state, are swept.
      //
      // The `type = 'shell'` guard is load-bearing, NOT cosmetic: codex rows
      // also carry a NULL claude_session_id (codex has no server-tracked resume
      // pointer — see the codex branch in createSession), so the old
      // `claude_session_id IS NULL` predicate ALONE swept codex too. A codex
      // pane parked dormant by a server restart (reconcileSessions' shell-like
      // else branch) was then hard-deleted after 1h, so the project-layout
      // auto-revive (/sessions/dormant?cwd=) could no longer relaunch it — the
      // "codex disappears" bug. Scoping to type='shell' keeps the original
      // shell sweep while letting dormant codex rows persist as revivable.
      try {
        const db = getDatabase();
        db.run("DELETE FROM terminal_sessions WHERE status = 'dormant' AND claude_session_id IS NULL AND type = 'shell' AND datetime(created_at) < datetime('now', '-1 hour')");
      } catch {}

      const filterTopicId = url.searchParams.get('topicId');
      let values = Array.from(sessions.values());
      if (filterTopicId) {
        values = values.filter(s => s.topicId === filterTopicId);
      }
      const list = values.map(s => ({
        id: s.id, name: s.name, createdAt: s.createdAt, cwd: s.cwd,
        command: s.command, clients: sessionSockets.get(s.id)?.size || 0,
        topicId: s.topicId, type: s.type,
        claudeSessionId: s.claudeSessionId || null,
        parentSessionKey: s.parentSessionKey || null,
        // Authoritative busy snapshot — see broadcastTerminalSessions.
        busy: terminalActivity.get(s.id)?.busy ?? false,
      }));
      return json(list);
    }

    if (method === "POST" && (pathname === "/api/terminal/sessions" || pathname === "/api/terminal/create")) {
      // Honor X-Idempotency-Key so the client can safely retry this POST after
      // a transient failure without spawning a duplicate pty. See the matching
      // logic in client/src/state/pane/adapters/closedTabRecord.ts.
      const idemKey = req.headers.get("x-idempotency-key");
      if (idemKey) {
        const existingId = idempotencyCache.lookup(idemKey);
        if (existingId) {
          const existing = sessions.get(existingId);
          if (existing) {
            return json({
              id: existing.id,
              name: existing.name,
              cwd: existing.cwd,
              command: existing.command,
              createdAt: existing.createdAt,
              topicId: existing.topicId,
              type: existing.type,
              claudeSessionId: existing.claudeSessionId || null,
            });
          }
        }
      }

      const body = await readJSON(req).catch(() => ({}));
      const suppliedCwd = typeof body.cwd === "string" && body.cwd ? body.cwd : null;
      // A cwd sent by a PAIRED DEVICE must sit inside a known project (or be
      // the broad default). The cwd of every terminal session becomes a root
      // of the file-route allowlist (`services/known-project-dirs.ts`, source
      // 4), so without this a phone with an owner cookie could open a shell in
      // `~/.ssh` and read it back through `/api/files/content`. Loopback is
      // exempt: it already holds a shell over the terminal socket, so a
      // refusal here would take nothing from it. Agents carry the daemon
      // token and are exempt for the same reason (they may pass `command`).
      if (suppliedCwd && ctx.requestIdentity?.(req)?.deviceId && !agentAuthOk(req)
        && !isClientCwdAccepted(suppliedCwd, ctx.resolveProjectPath)) {
        return errorResponse(400, "cwd must be inside a known project");
      }
      const cwd = suppliedCwd || process.env.HOME || "/";
      const id = crypto.randomUUID();
      const name = body.name || `Terminal ${sessions.size + 1}`;
      const command = body.command || undefined;
      const cols = body.cols || 120;
      const rows = body.rows || 30;
      const topicId = body.topicId || undefined;
      // Backward-compatible agent choice: absent/unknown `type` = shell, and
      // the pre-existing types behave exactly as before. 'codex' spawns the
      // OpenAI CLI interactively (see createSession).
      const sessionType: TerminalSessionType =
        body.type === 'claude-code-team' ? 'claude-code-team' :
        body.type === 'claude-code' ? 'claude-code' :
        body.type === 'codex' ? 'codex' :
        body.type === 'opencode' ? 'opencode' :
        body.type === 'kimi-code' ? 'kimi-code' : 'shell';
      const skipPermissions = body.skipPermissions !== false;
      const claudeSessionId = resumeIdForNewSession(body.claudeSessionId, sessionType);
      // `command` E' ESECUZIONE ARBITRARIA: createSession lo spezza e lo passa
      // al bridge come file + argv. Questa rotta non aveva nessun cancello,
      // mentre ogni rotta che si limita a LEGGERE lo scrollback ne ha uno; e il
      // server ascolta su 0.0.0.0, quindi era una shell per chiunque fosse sulla
      // LAN. Il cancello e' sul `command` e non sulla rotta intera perche' la UI
      // apre le sue tab senza (una shell di login, `claude`, `codex`) e chiuderla
      // del tutto vorrebbe dire un token nel client.
      if (command && !agentAuthOk(req)) return errorResponse(401, "unauthorized");

      try {
        await ensureBridge();
        // The add-menu always assigns a generic label (Shell / Claude Code /
        // Codex, see client terminalAgents.ts) or "Terminal N" — never a
        // user-typed name — so a fresh session is born 'default' (createSession's
        // default) and auto-naming may relabel it. Only a PATCH rename → 'user'.
        const session = await createSession(id, name, cwd, command, cols, rows, topicId, sessionType, skipPermissions, claudeSessionId);
        if (idemKey) idempotencyCache.remember(idemKey, id);
        broadcastTerminalSessions();
        return json({ id, name, cwd, command: session.command, createdAt: session.createdAt, topicId: session.topicId, type: session.type, claudeSessionId: session.claudeSessionId || null });
      } catch (err: any) {
        // Bridge couldn't spawn — return 502 so the client knows the
        // terminal really didn't start, instead of opening an empty
        // pane against a phantom session id.
        return errorResponse(502, `Failed to create terminal: ${err.message}`);
      }
    }

    // READ a session's scrollback as text (interactive-claude-primitive AD-2).
    // Token-gated like every /agents/* route: the buffer leaks the full terminal
    // scrollback (secrets, command output, model reasoning) and the server binds
    // 0.0.0.0, so an ungated read is a LAN data-exfil hole. agentAuthOk checks the
    // shared GATEWAY_TOKEN — the in-app/MCP callers already present it; the human
    // UI never hits this route (terminal I/O is over the WebSocket bridge).
    const bufferMatch = matchRoute(pathname, "/api/terminal/sessions/:id/buffer");
    if (method === "GET" && bufferMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const buffer = await getTerminalBuffer(bufferMatch.id);
      return json({ id: bufferMatch.id, buffer });
    }

    // GET /api/terminal/sessions/:id/screen — lo SCHERMO, non lo scrollback.
    //
    // `/buffer` restituisce i byte scritti dalla PTY: su un programma che
    // ridisegna in place (un menu con le frecce, una barra) contiene TUTTE le
    // versioni della stessa riga e non dice quale è quella attuale. Un agente
    // che lo legge vede la storia e non lo stato: non sa quale voce è
    // evidenziata, ne' se il tasto che ha premuto e' arrivato.
    //
    // Qui il flusso viene rigiocato su un emulatore headless e si restituisce
    // la griglia. Stesso gate di `/buffer`: e' la stessa informazione, resa
    // leggibile — se una e' un buco di esfiltrazione sulla LAN lo e' anche
    // l'altra.
    const screenMatch = matchRoute(pathname, "/api/terminal/sessions/:id/screen");
    if (method === "GET" && screenMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const stream = await getTerminalBuffer(screenMatch.id);
      // Le dimensioni VERE della sessione: rigiocare a una larghezza diversa
      // manda a capo dove il programma non l'aveva fatto, e il risultato
      // somiglia allo schermo senza esserlo.
      const sess = sessions.get(screenMatch.id);
      const screen = await renderScreen(stream, {
        cols: sess?.cols,
        rows: sess?.rows,
        trimTrailingBlank: url.searchParams.get("full") !== "1",
      });
      return json({
        id: screenMatch.id,
        lines: screen.lines,
        text: screenToText(screen),
        cursor: screen.cursor,
        cols: screen.cols,
        rows: screen.rows,
      });
    }

    // WRITE raw input straight into the PTY. On these
    // `claude --dangerously-skip-permissions` sessions that is arbitrary code
    // execution, and the server binds 0.0.0.0 — so an ungated /send is
    // unauthenticated LAN RCE. Gate on the shared GATEWAY_TOKEN exactly like the
    // /agents/* write routes (the human UI types over the WebSocket bridge, not here).
    const sendMatch = matchRoute(pathname, "/api/terminal/sessions/:id/send");
    if (method === "POST" && sendMatch) {
      if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
      const session = sessions.get(sendMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const input = body.input || body.text || body.data || "";
      if (!input) return errorResponse(400, "No input provided");
      noteTerminalInput(sendMatch.id);
      sendToBridge({ type: "write", id: sendMatch.id, data: input });
      return json({ ok: true, sent: input.length });
    }

    const resizeMatch = matchRoute(pathname, "/api/terminal/sessions/:id/resize") || matchRoute(pathname, "/api/terminal/:id/resize");
    if (method === "POST" && resizeMatch) {
      const session = sessions.get(resizeMatch.id);
      if (!session) return errorResponse(404, "Terminal session not found");
      const body = await readJSON(req).catch(() => ({}));
      const { cols, rows } = body;
      if (cols && rows) {
        session.cols = cols;
        session.rows = rows;
        // Stamp BEFORE forwarding so the SIGWINCH repaint this provokes is
        // recognised as resize-driven (not process work) by the data handler.
        noteTerminalResize(resizeMatch.id);
        sendToBridge({ type: "resize", id: resizeMatch.id, cols, rows });
      }
      return json({ ok: true });
    }

    const deleteMatch = matchRoute(pathname, "/api/terminal/sessions/:id") || matchRoute(pathname, "/api/terminal/:id");
    if (method === "DELETE" && deleteMatch) {
      // Il fatto PRIMA delle conseguenze: se il processo muore a meta' ritiro,
      // il riconcilio al boot sa che quella sessione andava ritirata e finisce
      // il lavoro. Timbrare dopo avrebbe lasciato lo stato esattamente dove il
      // guasto lo lasciava — riga viva, nessuno che sa perche'.
      recordRetirement(getDatabase(), "terminal", deleteMatch.id, new Date().toISOString(), "tab-close");
      if (!retireTerminalSession(deleteMatch.id)) return errorResponse(404, "Terminal session not found");
      return json({ ok: true });
    }

    // --- Rename a terminal session (PATCH name) ---
    // Lets the user give a started Claude Code session a meaningful label for
    // organisation. Marks the name 'user' so the auto-namer leaves it alone.
    // Updates the live in-memory session (if mounted) AND the persisted row (so
    // the name survives a restart / applies to a dormant session), then
    // re-broadcasts the roster so every client tab relabels.
    const renameMatch = matchRoute(pathname, "/api/terminal/sessions/:id");
    if (method === "PATCH" && renameMatch) {
      let body: any;
      try { body = await readJSON(req); } catch { return errorResponse(400, "Body must be JSON"); }
      if (!body || typeof body.name !== "string") {
        return errorResponse(400, "name (string) is required");
      }
      // Collapse internal whitespace/newlines and cap the length so a pasted
      // blob can't break the tab strip.
      const name = body.name.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!name) return errorResponse(400, "name must not be empty");

      const session = sessions.get(renameMatch.id);
      const db = getDatabase();
      const dbRow = db.query("SELECT id FROM terminal_sessions WHERE id = ?").get(renameMatch.id) as any;
      if (!session && !dbRow) return errorResponse(404, "Terminal session not found");

      if (session) { session.name = name; session.nameSource = 'user'; }
      try { db.run("UPDATE terminal_sessions SET name = ?, name_source = 'user' WHERE id = ?", [name, renameMatch.id]); } catch {}

      broadcastTerminalSessions();
      return json({ ok: true, id: renameMatch.id, name });
    }

    // --- Dormant sessions: list and revive ---

    if (method === "GET" && pathname === "/api/terminal/sessions/dormant") {
      const db = getDatabase();
      const cwd = url.searchParams.get('cwd');
      const rows = cwd
        ? db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant' AND cwd = ?").all(cwd) as any[]
        : db.query("SELECT * FROM terminal_sessions WHERE status = 'dormant'").all() as any[];
      const list = rows.map((r: any) => ({
        id: r.id, name: r.name, cwd: r.cwd, command: r.command,
        type: r.type, createdAt: r.created_at,
        claudeSessionId: r.claude_session_id || null,
        skipPermissions: r.skip_permissions !== 0,
      }));
      return json(list);
    }

    const reviveMatch = matchRoute(pathname, "/api/terminal/sessions/:id/revive");
    if (method === "POST" && reviveMatch) {
      const db = getDatabase();
      // Already awake: answer with the live session instead of building a second
      // PTY over it. A revive is idempotent from the caller's point of view, and
      // the losing client of a double-click must not be told "not found" for a
      // tab that is right there.
      const revivedShape = (s: TerminalSession) => ({
        id: s.id, name: s.name, cwd: s.cwd,
        command: s.command, type: s.type,
        claudeSessionId: s.claudeSessionId || null,
      });
      const already = sessions.get(reviveMatch.id);
      if (already) return json(revivedShape(already));

      // Serialize on the id: see `revivingSessions`. The loser does NOT get a
      // 409 — it awaits the winner and answers with the same session. One
      // double-click must produce ONE terminal, and the scrollback is the
      // winner's PTY, not a fresh one.
      const inFlight = revivingSessions.get(reviveMatch.id);
      if (inFlight) {
        try {
          return json(revivedShape(await inFlight));
        } catch (err: any) {
          return errorResponse(500, `Failed to revive session: ${err.message}`);
        }
      }
      const row = db.query("SELECT * FROM terminal_sessions WHERE id = ? AND status = 'dormant'").get(reviveMatch.id) as any;
      if (!row) return errorResponse(404, "Dormant session not found");
      // Registered BEFORE the first await: between here and the bridge ack there
      // is nothing to serialise on otherwise, and that window is exactly where
      // the double click lands.
      const revival = (async (): Promise<TerminalSession> => {
        await ensureBridge();
        const session = await createSession(
          row.id, row.name, row.cwd, undefined,
          row.cols || 120, row.rows || 30,
          row.topic_id || undefined,
          row.type || 'shell',
          row.skip_permissions !== 0,
          row.claude_session_id || undefined,
          row.parent_session_key || undefined,
          (row.name_source as 'default' | 'auto' | 'user') || 'default',
        );
        // Mark as active
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [row.id]); } catch {}
        broadcastTerminalSessions();
        return session;
      })();
      revivingSessions.set(reviveMatch.id, revival);
      try {
        return json(revivedShape(await revival));
      } catch (err: any) {
        return errorResponse(500, `Failed to revive session: ${err.message}`);
      } finally {
        revivingSessions.delete(reviveMatch.id);
      }
    }

    // Restart a LIVE (or dormant) session in place, preserving its id. For
    // claude-code/codex with a claude_session_id this relaunches with --resume
    // (conversation preserved); for shell it starts a fresh PTY in the same cwd.
    // Used by the tab right-click "Ricarica" to unstick a wedged session (e.g. a
    // claude CLI latched on "Not logged in" after a transient proxy auth gap)
    // without CLI surgery or restarting the app.
    const reloadMatch = matchRoute(pathname, "/api/terminal/sessions/:id/reload");
    if (method === "POST" && reloadMatch) {
      const id = reloadMatch.id;
      // Serialize: a concurrent reload of the same id would race the kill→recreate.
      if (reloadingSessionIds.has(id)) {
        return errorResponse(409, "Reload already in progress for this session");
      }
      reloadingSessionIds.add(id);
      try {
        const db = getDatabase();
        const live = sessions.get(id);
        const dbRow = db.query("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as any;
        if (!live && !dbRow) return errorResponse(404, "Terminal session not found");
        // Capture the recreation snapshot BEFORE the kill — the exit handler may
        // DELETE the row (shell) or mark it dormant (claude), so we must not rely
        // on the DB row surviving the kill.
        const snap = {
          id,
          name: live?.name ?? dbRow?.name ?? "Terminal",
          cwd: live?.cwd ?? dbRow?.cwd ?? process.cwd(),
          cols: live?.cols ?? dbRow?.cols ?? 120,
          rows: live?.rows ?? dbRow?.rows ?? 30,
          topicId: (live?.topicId ?? dbRow?.topic_id ?? undefined) as string | undefined,
          type: (live?.type ?? dbRow?.type ?? 'shell') as TerminalSessionType,
          skipPermissions: live ? live.skipPermissions : (dbRow?.skip_permissions !== 0),
          claudeSessionId: (live?.claudeSessionId ?? dbRow?.claude_session_id ?? undefined) as string | undefined,
          parentSessionKey: (live?.parentSessionKey ?? dbRow?.parent_session_key ?? undefined) as string | undefined,
        };
        // Kill the live PTY and wait for it to ACTUALLY exit before recreating.
        // We must not recreate while the old PTY may still die later: the bridge
        // 'exit' event is keyed by id only (no pid/generation), so a late exit of
        // the old PTY would tear down the freshly recreated session (close its
        // sockets + delete its row). So: recreate ONLY once the old PTY is gone;
        // if it refuses to die in time, bail with 503 rather than risk that race.
        if (sessions.has(id)) {
          sendToBridge({ type: "kill", id });
          for (let i = 0; i < 24 && sessions.has(id); i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          if (sessions.has(id)) {
            return errorResponse(503, "Session did not stop in time. Please retry.");
          }
        }
        await ensureBridge();
        // command=undefined (like the revive endpoint): a shell re-resolves to
        // `$SHELL -l`; claude/codex build their command from `type` + claudeSessionId
        // (--resume). Forwarding the stored, already-resolved shell path would drop
        // the login-shell (-l) flag.
        const session = await createSession(
          snap.id, snap.name, snap.cwd, undefined,
          snap.cols, snap.rows, snap.topicId, snap.type,
          snap.skipPermissions, snap.claudeSessionId, snap.parentSessionKey,
        );
        try { db.run("UPDATE terminal_sessions SET status = 'active' WHERE id = ?", [snap.id]); } catch {}
        broadcastTerminalSessions();
        return json({ id: session.id, type: session.type, claudeSessionId: session.claudeSessionId || null });
      } catch (err: any) {
        return errorResponse(500, `Failed to reload session: ${err.message}`);
      } finally {
        reloadingSessionIds.delete(id);
      }
    }

    // Cleanup: delete dormant sessions older than 1 hour (lazy, on each GET sessions call)
    // (This runs in the GET /api/terminal/sessions handler above, no separate endpoint needed)

    // (Image paste is now handled entirely client-side: the terminal pane writes
    // the pasted image to the system clipboard natively — NSPasteboard under
    // Tauri, the browser Clipboard API on the web — then sends Ctrl+V. The old
    // server endpoint used `osascript`, which triggered a macOS "control
    // iTunes/Music" Automation prompt; it has been removed.)

    // --- Sub-agent orchestrator: /api/sessions/:sessionKey/agents/* ----------
    // :sessionKey is the CALLER (parent) — the MCP bridge passes the caller's
    // own sessionKey. spawn stamps it as the child's parentSessionKey; send/read/
    // stop are ownership-guarded against it. Token-gated when GATEWAY_TOKEN is
    // set. These are the ONLY cross-session control surface exposed to a model;
    // the raw by-id /send and /buffer routes above remain human/legacy-only.
    {
      const spawnM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/spawn");
      const listM = matchRoute(pathname, "/api/sessions/:sessionKey/agents");
      const sendM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/send");
      const readM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/read");
      const stopM = matchRoute(pathname, "/api/sessions/:sessionKey/agents/:agentId/stop");

      if (spawnM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(spawnM.sessionKey);
        const body = await readJSON(req).catch(() => ({}));
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt) return errorResponse(400, "prompt (string) is required");
        if (spawnedAgentDepth(parentKey) + 1 > MAX_AGENT_DEPTH) {
          return errorResponse(429, `sub-agent depth limit (${MAX_AGENT_DEPTH}) reached`);
        }
        if (liveChildrenOf(parentKey).length >= MAX_CHILDREN_PER_PARENT) {
          return errorResponse(429, `max ${MAX_CHILDREN_PER_PARENT} live sub-agents per session`);
        }
        // Il governo della board, e vale SOLO per chi appartiene a un task: una
        // chat dell'umano passa di qui senza che questo blocco la veda. Chi
        // invece è la sessione di un task dispatchato spende il tetto di
        // concorrenza della board come chiunque altro, e una figlia non apre
        // nipoti. Vedi `agent-census.ts` per il perché di entrambi.
        {
          const refusal = boardSpawnRefusal(getDatabase(), { parentSessionKey: parentKey, cap: boardAgentCap() });
          if (!refusal.ok) {
            return refusal.code === "depth"
              ? errorResponse(429, "sub-agent depth limit (1) reached: a board sub-agent cannot spawn its own")
              : errorResponse(429, `board concurrency cap reached (${refusal.live}/${refusal.cap} live agents)`);
          }
        }
        const parent = sessions.get(parentKey);
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : (parent?.cwd || process.env.HOME || "/");
        const id = crypto.randomUUID();
        const name = typeof body.name === "string" && body.name ? body.name : `agent ${id.slice(0, 8)}`;
        try {
          await ensureBridge();
          const session = await createSession(id, name, cwd, undefined, 120, 30, undefined, "claude-code", true, undefined, parentKey);
          // Fingerprint the opening prompt so transcript-discovery can find the
          // .jsonl claude actually writes (it ignores our pre-assigned
          // --session-id for sub-agents — see resolveChildTranscriptSessionId).
          session.spawnPromptSnippet = normalizePromptSnippet(prompt);
          // The roster broadcast carries parentSessionKey, so the sub-agent
          // immediately appears nested under its parent in the sidebar tree.
          broadcastTerminalSessions();
          // Seed the first prompt once the TUI is ready (async, non-blocking).
          seedAgentPrompt(id, prompt)
            .catch((err) => console.warn(`[Terminal] seedAgentPrompt failed for ${id}:`, err));
          // Discover + adopt the child's REAL transcript id shortly after start,
          // so the wake/read paths deliver its actual final result (not "senza
          // output") even when the orchestrator never polls it.
          scheduleClaudeSubAgentIdCapture(id);
          return json({ agentId: id, name: session.name, cwd: session.cwd });
        } catch (err: any) {
          return errorResponse(502, `Failed to spawn sub-agent: ${err.message}`);
        }
      }

      if (listM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(listM.sessionKey);
        const agents = liveChildrenOf(parentKey).map(s => ({
          agentId: s.id,
          name: s.name,
          cwd: s.cwd,
          claudeSessionId: s.claudeSessionId || null,
          busy: terminalActivity.get(s.id)?.busy ?? false,
        }));
        return json({ agents });
      }

      if (sendM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(sendM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(sendM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const body = await readJSON(req).catch(() => ({}));
        const input = typeof body.input === "string" ? body.input : (typeof body.text === "string" ? body.text : "");
        if (!input) return errorResponse(400, "input (string) is required");
        noteTerminalInput(child.id);
        sendToBridge({ type: "write", id: child.id, data: input });
        // Submit it: Enter as a separate frame so the TUI acts on the line.
        await new Promise(r => setTimeout(r, 120));
        noteTerminalInput(child.id);
        sendToBridge({ type: "write", id: child.id, data: "\r" });
        return json({ ok: true, sent: input.length });
      }

      if (readM && method === "GET") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(readM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(readM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const since = Number(url.searchParams.get("since") || "0");
        const result = await readAgentOutput(child, since);
        return json(result);
      }

      if (stopM && method === "POST") {
        if (!agentAuthOk(req)) return errorResponse(401, "unauthorized");
        const parentKey = decodeURIComponent(stopM.sessionKey);
        const child = resolveOwnedChild(parentKey, decodeURIComponent(stopM.agentId));
        if (!child) return errorResponse(404, "sub-agent not found");
        const childClaudeId = child.claudeSessionId;
        sendToBridge({ type: "kill", id: child.id });
        sessions.delete(child.id);
        const sockets = sessionSockets.get(child.id);
        if (sockets) {
          for (const ws of sockets) { try { ws.close(1000, "Sub-agent stopped"); } catch {} }
          sessionSockets.delete(child.id);
        }
        try { getDatabase().run("DELETE FROM terminal_sessions WHERE id = ?", [child.id]); } catch {}
        if (childClaudeId) _tracker?.dropTerminalSession(childClaudeId);
        clearTerminalActivity(child.id);
        broadcastTerminalSessions();
        // Reaping a sub-agent via /stop is the primary way an orchestrator ends a
        // delegated task — wake its parent chat with the result here, because the
        // pre-delete above makes the bridge `exit` frame unable to (session gone).
        wakeParentTopicOnChildExit(child, null);
        return json({ ok: true });
      }
    }

    return null;
  };
}

export function handleTerminalWebSocket(ws: any, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, "Session not found");
    return;
  }

  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    console.warn(`[Terminal] session ${sessionId} not initialized; creating socket set`);
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(ws);

  // Request output buffer from bridge (async). The buffered scrollback is
  // delivered as ONE binary frame, then we follow it with a `replay-end`
  // control frame (text/JSON) so the client knows where the historical
  // replay ends and live output begins. Without this signal the tab-bar
  // "in-progress" spinner lights up for ~1.5 s on every focus of an idle
  // Claude Code session, just from the backlog being flushed.
  requestBuffer(sessionId).then((buffered) => {
    try {
      // The scrollback is the single most compressible frame this server sends:
      // it is a screen of repeated escape sequences, and it goes out once per
      // focus of a terminal tab.
      if (buffered.byteLength > 0) {
        ws.send(buffered, shouldCompressFrame({ type: null, bytes: buffered.byteLength, remote: ws.data.remote === true }));
      }
      // Always send the marker, even on empty backlog — the client uses
      // it as the gate to start broadcasting `terminal:activity` pulses.
      ws.send(JSON.stringify({ type: "replay-end" }));
    } catch {}
  });

  return {
    message(data: string | Buffer | ArrayBuffer) {
      const input = typeof data === "string" ? data : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      noteTerminalInput(sessionId);
      /* A KEYSTROKE MUST NOT THROW OUT OF A SOCKET HANDLER.
       *
       * `sendToBridge` throws `Bridge not connected`, and this is the keyboard
       * path: the exception escapes into the WS handler while the bridge is
       * reconnecting. Measured on 2026-08-21: 432 `Bridge not connected` lines
       * in `topics-server.log`, 213 with a `sendToBridge` stack, around 51 of
       * them on this path.
       *
       * The key is dropped, and that is the correct outcome: it is NOT buffered
       * across the reconnect. The PTY on the other side is not the same one any
       * more, it is a freshly `--resume`d process, and replaying a `2\r` that
       * answered a prompt which no longer exists injects input into a program
       * in a different state. Better a lost keystroke than a wrong one.
       */
      try {
        sendToBridge({ type: "write", id: sessionId, data: input });
      } catch (err) {
        noteDroppedInput(sessionId, err);
      }
    },
    close() {
      const s = sessionSockets.get(sessionId);
      if (s) s.delete(ws);
    },
  };
}

// Exported for graceful shutdown — disconnects from bridge without killing it
export function disconnectBridge() {
  if (bridgeSocket && !bridgeSocket.destroyed) {
    bridgeSocket.destroy();
  }
  bridgeSocket = null;
  bridgeReady = false;
}
