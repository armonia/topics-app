import { getDescendantPids, getPidStartTimes } from "../lib/process-tree";
import { getSessionCliPid } from "../providers/session-pids";
import { backgroundShellBanner, shellProcessKey } from "../../shared/background-shell-registry";
import { pushBackgroundChanged } from "../lib/command-background";
import { SERVICE_END_SHOWN_MS } from "../lib/command-services";
import { recordServerSpawn } from "../lib/spawn-metrics";
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";
import { isPidAlive, livePids } from "../lib/pid-liveness";
import { commandServiceWatch } from "./processes-commands";
import { addToRecent, appendOutput, followLog, pumpTail } from "./processes-output";
import { invalidateScriptsCache, loadProcessRegistry, pidStartTime, saveState } from "./processes-persist";
import { broadcastScriptsUpdate } from "./processes-snapshot";
import { type ScriptProcess, recentScripts, runningScripts, _broadcastCtx } from "./processes-state";

// ── Review-ready preview servers ─────────────────────────────────────────────
// The preview-manager boots one dev server per task from its worktree at
// review-time. Surface it in the Processes panel (Stop button + port link) so a
// human can see/kill it. Registered as a `script` entry (not `detected`, which
// the detector reconcile would reap) keyed by task, so teardown removes exactly
// one. Ports fill in via the lsof-by-pid path on the HTTP serialize.
// CHIAVE = task + PORTA. Con la sola parte del task, una seconda accensione
// (porta diversa, per esempio dopo che la prima si era prosciugata) SOVRASCRIVEVA
// la riga che teneva il pid vecchio: quel processo restava vivo senza nessuna
// riga, quindi senza bottone Stop e senza nessuno che lo spazzasse, con la sua
// porta occupata per sempre. Il prefisso resta comune cosi' `unregister` puo'
// togliere ogni accensione dello stesso task.
const previewProcessPrefix = (taskId: string) => `preview:${taskId.slice(0, 8)}:`;
const previewProcessKey = (taskId: string, port: number) => `${previewProcessPrefix(taskId)}${port}`;

export function registerPreviewProcess(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void {
  loadProcessRegistry();
  const processId = previewProcessKey(entry.taskId, entry.port);
  runningScripts.set(processId, {
    processId,
    scriptName: `preview :${entry.port}`,
    command: entry.command,
    projectPath: entry.cwd,
    status: "running",
    pid: entry.pid,
    pidLstart: entry.pid ? pidStartTime(entry.pid) : undefined,
    startedAt: new Date().toISOString(),
    output: [`[anteprima task ${entry.taskId.slice(0, 8)} · http://localhost:${entry.port}]`],
    outputBytes: 0,
    proc: null,
    source: "script",
  });
  saveState();
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/**
 * I pid che il pannello Processi RIVENDICA, coi loro discendenti.
 *
 * A cosa serve: la spazzata delle anteprime cammina le 51 porte del pool e
 * chiude chi ci ascolta se il suo cwd è un worktree conosciuto. Un dev server
 * che un agente ha acceso nel proprio worktree con `run_script` risponde parola
 * per parola a quella descrizione, e senza questo elenco la spazzata non poteva
 * distinguerlo da un residuo: il pannello lo mostra con un bottone Stop, cioè
 * qualcuno lo sta guardando.
 *
 * I DISCENDENTI e non solo il pid registrato: chi ascolta sulla porta è quasi
 * sempre un figlio del lanciatore (`bun run dev` → server), quindi confrontare
 * il solo pid registrato con il listener non avrebbe protetto quasi niente.
 *
 * Le anteprime NON entrano: sono proprio ciò che la spazzata esiste per
 * raccogliere, e proteggerle vorrebbe dire non spazzare mai.
 */
export async function trackedScriptPidTrees(): Promise<Set<number>> {
  loadProcessRegistry();
  const out = new Set<number>();
  for (const [processId, sp] of runningScripts) {
    if (processId.startsWith("preview:")) continue;
    if (sp.status !== "running" || !sp.pid || sp.pid <= 0) continue;
    out.add(sp.pid);
    try { for (const p of await getDescendantPids(sp.pid)) out.add(p); }
    catch { /* la tabella dei processi è best-effort: resta il pid registrato */ }
  }
  return out;
}

export function unregisterPreviewProcess(taskId: string): void {
  loadProcessRegistry();
  // OGNI accensione del task, non solo l'ultima: la chiave porta la porta, e una
  // riga rimasta indietro sarebbe un processo vivo che nessuno ritira.
  const prefix = previewProcessPrefix(taskId);
  let removed = false;
  for (const key of Array.from(runningScripts.keys())) {
    // `preview:<8>` senza porta e' la forma vecchia, ancora possibile in uno
    // stato scritto prima del cambio di chiave: si toglie lo stesso.
    if (key === prefix.slice(0, -1) || key.startsWith(prefix)) {
      runningScripts.delete(key);
      removed = true;
    }
  }
  if (removed) {
    saveState();
    if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  }
}

// ── Shell in background lasciate dall'agente (3.5) ────────────────────────────
// `Bash(run_in_background: true)` non è un tool che finisce: è un processo che
// resta. Finora l'unica traccia era la card nel transcript — un ricordo, non uno
// stato: scorreva via, non si contava, e non c'era un posto dove ammazzarla.
// Qui entra nello STESSO registro dei processi, così eredita il pannello che
// esiste già: conteggio nell'intestazione, log, bottone Stop.
//
// L'output arriva dai `BashOutput` che l'agente stesso fa (non lo catturiamo
// noi: il figlio è del CLI). Il pid si cerca nell'albero del CLI della
// sessione; finché non si trova, la voce c'è lo stesso — sapere che una shell
// è viva vale anche senza poterla fermare, e il contrario (un bottone che non
// fa niente) sarebbe peggio del bottone assente.

/** Etichetta corta per la riga del pannello: il comando, senza il romanzo. */
function shellLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "shell";
}

export function registerBackgroundShell(entry: {
  sessionKey: string;
  topicId: string | null;
  shellId: string;
  command: string;
  cwd: string;
  ownerPid: number | null;
  /** The file the CLI writes the shell's output to (BGSHELL-05). */
  outputPath?: string;
}): void {
  loadProcessRegistry();
  const processId = shellProcessKey(entry.sessionKey, entry.shellId);
  // Ri-registrare la stessa shell non deve azzerarne l'output: l'agente può
  // rilanciare lo stesso id dopo un reattach.
  const existing = runningScripts.get(processId);
  if (existing) {
    if (existing.shell) existing.shell.ownerPid = entry.ownerPid ?? existing.shell.ownerPid;
    return;
  }
  runningScripts.set(processId, {
    processId,
    scriptName: shellLabel(entry.command),
    command: entry.command,
    projectPath: entry.cwd,
    status: "running",
    pid: null,
    startedAt: new Date().toISOString(),
    output: [backgroundShellBanner(entry.shellId)],
    outputBytes: 0,
    proc: null,
    source: "shell",
    shell: {
      shellId: entry.shellId,
      sessionKey: entry.sessionKey,
      topicId: entry.topicId,
      ownerPid: entry.ownerPid,
      resolveAttempts: 0,
    },
  });
  // Its log grows from that file, whether or not the agent ever reads it.
  if (entry.outputPath) followLog(runningScripts.get(processId)!, entry.outputPath, 0);
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  void resolveShellNow(runningScripts.get(processId)!);
}

/**
 * The CLI announces a shell it has started: its process is there now, so it is
 * looked up at once on a fresh table, not at the detector's next pass (up to
 * 32 s), and a dev server is a server by the watch's first pass. Not found, the
 * detector keeps looking.
 */
async function resolveShellNow(sp: ScriptProcess): Promise<void> {
  const meta = sp.shell!;
  const owner = getSessionCliPid(meta.sessionKey) ?? meta.ownerPid;
  if (!owner || !isPidAlive(owner)) return;
  const claimed = new Set<number>();
  for (const row of runningScripts.values()) if (row.pid) claimed.add(row.pid);
  const pid = await resolveShellPid(owner, sp.command, claimed, true).catch(() => null);
  if (!pid || sp.pid || sp.status !== "running") return;
  sp.pid = pid;
  commandServiceWatch.kick(); // it may be a server: its port comes a moment later
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/** The CLI's task list changed: a shell of this session whose process exited closes now, orphans swept, not at the detector's next pass. */
export async function settleEndedShells(sessionKey: string): Promise<void> {
  for (const sp of [...runningScripts.values()]) {
    if (sp.shell?.sessionKey !== sessionKey || sp.status !== "running" || !sp.pid || isPidAlive(sp.pid)) continue;
    await sweepOrphanedShellTree(sp.shell);
    finishBackgroundShell(sp, esitoShellMorta({ shellDead: true, ownerDead: false }));
  }
}

/** Un `BashOutput` dell'agente: output nuovo e, se c'è, stato aggiornato. */
export function noteBackgroundShellOutput(
  sessionKey: string,
  shellId: string,
  patch: { output?: string; status?: "running" | "completed" | "failed" | "killed"; exitCode?: number },
): void {
  loadProcessRegistry();
  const sp = runningScripts.get(shellProcessKey(sessionKey, shellId));
  if (!sp || sp.source !== "shell") return;
  // With a file, the file is the output: a `BashOutput` read would repeat it.
  if (patch.output && !sp.tail) appendOutput(sp, patch.output, true);
  if (patch.status && patch.status !== "running") {
    finishBackgroundShell(sp, patch.status, patch.exitCode);
    return;
  }
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/** L'agente ha chiamato `KillShell`, o il processo è sparito dalla macchina. */
export function closeBackgroundShell(
  sessionKey: string,
  shellId: string,
  status: "completed" | "failed" | "killed",
  exitCode?: number,
): void {
  loadProcessRegistry();
  const sp = runningScripts.get(shellProcessKey(sessionKey, shellId));
  if (!sp || sp.source !== "shell") return;
  finishBackgroundShell(sp, status, exitCode);
}

/** Vista sola-lettura sulle shell note, vive e appena concluse. */
export function listBackgroundShells(): Array<{
  shellId: string;
  sessionKey: string;
  topicId: string | null;
  command: string;
  status: ScriptProcess["status"];
  pid: number | null;
  exitCode?: number;
  output: string[];
}> {
  loadProcessRegistry();
  const out: ReturnType<typeof listBackgroundShells> = [];
  for (const sp of [...runningScripts.values(), ...recentScripts]) {
    if (sp.source !== "shell" || !sp.shell) continue;
    out.push({
      shellId: sp.shell.shellId,
      sessionKey: sp.shell.sessionKey,
      topicId: sp.shell.topicId,
      command: sp.command,
      status: sp.status,
      pid: sp.pid,
      ...(sp.exitCode != null ? { exitCode: sp.exitCode } : {}),
      output: [...sp.output],
    });
  }
  return out;
}

/** Sposta la shell fra i «recenti» con l'esito giusto. Non persiste nulla: le
 *  shell non sopravvivono al processo che le ha generate. */
export function finishBackgroundShell(
  sp: ScriptProcess,
  status: "completed" | "failed" | "killed",
  exitCode?: number,
): void {
  if (sp.status !== "running") return;
  pumpTail(sp);
  sp.tail = undefined;
  sp.status = status === "completed" ? "done" : "error";
  sp.completedAt = new Date().toISOString();
  if (exitCode != null) sp.exitCode = exitCode;
  else if (status === "killed") sp.exitCode = sp.exitCode ?? -1;
  appendOutput(sp, `\n[shell ${status === "killed" ? "terminata" : status === "failed" ? "fallita" : "conclusa"}]`, true);
  if (status === "killed" && sp.shell) sp.shell.stopped = true;
  runningScripts.delete(sp.processId);
  addToRecent(sp);
  invalidateScriptsCache();
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  // A server that ended: its chat says so now, and its addresses go once that is said (BGVIS-09).
  if (sp.shell && commandServiceWatch.listenOf(sp.processId)) {
    if (_broadcastCtx) pushBackgroundChanged(_broadcastCtx, sp.shell);
    setTimeout(() => commandServiceWatch.forget(sp.processId), SERVICE_END_SHOWN_MS * 2).unref?.();
  }
}

/**
 * Trova il processo vero di ogni shell ancora senza pid, e chiude quelle il cui
 * processo non c'è più. Gira nel ciclo del detector, che ha già la tabella dei
 * processi in cache.
 *
 * Il vincolo che rende sicuro il match: il candidato deve essere DISCENDENTE del
 * CLI di quella sessione e la sua riga di comando deve contenere il comando
 * della shell. Solo l'una o solo l'altra condizione non basterebbero — due
 * topic che lanciano `bun run dev` sono indistinguibili senza l'albero, e
 * l'albero da solo contiene anche il CLI e i suoi MCP.
 */
/**
 * COM'È FINITA una shell in background che non c'è più.
 *
 * «Conclusa» e «interrotta» non sono la stessa cosa, e il pannello le scriveva
 * uguali. Il 20/08, su topic:205d1fbb, un'attesa in background armata sul batch
 * dei video è morta con il CLI durante un riavvio del server — nel suo file di
 * output c'è `[killed]` — e il pannello la dava per «conclusa». Chi guardava non
 * aveva modo di sapere che quella sveglia non sarebbe mai arrivata.
 *
 * La lettura è semplice: se è morto il PROCESSO della shell, è finita (bene o
 * male lo dice il suo codice d'uscita). Se è morto il CLI che la teneva mentre
 * lei girava ancora, è stata INTERROTTA.
 */
export function esitoShellMorta(
  stato: { shellDead: boolean; ownerDead: boolean },
): "completed" | "killed" {
  // Il processo della shell è finito da sé: conta questo, anche se nel
  // frattempo è caduto pure il padre.
  if (stato.shellDead) return "completed";
  return stato.ownerDead ? "killed" : "completed";
}

export async function reconcileBackgroundShells(): Promise<boolean> {
  const shells = [...runningScripts.values()].filter(sp => sp.source === "shell" && sp.status === "running");
  if (!shells.length) return false;

  let changed = false;
  const claimed = new Set<number>();
  for (const sp of runningScripts.values()) if (sp.pid) claimed.add(sp.pid);

  // Shells and owners in one liveness probe; a pid it did not cover (an owner that changed meanwhile) is asked alone.
  const probed = shells.flatMap((sp) => [sp.pid, getSessionCliPid(sp.shell!.sessionKey) ?? sp.shell!.ownerPid]).filter((pid): pid is number => !!pid);
  const live = await livePids(probed);
  const isAlive = (pid: number) => (probed.includes(pid) ? live.has(pid) : isPidAlive(pid));

  for (const sp of shells) {
    const meta = sp.shell!;
    // Pid noto: la shell è viva finché il suo processo E il CLI padre lo sono.
    if (sp.pid) {
      const owner = getSessionCliPid(meta.sessionKey) ?? meta.ownerPid;
      const shellDead = !isAlive(sp.pid);
      const ownerDead = !owner || !isAlive(owner);
      if (shellDead || ownerDead) {
        // Il processo che ci ancorava è morto. La riga sparisce dal pannello —
        // ma i figli che la shell aveva spawnato (server, headless browser) NON
        // muoiono con lei: reparentati a init, fuori da ogni albero, con porte e
        // RAM ancora occupate e nessun bottone Stop a cui siano agganciati.
        // Prima di chiudere la riga li spazziamo, usando l'ultimo sottoalbero
        // catturato mentre la shell era viva.
        await sweepOrphanedShellTree(meta);
        // CHIUSA NON VUOL DIRE FINITA, e la differenza è tutta per chi guarda.
        //
        // Qui si scriveva sempre `completed`, cioè «conclusa»: la stessa parola
        // per un comando arrivato in fondo e per uno ucciso a metà dal riavvio
        // del server. Il 20/08, su topic:205d1fbb, l'agente aveva armato
        // un'attesa in background sul batch dei video; un riavvio ha portato via
        // il CLI, l'attesa è morta con lui (`[killed]` nel suo file di output) e
        // il pannello la dava per «conclusa». L'utente ha chiesto «non vedo se
        // ha fatto Monitor», e la risposta onesta era: l'attesa c'era, è stata
        // uccisa, e nessuno gliel'ha detto.
        //
        // Se a morire è il PADRE, la shell non è finita: è stata interrotta.
        // La REGOLA sta in `esitoShellMorta`, provata a parte.
        finishBackgroundShell(sp, esitoShellMorta({ shellDead, ownerDead }));
        changed = true;
        continue;
      }
      // Viva: rinfresca lo snapshot del sottoalbero. È l'unico modo per avere i
      // pid dei nipoti ancora a portata quando la shell morirà — a quel punto
      // l'albero è già spezzato e non li ritroveremmo più.
      await captureShellTree(sp.pid, meta);
      continue;
    }
    // L'ancora si rilegge ogni giro invece di fidarsi di quella salvata: lo
    // spawn del CLI è asincrono (il pid può arrivare dopo la registrazione) e
    // alla chiusura della sessione sparisce dal registro. Il pid salvato, da
    // solo, sarebbe un numero che il sistema può aver già riciclato.
    const owner = getSessionCliPid(meta.sessionKey);
    if (owner) meta.ownerPid = owner;
    // Senza CLI padre vivo non c'è albero in cui cercare, né nessuno che ci
    // dica come è finita: la shell è morta con lui. Chiuderla è la lettura
    // onesta — una riga «running» eterna è una bugia che il pannello non
    // potrebbe più correggere. (Il pid non è mai stato risolto, quindi non
    // c'è sottoalbero da spazzare: best effort, no-op.)
    if (!owner || !isAlive(owner)) {
      await sweepOrphanedShellTree(meta);
      // Stessa lettura del ramo sopra: è morto il CLI che la teneva, quindi la
      // shell è stata interrotta — non è arrivata in fondo.
      finishBackgroundShell(sp, esitoShellMorta({ shellDead: false, ownerDead: true }));
      changed = true;
      continue;
    }
    if (meta.resolveAttempts >= SHELL_RESOLVE_MAX_ATTEMPTS) continue;
    meta.resolveAttempts++;
    const pid = await resolveShellPid(owner, sp.command, claimed);
    if (pid) { sp.pid = pid; claimed.add(pid); changed = true; commandServiceWatch.kick(); }
  }
  return changed;
}

// Dopo N cicli (≈1 minuto) smettiamo di frugare: se il processo non si è fatto
// trovare, o è finito subito o non è ispezionabile. La voce resta viva finché
// il CLI padre è vivo — quello che sappiamo davvero.
const SHELL_RESOLVE_MAX_ATTEMPTS = 15;

/** Il comando come lo cerchiamo in `ps`: una riga, senza spazi ripetuti. */
function normalizeCommandLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function resolveShellPid(
  ownerPid: number,
  command: string,
  claimed: Set<number>,
  /** Skip the cached process table, up to 2 s old: a shell started a moment ago is not in it. */
  fresh = false,
): Promise<number | null> {
  const needle = normalizeCommandLine(command);
  if (needle.length < 3) return null;
  const tree = await getDescendantPids(ownerPid, fresh ? { fresh: true } : undefined);
  tree.delete(ownerPid); // il CLI stesso non è mai la shell
  const candidates = [...tree].filter(p => !claimed.has(p));
  if (!candidates.length) return null;
  const argv = await getCommandsForPids(candidates);
  for (const [pid, cmd] of argv) {
    if (normalizeCommandLine(cmd).includes(needle)) return pid;
  }
  return null;
}

/** argv di più pid in una sola `ps`. */
async function getCommandsForPids(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    recordServerSpawn("other", "shellReconcile");
    const proc = spawnBounded(["ps", "-o", "pid=,command=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) out.set(+m[1], m[2]);
    }
  } catch { /* ps transitoria: si riprova al ciclo dopo */ }
  return out;
}

/**
 * Rinfresca lo snapshot del sottoalbero di una shell viva: pid → lstart di ogni
 * discendente (la shell stessa esclusa — quella la chiude il CLI). Si spawna una
 * `ps` solo per i pid comparsi dall'ultimo giro: gli start-time già noti si
 * riusano, e i pid spariti si scartano. Girando nel ciclo del detector (con
 * backoff), il costo è una `ps` occasionale per shell viva.
 */
export async function captureShellTree(
  shellPid: number,
  meta: NonNullable<ScriptProcess["shell"]>,
): Promise<void> {
  const tree = await getDescendantPids(shellPid);
  tree.delete(shellPid);
  if (!tree.size) { meta.tree = undefined; return; }
  const prev = meta.tree ?? new Map<number, string>();
  const missing = [...tree].filter(p => !prev.has(p));
  const fresh = missing.length ? await getPidStartTimes(missing) : new Map<number, string>();
  const next = new Map<number, string>();
  for (const p of tree) {
    const start = prev.get(p) ?? fresh.get(p);
    if (start) next.set(p, start);
  }
  meta.tree = next.size ? next : undefined;
}

/**
 * Spazza l'ultimo sottoalbero noto di una shell il cui ancora (shell o CLI) è
 * morto: i figli orfani che il pannello non può più raggiungere. SIGTERM subito,
 * SIGKILL dopo il grace — entrambi SOLO sulla stessa incarnazione: lo start-time
 * corrente deve combaciare con quello dello snapshot, altrimenti quel pid è
 * stato riciclato dal sistema per un processo estraneo e non va toccato.
 * Consuma lo snapshot (uno-shot): niente doppioni se venisse richiamata.
 */
export async function sweepOrphanedShellTree(
  meta: NonNullable<ScriptProcess["shell"]>,
): Promise<void> {
  const snapshot = meta.tree;
  meta.tree = undefined;
  if (!snapshot || !snapshot.size) return;
  const pids = [...snapshot.keys()];
  const now = await getPidStartTimes(pids);
  const live = pids.filter(p => now.get(p) === snapshot.get(p));
  if (!live.length) return;
  for (const p of live) { try { process.kill(p, "SIGTERM"); } catch { /* già morto */ } }
  setTimeout(async () => {
    const still = await getPidStartTimes(live);
    for (const p of live) {
      if (still.get(p) === snapshot.get(p)) {
        try { process.kill(p, "SIGKILL"); } catch { /* uscito nel grace */ }
      }
    }
  }, 5000);
}
