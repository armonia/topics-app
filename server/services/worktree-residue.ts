/**
 * IL RESIDUO: le modifiche non committate di un worktree, messe al sicuro sul
 * suo branch prima che la cartella venga liberata.
 *
 * ── Il guasto che lo fa nascere ─────────────────────────────────────────────
 * `worktree-gc.ts` ha una regola giusta e assoluta: non si distrugge una
 * cartella che contiene lavoro non committato, perché quella cartella ne è
 * l'unica copia. Misurato il 19/08/2026 su questa macchina: **191 worktree,
 * 0 raccolti**, e il motivo era uno solo per 137 di loro — «modifiche non
 * committate (junk escluso)». Ogni cartella pesa ~46 MB già sgonfiata (niente
 * `node_modules`, ci pensa `worktree-slim`), quindi la regola da sola teneva
 * fermi ~6 GB di sorgenti duplicati, per sempre, su task CHIUSI.
 *
 * ── Perché la regola non va indebolita ─────────────────────────────────────
 * «Unica copia» è una CONDIZIONE, non un destino. Lo dice già lo stesso file,
 * venti righe più sotto, per i commit non landati: *«se un branch li raggiunge
 * ancora, il checkout è una copia in più e può andarsene senza che nessuno
 * perda niente»*. Qui si rende vera la stessa frase per la sporcizia: la si
 * committa sul branch del task, e da quel momento la cartella non è più
 * l'unico appiglio. Nessuna riga di codice sparisce; cambia solo DOVE vive.
 *
 * ── Cosa NON fa, e sono i casi in cui tacere è la risposta ──────────────────
 *  · un albero in mezzo a un `merge` o a un `rebase`: committare lì
 *    sigillerebbe uno stato che una persona stava ancora decidendo;
 *  · un albero con percorsi in conflitto (`UU`, `AA`, `DD`): git stesso
 *    rifiuterebbe, e sigillare i marcatori `<<<<<<<` sarebbe peggio;
 *  · un albero senza niente da salvare: non si fabbrica un commit vuoto.
 * In tutti e tre torna `ok: false` con la ragione scritta, e il chiamante
 * ripiega sulla vecchia risposta — tenere la cartella.
 *
 * Il commit NON è una consegna: non passa dai cancelli, non lo ha rivisto
 * nessuno, e il messaggio lo dice a chiare lettere a chi lo troverà.
 */
import type { GitRunResult } from "./task-automerge";
import { gitEnvFor } from "../lib/git-identity";

export interface ResidueResult {
  ok: boolean;
  /** Perché è andata così. Un esito senza ragione non è diagnosticabile. */
  reason: string;
  /** Lo sha del commit creato, quando c'è stato. */
  commit?: string;
  /** Quanti percorsi sono finiti dentro. */
  files?: number;
}

/**
 * Il messaggio del commit di residuo.
 *
 * È lungo apposta: chi lo trova fra sei mesi in `git log` sta guardando un
 * commit che nessuno ha chiesto, su un ramo che credeva chiuso. Deve capire
 * in tre righe da dove viene e quanto valga.
 */
export const RESIDUE_SUBJECT = "Residuo non committato, messo al sicuro dalla potatura";

export const RESIDUE_BODY =
  "La cartella di questo worktree stava per essere liberata per fare spazio: questi file\n" +
  "erano nell'albero e su nessun commit, quindi la cartella ne era l'unica copia.\n" +
  "\n" +
  "NON è una consegna: non è passato da nessun cancello e non l'ha rivisto nessuno.\n" +
  "Esiste solo perché non andasse perso quando il checkout se n'è andato.\n";

/**
 * I ref che git lascia mentre un'operazione è a metà, uno per operazione.
 *
 * `MERGE_HEAD` da solo non basta e non è teoria: un cherry-pick in conflitto
 * lascia `CHERRY_PICK_HEAD` e nessun `MERGE_HEAD`, quindi il controllo su un
 * ref solo lasciava passare proprio i casi più delicati.
 */
const IN_CORSO = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"] as const;

/**
 * Righe di `git status --porcelain` che dicono «conflitto».
 *
 * Serve ANCHE dopo il giro su `IN_CORSO`, e il caso che lo dimostra è uno
 * `stash pop` finito male: lascia `UU` nell'indice e NESSUN ref di operazione
 * in corso (misurato il 19/08/2026). Senza questa, quel `git add -A` staged i
 * marcatori `<<<<<<<` e li committava come se fossero lavoro.
 */
function hasConflict(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .some((l) => {
      const x = l[0], y = l[1];
      return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    });
}

async function defaultRunGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    // Senza identità git esce 128 PRIMA di toccare l'albero, e questa funzione
    // crea un commit: stessa ragione (e stesso ripiego) di `task-automerge`.
    const env = await gitEnvFor(cwd);
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Salva sul branch del worktree tutto ciò che è nell'albero e su nessun commit.
 *
 * Best-effort e non lancia mai: un fallimento qui è un worktree che resta in
 * piedi, non una passata di GC interrotta.
 */
export async function commitWorktreeResidue(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<GitRunResult> = defaultRunGit,
): Promise<ResidueResult> {
  // 1. Un'operazione a metà è di una persona, non nostra. Ognuna lascia il suo
  //    ref, e si guardano TUTTI: `MERGE_HEAD` da solo non copre un cherry-pick.
  for (const ref of IN_CORSO) {
    const r = await runGit(path, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.code === 0 && r.stdout.trim()) {
      return { ok: false, reason: `${ref}: c'è un'operazione git a metà, lo stato è di chi la stava risolvendo` };
    }
  }

  // 2. HEAD staccata: un commit che nessun ramo raggiunge è un commit che la
  //    prima potatura degli oggetti si porta via. Salvare lì è peggio che non
  //    salvare, perché sembra fatto.
  //
  //    `symbolic-ref HEAD` esce non-zero esattamente quando HEAD non punta a un
  //    ramo — e NON si usa `rev-parse --git-path`, che stampa il percorso ed
  //    esce zero anche quando quella cartella non esiste (misurato il 19/08:
  //    era il modo in cui questo controllo non controllava niente).
  const head = await runGit(path, ["symbolic-ref", "--quiet", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) {
    return { ok: false, reason: "HEAD staccata: il commit non sarebbe raggiungibile da nessun ramo" };
  }

  // 2. Lo stato dell'albero, letto una volta.
  const st = await runGit(path, ["status", "--porcelain"]);
  if (st.code !== 0) return { ok: false, reason: "git status non ha risposto" };
  if (!st.stdout.trim()) return { ok: false, reason: "niente da salvare: l'albero è pulito" };
  if (hasConflict(st.stdout)) {
    return { ok: false, reason: "percorsi in conflitto: sigillare i marcatori sarebbe peggio che tenere la cartella" };
  }
  const files = st.stdout.split("\n").filter(Boolean).length;

  // 3. `-A` rispetta `.gitignore`: ciò che è ignorato resta fuori, ed è il
  //    motivo per cui questo non risucchia `node_modules` o un `.env`.
  const add = await runGit(path, ["add", "-A"]);
  if (add.code !== 0) return { ok: false, reason: `git add fallito: ${add.stderr.trim().slice(0, 200)}` };

  // 4. `--no-verify`: gli hook di questo repo eseguono i cancelli, e un cancello
  //    rosso è ATTESO qui — stiamo salvando lavoro incompiuto, non consegnandolo.
  const msg = `${RESIDUE_SUBJECT}\n\n${RESIDUE_BODY}`;
  const commit = await runGit(path, ["commit", "--no-verify", "-m", msg]);
  if (commit.code !== 0) {
    return { ok: false, reason: `git commit fallito: ${(commit.stderr || commit.stdout).trim().slice(0, 200)}` };
  }

  const nuovo = await runGit(path, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, reason: `${files} percorsi salvati sul branch`, commit: nuovo.stdout.trim() || undefined, files };
}
