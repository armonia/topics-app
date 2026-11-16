import type { AppContext } from "../types";
import { registerFleetScriptSource } from "../lib/fleet-usage";
import { listSessionCliPids } from "../providers/session-pids";
import { type FileTail } from "../lib/file-tail";
import { type UnresolvedReason } from "../lib/command-redirect";

export interface ScriptProcess {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output: string[];       // circular buffer lines
  outputBytes: number;
  /**
   * Quante righe il ring buffer ha già BUTTATO. È l'origine del cursore
   * assoluto: senza, l'offset del client è un indice dentro un array che si
   * accorcia da sotto, e dopo un'eviction quell'indice indica un'altra riga.
   * Misurato: una riga sparisce in silenzio; nell'altro verso si duplicano
   * blocchi interi. Su un build verboso i 500KB si raggiungono in minuti.
   */
  droppedLines?: number;
  /**
   * L'ultima riga ANCORA senza `\n`. `text.split("\n")` su `"hello\n"` dà
   * `["hello", ""]`, e quell'elemento vuoto finiva nel buffer: due chunk
   * consecutivi producevano `hello\n\nworld`, cioè il log a interlinea doppia
   * che si vede aprendo qualsiasi processo. Simmetricamente un chunk tagliato a
   * metà riga diventava due righe.
   */
  pendingLine?: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  /** Byte size of the on-disk .log — tracked in memory so the per-chunk write
   *  path never stats the file. The log is per-processId (unique per spawn),
   *  so it always starts at 0. Not persisted. */
  logBytes?: number;
  /** Per-process async write chain: keeps chunk appends + rotation ordered
   *  without blocking the event loop (the old appendFileSync/statSync ran on
   *  EVERY stdout/stderr chunk of every tracked script). Not persisted. */
  logQueue?: Promise<void>;
  /** 'script' = launched by Topics (run_script / UI), output captured. 'detected'
   *  = a listening server found under a Claude PTY that Topics did NOT spawn, so
   *  we have its pid/ports but not its stdout. 'shell' = una shell che l'agente
   *  ha lasciato in background con `Bash(run_in_background)`: il suo output
   *  arriva dai `BashOutput` dello stream, il pid dall'albero del CLI (3.5).
   *  Defaults to 'script'. */
  source?: "script" | "detected" | "shell" | "command";
  /**
   * `ps -o lstart=` del pid, catturato allo spawn. E' l'IDENTITA' del processo,
   * non un dettaglio: un pid da solo viene riciclato dal sistema, e riadottarlo
   * al boot per numero significa appendere il bottone Stop a un estraneo. Vedi
   * `readoptVerdict`. Persistito accanto al pid.
   */
  pidLstart?: string;
  /** Solo per `source: 'shell'`. */
  shell?: {
    /** L'id che il CLI usa nei suoi `BashOutput`/`KillShell`. */
    shellId: string;
    /** La sessione che l'ha avviata: chiude il cerchio con `session-pids`. */
    sessionKey: string;
    topicId: string | null;
    /** Pid del CLI padre — l'albero dentro cui cercare il processo vero. */
    ownerPid: number | null;
    /** Quante volte abbiamo provato a risolvere il pid senza riuscirci. Serve
     *  a smettere di frugare nella tabella dei processi per una shell che è
     *  morta prima ancora di essere vista. */
    resolveAttempts: number;
    /** Ultimo sottoalbero noto della shell (pid → lstart), catturato mentre era
     *  VIVA. È l'unico handle che sopravvive alla sua morte: quando la shell
     *  esce, i figli che aveva spawnato (server, headless browser) si
     *  riattaccano a init e l'albero si spezza — ma i loro pid restano quelli, e
     *  lo start-time distingue la stessa incarnazione da un pid riciclato.
     *  Serve a spazzarli quando la riga sparisce, invece di lasciarli orfani. */
    tree?: Map<number, string>;
    /** Ended by a Stop (the panel, the chat's server row, `KillShell`) or with its CLI: a server's end reads «stopped». */
    stopped?: boolean;
  };
  /** Only for `source: 'command'` (`run_command`). Persisted. */
  cmd?: CommandMeta;
  /** A session-keyed run_script that belongs to an assigned card. */
  cardRun?: { sessionKey: string; cardId: string; topicId: string | null };
  closing?: boolean;
  stopFailed?: boolean;
  stopped?: boolean;
  /**
   * A `run_script` an agent started from its session: the chat it belongs to.
   * A dev server run this way is that chat's server, shown as one and never
   * as work the chat waits for (BGVIS-08). Not persisted.
   */
  agentRun?: { sessionKey: string; topicId: string | null };
  /** Its wake was refused for good in this life of the server: owed to the next boot, not waited on now. Not persisted. */
  wakeFailed?: boolean;
  /** Set while the log is a FILE somebody else writes (a command, a shell of
   *  the CLI): the registry follows it and never writes it. Not persisted. */
  tail?: FileTail;
  /** The file a command sends its own stdout to (`CommandMeta.follow`), followed beside its log. Not persisted. */
  followTail?: FileTail;
  /** That file's last line, until its newline comes: the buffer takes its lines whole. Not persisted. */
  followPending?: string;
}

export interface CommandMeta {
  sessionKey: string;
  topicId: string | null;
  /** The topic is owed a wake when it ends; false once nothing is owed. */
  wake: boolean;
  /** Stopped from the panel or with `stop_process`: «stopped», no wake. */
  stopped?: boolean;
  /** The owned group is receiving TERM and may still be alive. */
  closing?: boolean;
  /** The group could not be verified dead; the row remains live. */
  stopFailed?: boolean;
  /**
   * `person`: run by a person from the chat (Run under a code block), never
   * by the agent. It wakes nobody, the agent's process tools do not see it,
   * and its end closes its row in `command_runs` (CMDRUN-05, CMDRUN-06).
   */
  origin?: "person";
  /**
   * The file the command names as its stdout (`> f`, `&> f`, `| tee f >…`),
   * read off the command line before it starts (`lib/command-redirect.ts`):
   * its log follows that file too, or it would stay empty while the work goes
   * to the file (Muse, 07/10). `from` is where this run starts in it: 0 when
   * the shell truncates it, its size before the start when it appends.
   */
  follow?: { path: string; from: number };
  /** A stdout file it names but nobody can resolve without running it (`$LOG`, a glob): the panel says so. */
  unfollowed?: { target: string; reason: UnresolvedReason };
}

/** A run a person started from the chat: kept out of everything the agent reads. */
export const isPersonRun = (sp: ScriptProcess) => sp.cmd?.origin === "person";

// Serializable subset for persistence
export interface PersistedScript {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  /** Vedi `ScriptProcess.pidLstart`. Assente nei file scritti prima del fix. */
  pidLstart?: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  source?: "command";
  cmd?: CommandMeta;
  cardRun?: { sessionKey: string; cardId: string; topicId: string | null };
}

export const MAX_OUTPUT_BYTES = 500 * 1024; // ~500KB per process
/** A log on disk past this is cut to its last MAX_OUTPUT_BYTES: a script's by `appendOutput`, a command's by `pumpTail`. */
export const MAX_LOG_FILE_BYTES = 1024 * 1024;
export const MAX_RECENT = 10;

export const runningScripts = new Map<string, ScriptProcess>();
export const recentScripts: ScriptProcess[] = [];
/** The one timer that follows every file-backed log (`followLog`). */
export let tailTimer: ReturnType<typeof setInterval> | null = null;
export function setTailTimer(timer: ReturnType<typeof setInterval> | null): void { tailTimer = timer; }
export let scriptsResponseCache: { data: any; timestamp: number; ports: boolean } | null = null;
export function setScriptsResponseCache(cache: typeof scriptsResponseCache): void { scriptsResponseCache = cache; }

// Third axis of the memory calculator: processes an agent launched.
// Excluded from the server total (fleet-usage.ts) and shown separately.
//
// TWO SOURCES, not one. `runningScripts` alone only covers what passes
// through THIS registry: scripts launched from the UI (`run_script`) and the
// shells an agent leaves running in the background with
// `Bash(run_in_background)` — once their pid has been resolved
// (`registerBackgroundShell`). A SYNCHRONOUS `Bash` command (card 9b36ea1b:
// `bun run test:unit:shards` launched and never backgrounded) never passes
// through here: it is a child of the agent's CLI for its whole duration and
// no event ever registers it. So every live agent CLI is added as a
// `childrenOnly` root: its CHILDREN — whatever the Bash tool started,
// foreground or not — enter the axis; the CLI itself stays billed to its own
// root, as before.
registerFleetScriptSource(() => [
  ...Array.from(runningScripts.values())
    .filter(sp => sp.status === "running" && sp.pid !== null)
    .map(sp => ({ pid: sp.pid as number, lstart: sp.pidLstart })),
  ...listSessionCliPids().map(({ pid }) => ({ pid, childrenOnly: true })),
]);

export let _broadcastCtx: AppContext | null = null;
export function setBroadcastCtx(next: AppContext): void { _broadcastCtx = next; }
