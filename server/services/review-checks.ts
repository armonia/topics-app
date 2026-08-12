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
/** Righe di output tenute per ogni check. Bastano a vedere l'errore, non riempiono il DB. */
export const TAIL_LINES = 40;
/** Tetto per comando. Un check che ci mette più di così non è un gate, è un blocco. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
  const onAbort = () => { try { proc?.kill(); } catch { /* già morto */ } };
  try {
    proc = Bun.spawn(["/bin/sh", "-lc", check.cmd], {
      cwd: opts.cwd,
      stdout: "pipe",
      // stderr NELLO stesso flusso di stdout: il messaggio di un compilatore sta
      // di là, l'ordine fra i due conta, e due code separate lo perdono.
      stderr: "pipe",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    timer = setTimeout(() => { timedOut = true; try { proc?.kill(); } catch { /* già morto */ } }, opts.timeoutMs);
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
export function formatChecksComment(runs: CheckRun[], opts?: { commit?: string | null }): string {
  if (!runs.length) return "Checks pre-review: nessun comando dichiarato.";
  const failed = runs.find((r) => !r.ok);
  const where = opts?.commit ? ` su \`${opts.commit.slice(0, 8)}\`` : "";
  const line = (r: CheckRun) => `${r.ok ? "✓" : "✗"} \`${r.name}\` (${fmtMs(r.ms)})`;
  if (!failed) {
    return `**Checks pre-review verdi**${where}: ${runs.map(line).join(", ")}.`;
  }
  const why = failed.spawnError
    ? `non è partito: ${failed.spawnError}`
    : failed.timedOut
      ? `oltre il tempo massimo`
      : `exit ${failed.code}`;
  return [
    `**Checks pre-review ROSSI**${where}: \`${failed.name}\` ${why}.`,
    runs.map(line).join("\n"),
    `Comando: \`${failed.cmd}\``,
    failed.tail ? "```\n" + failed.tail + "\n```" : "(nessun output)",
    "Sistemalo, committa sul tuo branch e rimetti il task in review: finché è rosso la consegna non è guardabile.",
  ].join("\n\n");
}
