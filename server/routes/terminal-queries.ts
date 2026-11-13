import { getDatabase } from "../db";
import { registerFleetSessionSource, type FleetSessionRef } from "../lib/fleet-usage";
import { resolveSessionProjects } from "../lib/session-project-map";
import { listSessionCliPids } from "../providers/session-pids";
import { renderScreen, screenToText } from "../lib/terminal-screen";
import type { LiveTerminal } from "../../shared/live-terminals";
import { promptAsPaste } from "../lib/subagent-seed";
import { type TerminalSession, sessionSockets, sessions, terminalActivity } from "./terminal-state";
import { noteTerminalInput } from "./terminal-activity";
import { bridgeReady, pendingBufferRequests } from "./terminal-bridge-socket";
import { PASTE_MIN_BYTES, isPlainText, sendToBridge } from "./terminal-bridge-send";

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
/**
 * Every PTY that is an AGENT, with the pid of its CLI, for the swap freezer.
 *
 * Two things it needs and `getFleetSessionRefs` cannot give: shell panes are
 * excluded (a person types in those, and nothing of theirs is ever signalled),
 * and the `claudeSessionId` comes along - the hook payloads that say which of an
 * agent's commands runs in the background are keyed by it
 * (`lib/background-bash-record.ts`).
 */
export function getAgentPtyCliPids(): { sessionId: string; pid: number; topicId: string | null; claudeSessionId: string | null }[] {
  const out: { sessionId: string; pid: number; topicId: string | null; claudeSessionId: string | null }[] = [];
  for (const s of sessions.values()) {
    if (!s.ptyPid || s.ptyPid <= 0 || s.type === "shell") continue;
    out.push({
      sessionId: s.id,
      pid: s.ptyPid,
      topicId: s.topicId ?? null,
      claudeSessionId: s.claudeSessionId ?? null,
    });
  }
  return out;
}

/**
 * The PTYs as owners of work, for the per-session consumption: who started
 * each one (a sub-agent names its coordinator), which topic it belongs to and
 * whether it is producing output right now.
 */
export interface TerminalOwner {
  id: string;
  name: string;
  topicId: string | null;
  parentSessionKey: string | null;
  createdAt: string;
  busy: boolean;
  pid: number | null;
}

export function listTerminalOwners(): TerminalOwner[] {
  const out: TerminalOwner[] = [];
  for (const s of sessions.values()) {
    out.push({
      id: s.id, name: s.name, topicId: s.topicId ?? null, parentSessionKey: s.parentSessionKey ?? null,
      createdAt: s.createdAt, busy: terminalActivity.get(s.id)?.busy ?? false,
      pid: s.ptyPid && s.ptyPid > 0 ? s.ptyPid : null,
    });
  }
  return out;
}

export function getFleetSessionRefs(): FleetSessionRef[] {
  const out: FleetSessionRef[] = [];
  const seen = new Set<string>();
  for (const s of sessions.values()) {
    if (!s.ptyPid || s.ptyPid <= 0) continue;
    seen.add(s.id);
    out.push({ sessionId: s.id, name: s.name, pid: s.ptyPid, ...(s.topicId ? { topicId: s.topicId } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) });
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

  // WHICH PROJECT each of those belongs to, in ONE query for the whole batch.
  //
  // A terminal knows its topic by uuid and a chat is addressed by its session
  // key; `resolveSessionProjects` answers both shapes from the same statement,
  // so this stays one round trip however many sessions are alive. A terminal
  // opened outside any topic falls back to its own `cwd`, which is the only
  // project it can honestly claim.
  //
  // The whole block is best-effort: without it every row keeps its memory and
  // CPU exactly as before and simply carries no project.
  try {
    const keys: string[] = [];
    for (const r of out) keys.push(r.topicId ?? r.sessionId);
    const projects = resolveSessionProjects(getDatabase(), keys);
    for (const r of out) {
      const hit = projects.get(r.topicId ?? r.sessionId);
      if (hit) {
        if (!r.topicId) r.topicId = hit.topicId;
        if (hit.projectPath) { r.projectPath = hit.projectPath; r.projectSource = "topic"; }
      }
      if (!r.projectPath && r.cwd) { r.projectPath = r.cwd; r.projectSource = "cwd"; }
    }
  } catch { /* attribution is a decoration, the measurement is the point */ }

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

/**
 * Topics' PTYs in `lib/live-terminals` shape, for the single live-terminals
 * list. Sub-agents stay out: they have a parent driving them, and in the menu
 * they would be rows nobody should drive by hand.
 */
export function listTopicsLiveTerminals(): LiveTerminal[] {
  const out: LiveTerminal[] = [];
  for (const [id, s] of sessions) {
    if (s.parentSessionKey) continue;
    out.push({
      id: `topics:${id}`,
      source: "topics",
      title: s.name,
      command: s.type === "shell" ? "shell" : s.type,
      cwd: s.cwd || null,
      tty: null,
      busy: terminalActivity.get(id)?.busy ?? false,
      sessionId: id,
    });
  }
  return out;
}

/** A Topics PTY screen (not the scrollback): same rendering as `/screen`. */
export async function readTopicsTerminalScreen(id: string): Promise<string | null> {
  const sess = sessions.get(id);
  if (!sess) return null;
  const screen = await renderScreen(await getTerminalBuffer(id), { cols: sess.cols, rows: sess.rows, trimTrailingBlank: true });
  return screenToText(screen);
}

/** Writes into the PTY like the `/send` route. false = session gone. */
export function writeTopicsTerminal(id: string, data: string): boolean {
  if (!sessions.has(id)) return false;
  noteTerminalInput(id);
  // live-terminals and the gateway send `text + "\r"` in one string. Split the
  // Enter off so a long text for a Claude TUI can go as a paste (the Enter stays
  // a keystroke, a little later so the TUI has taken the paste first).
  const type = sessions.get(id)?.type;
  const claudeTui = type === "claude-code" || type === "claude-code-team";
  const m = /^([^\r]*)(\r?)$/.exec(data);
  if (claudeTui && m && Buffer.byteLength(m[1], "utf8") > PASTE_MIN_BYTES && isPlainText(m[1])) {
    sendToBridge({ type: "write", id, data: promptAsPaste(m[1]) });
    if (m[2]) {
      setTimeout(() => {
        try { if (sessions.has(id)) sendToBridge({ type: "write", id, data: "\r" }); } catch { /* bridge went away */ }
      }, PASTE_ENTER_DELAY_MS);
    }
    return true;
  }
  sendToBridge({ type: "write", id, data });
  return true;
}

/** Pause between a pasted text and its Enter, so the TUI has absorbed the paste. */
export const PASTE_ENTER_DELAY_MS = 150;

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
  return bytes ? new TextDecoder().decode(bytes) : "";
}

// Le sessioni vive col loro pid di testa, per l'attribuzione per-sessione.
// Registrata come funzione, non come snapshot: l'insieme cambia a ogni
// create/exit e va letto al momento del campionamento, non a import time.
registerFleetSessionSource(getFleetSessionRefs);

// --- Buffer request from bridge ---
/**
 * The session's scrollback as the bridge holds it, or `null` when the bridge
 * did not hand it over: not connected, the write failed, or no answer within
 * a second.
 *
 * `null` and an empty buffer are different facts and must stay apart. An empty
 * answer means the bridge has nothing for this id, which is how a gone PTY
 * looks; no answer means nothing at all. Both used to come back as zero bytes,
 * and under load (2026-10-15, `[LAG]` stops of 1.3-1.7 s) the attach of a live
 * claude idle on a question replayed nothing and its pane went under the
 * `terminal.dormant.title` veil.
 */
export function requestBuffer(sessionId: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (!bridgeReady) { resolve(null); return; }
    const existing = pendingBufferRequests.get(sessionId) || [];
    existing.push(resolve);
    pendingBufferRequests.set(sessionId, existing);
    // Each request expires on its own: a second attach to the same id must not
    // be failed by the first one's deadline.
    const expire = () => {
      const cbs = pendingBufferRequests.get(sessionId);
      const i = cbs ? cbs.indexOf(resolve) : -1;
      if (!cbs || i < 0) return;
      cbs.splice(i, 1);
      if (cbs.length === 0) pendingBufferRequests.delete(sessionId);
      resolve(null);
    };
    try {
      sendToBridge({ type: "buffer", id: sessionId });
    } catch {
      expire();
      return;
    }
    setTimeout(expire, 1000);
  });
}
