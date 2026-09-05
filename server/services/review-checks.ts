/**
 * Checks pre-review: i comandi che devono essere verdi perché una consegna sia
 * guardabile.
 *
 * Il protocollo di consegna chiede evidenza verificabile, ma finora l'unica cosa
 * che la rendeva vera era la buona volontà dell'agente. I gate strutturali
 * esistenti coprono il commit (`review_needs_commit`) e il riassunto
 * (`review_needs_summary`); questo copre il fatto che il codice compili — e non
 * chiedendolo all'agente, ESEGUENDOLO nel suo worktree.
 *
 * Due scelte che sembrano dettagli e non lo sono:
 *
 * - **Nessun default inferito da package.json.** Sarebbe comodo e sbagliato:
 *   `npm test` qui è la suite E2E, venti minuti, e un gate che blocca ogni
 *   consegna per venti minuti verrebbe spento il primo giorno. I comandi li
 *   dichiara l'umano per board; board senza dichiarazione = gate spento.
 * - **Sequenziali, e si ferma al primo rosso.** Un typecheck rotto rende
 *   inutile il lint che segue, e far girare comunque tutto costa minuti per
 *   produrre rumore. Chi legge vuole il PRIMO motivo, non l'elenco.
 */

// Le FORME (comando dichiarato, esito) stanno in `shared/board.ts`: le legge
// anche il client per renderizzare il gate. Qui resta l'esecuzione.
export type { ReviewCheck, CheckRun } from "../../shared/board";
import type { ReviewCheck, CheckRun } from "../../shared/board";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree } from "../lib/process-tree";

/**
 * Quanti check al massimo: oltre, la "verifica" diventa una pipeline CI travestita.
 *
 * Sei, non cinque, dal 12/08. I cancelli di questo repo sono diventati sei
 * (`typecheck`, `lint`, `check:deadcode`, `check:emdash`, `check:migrations`,
 * `test:unit`) e con il tetto a cinque l'ultimo veniva TRONCATO in silenzio: la
 * board dichiarava sei comandi, ne salvava cinque, e la consegna arrivava in
 * review "verde" senza che la suite fosse mai girata. In quella notte tre
 * consegne su cinque erano rosse proprio sulla suite, e il rosso l'ha trovato un
 * umano al momento del land invece del cancello al momento della consegna.
 *
 * Il costo si regge perche' i check sono SEQUENZIALI e ci si ferma al primo
 * rosso: la suite, che e' l'ultima e la sola lenta, gira solo quando le cinque
 * veloci sono passate.
 */
export const MAX_CHECKS = 6;

/**
 * THE STATIC RAILS, CHAINED INTO ONE SLOT.
 *
 * The cap is six and the repo has grown ten gates. On 2026-09-03 the board's
 * six slots held typecheck, lint, check:deadcode, check:emdash,
 * check:migrations and test:unit, and NOT check:identifier-language,
 * check:comment-language, check:untraced-tests or check:spec-coverage. So a
 * card reached review green on six commands and main's CI found the red after
 * the land, when the worktree was gone and no agent was assigned any more.
 * That is KANBAN-15 read backwards: a green that measured nothing is not a
 * green.
 *
 * Raising the cap would be the wrong lever (the doc above says why: past six
 * the "verification" is a CI pipeline in disguise). The right one is the door
 * the settings PATCH itself names when it refuses a seventh check: merge two
 * commands into one. `runOne` executes the line in `sh -lc`, so a `&&` chain
 * stops at the first red and hands its exit code through UNTOUCHED: a 1 stays
 * a 1, and a 97 ("not measured") stays a 97, which is what keeps the
 * three-state verdict honest on a chained slot. Together the six links cost
 * about four seconds, measured.
 *
 * The board still declares its own commands (see the file header: no default
 * is inferred). This constant is the ONE spelling of the chain, so the
 * settings hint, the tests and whoever fills a board's slots say the same
 * string instead of six drifting copies.
 */
export const STATIC_RAILS_CHECK: ReviewCheck = {
  name: "static-rails",
  cmd: [
    "bun run check:emdash",
    "bun run check:migrations",
    "bun run check:identifier-language",
    "bun run check:comment-language",
    "bun run check:untraced-tests",
    "bun run check:spec-coverage",
  ].join(" && "),
};
/** Righe di output tenute per ogni check. Bastano a vedere l'errore, non riempiono il DB. */
export const TAIL_LINES = 40;
/**
 * Tetto per comando. Un check che ci mette più di così non è un gate, è un blocco.
 *
 * Venti minuti, non dieci, da quando `test:unit` è il sesto cancello. La suite
 * da sola ne impiega tre o quattro; il 12/08, con cinque agenti al lavoro sulla
 * stessa macchina, è stata fermata al tetto di dieci — e la consegna
 * (`b2a3e511`) risultava bocciata per una ragione che col suo codice non
 * c'entrava niente. Il tetto deve stare sopra il caso CARICO, altrimenti misura
 * il traffico invece del lavoro.
 *
 * Restare comunque un tetto conta: oltre venti minuti il comando non è lento,
 * è appeso, e va fermato per non tenere occupata una worktree per sempre.
 */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * IL CODICE CHE DICE «NON HO MISURATO», e non «hai sbagliato».
 *
 * Lo usano i cancelli che non riescono nemmeno a partire: `typecheck-server.ts`
 * quando `tsc` non c'e', `check-client-deps.ts` quando manca `eslint`. Succede
 * in ogni worktree di dispatch, perche' `git worktree add` copia i file
 * TRACCIATI e `client/node_modules` non lo e' — misurato il 18/08: 95 worktree
 * su 103 senza.
 *
 * Senza questo numero quei cancelli uscivano 1, indistinguibili da un rosso
 * vero, e la card scriveva `checks_state = 'fail'` su rami che spesso non
 * avevano nemmeno un commit. La distinzione la facevano gia' a parole; l'uscita
 * la buttava via.
 */
export const NOT_MEASURED_EXIT = 97;

/**
 * Legge la colonna `board_settings.review_checks`.
 *
 * Tollerante di proposito: accetta sia `[{name,cmd}]` sia un array di stringhe
 * (dove il nome è il comando stesso), perché la seconda forma è quella che uno
 * scrive a mano la prima volta. Qualunque cosa non si capisca vale "nessun
 * check" — un gate che si autodisattiva su config sporca è meglio di uno che
 * blocca ogni consegna con un errore di parsing.
 */
export function parseReviewChecks(raw: string | null | undefined): ReviewCheck[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: ReviewCheck[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_CHECKS) break;
    if (typeof item === "string") {
      const cmd = item.trim();
      if (cmd) out.push({ name: cmd, cmd });
      continue;
    }
    if (item && typeof item === "object") {
      const cmd = String((item as { cmd?: unknown }).cmd ?? "").trim();
      if (!cmd) continue;
      const name = String((item as { name?: unknown }).name ?? "").trim() || cmd;
      out.push({ name, cmd });
    }
  }
  return out;
}

/** Forma canonica da salvare: quella lunga, così il nome non si perde. */
export function serializeReviewChecks(checks: ReviewCheck[]): string | null {
  const clean = checks
    .map((c) => ({ name: (c.name || "").trim() || (c.cmd || "").trim(), cmd: (c.cmd || "").trim() }))
    .filter((c) => c.cmd)
    .slice(0, MAX_CHECKS);
  return clean.length ? JSON.stringify(clean) : null;
}

/** Le ultime `TAIL_LINES` righe non vuote in coda, che è dove sta l'errore. */
export function tailOf(text: string, lines = TAIL_LINES): string {
  const rows = text.replace(/\s+$/, "").split("\n");
  return rows.slice(Math.max(0, rows.length - lines)).join("\n");
}

interface RunOpts {
  cwd: string;
  timeoutMs?: number;
  /** Iniettato dai test per non dipendere da processi veri. */
  spawn?: typeof runOne;
  /** Chiamato dopo ogni comando: serve a mostrare l'avanzamento senza aspettare la fine. */
  onProgress?: (run: CheckRun, index: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Which install roots still need `bun install`, injected by the tests so they
   * never touch a real filesystem. Defaults to the real probe below.
   */
  missingInstallRoots?: (cwd: string) => string[];
}

/**
 * Workspace roots that must carry a `node_modules` before any gate can run.
 *
 * "" is the repo root; the others are relative to it. Both matter here:
 * `bun run typecheck` shells straight into `client/node_modules/.bin/tsc`, so a
 * root-only install still leaves the first gate unable to start.
 */
const INSTALL_ROOTS = ["", "client"] as const;

/**
 * The install roots that a worktree is missing right now.
 *
 * `git worktree add` materialises TRACKED files only, and `node_modules` is not
 * tracked: a fresh task worktree has none until somebody installs. A root is
 * "missing" when it declares a package.json and has no node_modules next to it.
 */
function missingInstallRootsOnDisk(cwd: string): string[] {
  const out: string[] = [];
  for (const rel of INSTALL_ROOTS) {
    const dir = rel ? join(cwd, rel) : cwd;
    if (!existsSync(join(dir, "package.json"))) continue;
    if (existsSync(join(dir, "node_modules"))) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Install dependencies before measuring anything.
 *
 * Without this the declared gates die on exit 127 ("command not found") long
 * before they can type-check a single line, and the board writes that up as
 * "Checks pre-review ROSSI" — a verdict indistinguishable from a real failure.
 * Measured on 2026-08-13: eight tasks carried that false red, and one of them
 * (`487ddf94`) was told to "fix it and re-commit" for a defect that never
 * existed in its code.
 *
 * A failed install is reported as a failed run rather than swallowed: an
 * environment that cannot be built is a real reason to stop, and naming it beats
 * six identical 127s.
 */
async function installMissingDeps(
  roots: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  exec: typeof runOne,
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const rel of roots) {
    if (opts.signal?.aborted) break;
    const where = rel ? `${rel}/` : "./";
    const run = await exec(
      { name: `bun install (${where})`, cmd: rel ? `cd ${rel} && bun install` : "bun install" },
      opts,
    );
    runs.push(run);
    if (!run.ok) break;
  }
  return runs;
}

/**
 * Esegue i check in ordine e si ferma al primo rosso.
 *
 * Ritorna solo quelli EFFETTIVAMENTE eseguiti: chi legge deve poter distinguere
 * "verde" da "non è mai partito", e un elenco di `skipped` finti direbbe l'una
 * per l'altra.
 */
export async function runReviewChecks(checks: ReviewCheck[], opts: RunOpts): Promise<CheckRun[]> {
  const exec = opts.spawn ?? runOne;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runs: CheckRun[] = [];
  // Dependencies FIRST: a gate that cannot start measures the worktree, not the
  // delivery. Only the roots that are actually missing are installed, so a
  // warm worktree pays nothing.
  const probe = opts.missingInstallRoots ?? missingInstallRootsOnDisk;
  const missing = checks.length ? probe(opts.cwd) : [];
  if (missing.length && !opts.signal?.aborted) {
    const prep = await installMissingDeps(missing, { cwd: opts.cwd, timeoutMs, signal: opts.signal }, exec);
    // A green install is plumbing, not a verdict: it stays out of the report so
    // the reviewer keeps reading the gates they declared. A red one is the whole
    // story, and stops the round.
    if (prep.some((r) => !r.ok)) return prep;
  }
  for (const [i, check] of checks.entries()) {
    if (opts.signal?.aborted) break;
    const run = await exec(check, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
    runs.push(run);
    opts.onProgress?.(run, i, checks.length);
    if (!run.ok) break;
  }
  return runs;
}

/**
 * Un comando, in una shell, dentro `cwd`.
 *
 * `sh -lc` e non un array di argomenti: la config è una riga scritta da un umano
 * (`bun run typecheck && bun test`), e spezzarla a mano sarebbe riscrivere una
 * shell peggiore. Non è una superficie nuova: i comandi li dichiara il padrone
 * della macchina nelle impostazioni della board, e gli agenti che girano qui
 * hanno già una shell.
 */
async function runOne(
  check: ReviewCheck,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<CheckRun> {
  const started = Date.now();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * TUTTO L'ALBERO, non il solo `/bin/sh`. Il comando dichiarato e' una riga di
   * shell (`bun run typecheck && bun test`), e chi lavora davvero e' un nipote:
   * `proc.kill()` chiudeva il wrapper e lasciava girare il compilatore, che
   * continuava a mangiare CPU dopo il timeout e a tenersi le sue porte.
   * Non lancia mai e non si aspetta: la riga di esito la scrive chi legge
   * `proc.exited`, che il SIGTERM sblocca da solo.
   */
  const killTree = () => {
    const pid = proc?.pid;
    if (pid) void killProcessTree(pid).catch(() => { /* gia' morto */ });
  };
  const onAbort = () => { killTree(); };
  try {
    proc = Bun.spawn(["/bin/sh", "-lc", check.cmd], {
      cwd: opts.cwd,
      stdout: "pipe",
      // stderr NELLO stesso flusso di stdout: il messaggio di un compilatore sta
      // di là, l'ordine fra i due conta, e due code separate lo perdono.
      stderr: "pipe",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    timer = setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    const code = await proc.exited;
    const combined = [out, err].filter((s) => s.trim()).join("\n");
    return {
      name: check.name,
      cmd: check.cmd,
      ok: !timedOut && code === 0,
      code: timedOut ? null : code,
      ms: Date.now() - started,
      timedOut,
      // Il comando ha DICHIARATO di non aver misurato (97). Campo suo e non
      // `timedOut`: dire «fermato oltre il tempo massimo» di un binario che non
      // c'e' sarebbe una bugia, e il testo del commento la ripeterebbe.
      notMeasured: code === NOT_MEASURED_EXIT,
      tail: tailOf(combined) || (timedOut ? "(nessun output prima del timeout)" : "(nessun output)"),
    };
  } catch (e) {
    // Non è partito proprio: cwd sparita, /bin/sh assente. Rosso, ma con il
    // motivo giusto — se dicesse "check fallito" l'agente andrebbe a cercare un
    // bug che non c'è.
    return {
      name: check.name,
      cmd: check.cmd,
      ok: false,
      code: null,
      ms: Date.now() - started,
      timedOut: false,
      tail: "",
      spawnError: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Il commento che finisce nel thread. Verde: una riga, è evidenza, non un
 * pistolotto. Rosso: il comando, l'exit code e la coda dell'output — cioè
 * quello che serve a rimetterci le mani senza aprire un terminale.
 */
/**
 * L'ESITO DI UNA BARRA, IN UNA PAROLA SOLA — e sono TRE, non due.
 *
 * `pass` misurato e verde · `fail` misurato e rosso · `unknown` NON misurato.
 * Il terzo non e' una sfumatura del secondo: «rosso» dice «il tuo codice e'
 * rotto, non approvare», «non misurato» dice «non lo sappiamo». Chi rivede
 * decide diversamente nei due casi, e chi ha consegnato pure.
 *
 * ── Perche' esiste ──────────────────────────────────────────────────────────
 * Il TESTO faceva gia' questa distinzione dal 12/08 («**Checks pre-review NON
 * MISURATI**»), e il suo test si chiudeva con «la parola conta piu' del codice
 * di stato». Si e' fermato li': `recordChecks` scriveva `ok ? "pass" : "fail"`,
 * quindi lo STATO — che e' quello che la card legge, perche' `checks_json` non
 * viaggia nel payload della lista (pesava 217 KB) — diceva rosso lo stesso.
 *
 * Misurato il 18/08 sul DB vivo: delle 15 card marcate `fail`, SEI erano solo
 * scadute. Il 40% delle bocciature accusava un codice sano.
 *
 * `expected` e' il numero di comandi DICHIARATI: se ne sono tornati meno,
 * qualcuno non e' arrivato in fondo e l'esito non e' misurato — non verde.
 * Senza questo parametro un elenco troppo corto e tutto verde direbbe `pass`.
 */
export function checksVerdict(runs: CheckRun[], expected?: number): "pass" | "fail" | "unknown" {
  if (!runs.length) return "unknown";
  const failed = runs.find((r) => !r.ok);
  if (!failed) return expected !== undefined && runs.length < expected ? "unknown" : "pass";
  // Un SOLO rosso vero basta a dire rosso, anche se altri sono scaduti: c'e' un
  // guasto misurato, e quello si guarda. Il verso opposto — un rosso nascosto
  // da un timeout — sarebbe il difetto.
  return runs.some((r) => !r.ok && !r.timedOut && !r.notMeasured) ? "fail" : "unknown";
}

/**
 * The line the CHAT shows inside the running `update_task` tool while the
 * checks grind. The card already says «2/5» (`checksProgress`); the chat did
 * not: the tool spun mute for the whole bar, and from the thread the topic
 * looked stuck: on 05/09/2026 the person asked three times why the topics were
 * still, while three card turns sat 20-60 minutes in that very wait. Names come from the declared
 * list, in execution order: passed, running, then queued. `done === null` is
 * the queue behind another card's run, before this card's own bar starts.
 */
export function formatChecksWait(args: {
  done: number | null;
  total: number;
  names: string[];
  elapsedMs: number;
}): string {
  const mins = Math.floor(Math.max(0, args.elapsedMs) / 60_000);
  const secs = Math.floor((Math.max(0, args.elapsedMs) % 60_000) / 1000);
  const elapsed = mins ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
  const footer = "È il cancello della board che misura, non l'agente: a verde la card passa in review da sola, a rosso torna qui con l'output.";
  if (args.done === null) {
    return `Check pre-review in coda dietro un'altra card (${elapsed}): la barra parte appena si libera un posto. ${footer}`;
  }
  const done = Math.max(0, Math.min(args.done, args.total));
  const parts = [`Check pre-review ${done}/${args.total} (${elapsed})`];
  const passed = args.names.slice(0, done);
  const current = args.names[done];
  const queued = args.names.slice(done + 1);
  if (passed.length) parts.push(`verdi: ${passed.join(", ")}`);
  if (current) parts.push(`in corso: ${current}`);
  if (queued.length) parts.push(`poi: ${queued.join(", ")}`);
  return `${parts.join(" · ")}. ${footer}`;
}

export function formatChecksComment(runs: CheckRun[], opts?: { commit?: string | null }): string {
  if (!runs.length) return "Checks pre-review: nessun comando dichiarato.";
  const failed = runs.find((r) => !r.ok);
  const where = opts?.commit ? ` su \`${opts.commit.slice(0, 8)}\`` : "";
  const line = (r: CheckRun) => `${r.ok ? "✓" : "✗"} \`${r.name}\` (${fmtMs(r.ms)})`;
  if (!failed) {
    return `**Checks pre-review verdi**${where}: ${runs.map(line).join(", ")}.`;
  }
  // Un comando SCADUTO non ha misurato niente, e chiamarlo «rosso» manda a
  // cercare un guasto che non c'è. Misurato il 12/08 su `b2a3e511`: cinque
  // cancelli verdi e `test:unit` fermato al tetto mentre cinque agenti
  // lavoravano — la suite da sola ne impiega tre o quattro. Il codice non
  // c'entrava: era piena la macchina.
  // NON MISURATO, e i due modi si dicono diversi: uno SCADUTO ha girato e non e'
  // arrivato in fondo, un cancello che non parte non ha guardato niente. Mandare
  // «rilancia quando c'e' meno traffico» a chi ha un worktree senza dipendenze
  // sarebbe una caccia a un guasto che non esiste.
  if (failed.notMeasured) {
    return [
      `**Checks pre-review NON MISURATI**${where}: \`${failed.name}\` non e' partito.`,
      runs.map(line).join("\n"),
      `Comando: \`${failed.cmd}\``,
      failed.tail ? "```\n" + failed.tail + "\n```" : "(nessun output)",
      "Non e' un fallimento del codice: e' un cancello che non ha potuto guardare. " +
        "Quasi sempre e' un worktree senza le dipendenze del client (`cd client && bun install`).",
    ].join("\n\n");
  }
  if (checksVerdict(runs) === "unknown") {
    return [
      `**Checks pre-review NON MISURATI**${where}: \`${failed.name}\` è stato fermato oltre il tempo massimo.`,
      runs.map(line).join("\n"),
      `Comando: \`${failed.cmd}\``,
      failed.tail ? "```\n" + failed.tail + "\n```" : "(nessun output)",
      "Non è un fallimento: è un comando che non è arrivato in fondo, quasi sempre perché la macchina era carica. " +
        "Rimetti il task in review quando c'è meno traffico, oppure fallo girare a mano e allega l'esito.",
    ].join("\n\n");
  }
  const why = failed.spawnError ? `non è partito: ${failed.spawnError}` : `exit ${failed.code}`;
  return [
    `**Checks pre-review ROSSI**${where}: \`${failed.name}\` ${why}.`,
    runs.map(line).join("\n"),
    `Comando: \`${failed.cmd}\``,
    failed.tail ? "```\n" + failed.tail + "\n```" : "(nessun output)",
    "Sistemalo, committa sul tuo branch e rimetti il task in review: finché è rosso la consegna non è guardabile.",
  ].join("\n\n");
}
