/**
 * Il messaggio che il GC scrive nel thread quando libera il worktree di un task
 * abbandonato — l'unica riga che l'umano (o l'agente che riprende) legge per
 * decidere SE HA PERSO LAVORO.
 *
 * Perché esiste come modulo a sé: fino al 04/08 quella riga era una formula
 * fissa, dentro `server.ts`, che diceva sempre la stessa cosa —
 *
 *   «Worktree liberato: il branch del worktree non esiste più.
 *    Il branch `topics/vibrant-creek` è INTATTO (nessun commit perso) —
 *    per riprendere il lavoro ripartilo da lì»
 *
 * — negando e rassicurando nella STESSA riga (task `5770b9de`, visto sul task
 * `8f635484`: `git branch --list 'topics/*'` non restituiva niente, il branch
 * nominato non esisteva). La rassicurazione veniva emessa senza guardare il
 * ref: sarebbe uscita identica con dieci commit dentro, e chi la legge ha ogni
 * motivo di crederle e non andare a controllare.
 *
 * La regola qui dentro è una sola: **si dice solo ciò che è stato verificato**.
 * Due funzioni, apposta: `composeAbandonNotice` è PURA e riceve l'esito della
 * verifica, mai una supposizione — per questo `branchState` ha anche
 * `"unverified"`: non aver potuto guardare è un terzo caso, non un sinonimo di
 * «va tutto bene». `abandonNoticeFromRepo` è la sola che tocca git
 * (`rev-parse --verify`, `rev-list --count`), così l'intero percorso «verifica →
 * frase» è collaudabile contro un repo vero.
 */
import { existsSync } from "fs";
import { branchExistsInRepo, countCommitsAhead } from "./branch-status";

/**
 * Esito della verifica sul ref, MAI una supposizione:
 *  • `present`    — `git rev-parse --verify` ha risolto il branch;
 *  • `gone`       — il ref non risolve: il branch non c'è;
 *  • `unverified` — non si è potuto guardare (repo non risolvibile, git in
 *                   errore). Ignoranza, che non è né una promessa né un allarme.
 */
export type AbandonBranchState = "present" | "gone" | "unverified";

export interface AbandonNoticeInput {
  /** Perché il worktree è stato liberato (la ragione della decisione del GC). */
  reason: string;
  /** Il branch del worktree, `null` se non ne aveva uno proprio. */
  branchName: string | null;
  /** Esito della verifica sul ref. */
  branchState: AbandonBranchState;
  /**
   * Commit del branch oltre `main`, `null` se non contabili (branch assente,
   * `main` inesistente, git in errore). Vale solo con `branchState: "present"`.
   */
  aheadOfMain?: number | null;
}

/** Un conteggio si stampa solo se è un intero non negativo davvero letto da git. */
function usableCount(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Compone la riga di abbandono a partire dai FATTI ACCERTATI.
 *
 * Tre parti: perché il worktree è sparito, che ne è del branch (verificato), e
 * dove finisce il task. La parte centrale è quella che prima mentiva.
 */
export function composeAbandonNotice(input: AbandonNoticeInput): string {
  // La ragione arriva da `decideWorktreeReap`/dal ramo «riga fantasma» e non
  // porta punteggiatura: si normalizza qui perché il punto lo mette la frase.
  const reason = input.reason.trim().replace(/[.\s]+$/, "");
  const head = reason ? `Worktree liberato: ${reason}.` : "Worktree liberato.";
  const tail = "Il task torna in backlog perché la sessione non c'è più.";
  const b = input.branchName;

  let middle: string;
  if (!b) {
    // Nessun branch proprio: non c'è niente da promettere e niente da recuperare
    // per nome — dirlo è più utile che tacere.
    middle = "Questo worktree non aveva un branch proprio: non c'è un ref da cui ripartire.";
  } else if (input.branchState === "gone") {
    // IL CASO CHE PRIMA MENTIVA. Qui non si rassicura: si dice che il ref non
    // c'è e si indica dove un commit può ancora essere (reflog / oggetti
    // irraggiungibili), invece di mandare a un nome morto.
    middle =
      `⚠️ Verificato ora: \`git rev-parse --verify ${b}\` non risolve: il branch NON c'è, ` +
      `quindi non posso dire che il lavoro committato sia salvo. ` +
      `Dove guardare: \`git reflog\` e \`git fsck --lost-found\` nel repo del progetto.`;
  } else if (input.branchState === "unverified") {
    // Non aver potuto guardare non autorizza a rassicurare: si passa la palla,
    // con il comando esatto da dare.
    middle =
      `Il branch \`${b}\` NON è stato verificato (repo del progetto non raggiungibile): ` +
      `controlla con \`git rev-parse --verify ${b}\` prima di dare per salvo il lavoro.`;
  } else {
    const ahead = usableCount(input.aheadOfMain);
    if (ahead === null) {
      middle =
        `Verificato ora: il branch \`${b}\` c'è (i commit oltre main non sono contabili). ` +
        `Per riprendere: \`git switch ${b}\`.`;
    } else if (ahead === 0) {
      // «C'è» non vuol dire «contiene qualcosa»: un branch a zero commit oltre
      // main è la differenza fra «riprendi da lì» e «non c'era niente».
      middle = `Verificato ora: il branch \`${b}\` c'è ma non ha commit oltre main, quindi non c'è lavoro committato da recuperare.`;
    } else {
      middle =
        `Verificato ora: il branch \`${b}\` c'è, con ${ahead} commit oltre main. ` +
        `Per riprendere: \`git switch ${b}\`.`;
    }
  }

  return `${head} ${middle} ${tail}`;
}

/**
 * La versione che GUARDA e poi scrive: due spawn di git (`rev-parse --verify`,
 * `rev-list --count`) e poi la funzione pura qui sopra.
 *
 * Sta qui e non nel chiamante di proposito: così l'intero percorso «verifica →
 * frase» è collaudabile contro un repo vero, invece di restare glue non testata
 * dentro `server.ts` — che è esattamente dove la formula fissa era sopravvissuta.
 *
 * `repoPath` assente o cartella sparita ⇒ `unverified`: non si è potuto
 * guardare. Se invece git risponde ma il ref non risolve, è `gone` — un allarme.
 * Un git che esplodesse davvero degraderebbe anch'esso ad allarme, che è il lato
 * sbagliato meno pericoloso: fa controllare, non fa stare tranquilli.
 */
export async function abandonNoticeFromRepo(args: {
  reason: string;
  repoPath: string | null;
  branchName: string | null;
}): Promise<string> {
  const { reason, repoPath, branchName } = args;
  if (!repoPath || !branchName || !existsSync(repoPath)) {
    return composeAbandonNotice({ reason, branchName, branchState: "unverified" });
  }
  const present = await branchExistsInRepo(repoPath, branchName);
  if (!present) return composeAbandonNotice({ reason, branchName, branchState: "gone" });
  const aheadOfMain = await countCommitsAhead(repoPath, branchName);
  return composeAbandonNotice({ reason, branchName, branchState: "present", aheadOfMain });
}
