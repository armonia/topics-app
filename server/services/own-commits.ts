/**
 * Quali commit sono PROPRI di un branch — la sottrazione che separa il lavoro di
 * una card da quello che ha soltanto EREDITATO.
 *
 * Il worktree di una card nasceva da `baseRef: "HEAD"` sul checkout CONDIVISO:
 * se lì era parcheggiata un'altra sessione, il branch del task eredita i suoi
 * commit. La punta del ramo non risponde quindi alla domanda «cosa ha prodotto
 * questa card»: il 10/08 la consegna di `dd2aa40d` registrava `987cd8ae`, che
 * era il commit di un ALTRO task ed era già su main — chi rivedeva leggeva il
 * diff sbagliato e il land diceva «non c'è niente da portare».
 *
 * Il discrimine non ha bisogno di ricordare da dove il worktree è nato: un
 * commit EREDITATO è raggiungibile anche da un ALTRO branch locale, uno fatto
 * dentro questo worktree no. Quindi `main..branch --not <gli altri branch>`
 * lascia esattamente i commit del task. È la stessa domanda che si fa il
 * cancello del land (`task-automerge.ts`), che da qui la legge: una domanda
 * sola, una risposta sola — due copie divergono, e la copia sbagliata è quella
 * che pubblica il lavoro di un altro.
 *
 * CONTRATTO, uguale per tutte le funzioni: `null` = NON CONTABILE (il branch non
 * esiste, `main` non esiste, git ha sbagliato, la cartella non è un repo) — mai
 * `[]` o `0`, che dicono «verificato: non ha niente di suo». Sono affermazioni
 * diverse e chi chiama ne fa usi OPPOSTI: su «non lo so» non si tocca niente,
 * su «verificato vuoto» si registra il vuoto.
 */

import type { TaskFile } from "../../shared/task-labels";
import { RESIDUE_SUBJECT } from "./worktree-residue";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr?: string;
}

/**
 * L'ambiente di UNA chiamata a git. Serve a una domanda sola, e per quella non
 * c'è altra strada: `git apply --cached` lavora sull'INDICE, e per chiedergli
 * «questo contenuto sta già nell'albero di main?» l'indice dev'essere quello di
 * main, non quello del checkout — che è su un altro branch, o sporco, o
 * entrambe. `GIT_INDEX_FILE` punta a un indice temporaneo e la domanda smette di
 * dipendere da com'è messo il checkout in quel momento.
 */
export interface GitRunEnv {
  env?: Record<string, string>;
}

/**
 * Stessa firma del runner iniettabile dell'automerge, così i due la condividono.
 * Il terzo parametro è opzionale da entrambi i lati: un doppio di test scritto
 * `(cwd, args) => …` resta assegnabile, e semplicemente non lo guarda.
 */
export type GitRunner = (cwd: string, args: string[], opts?: GitRunEnv) => Promise<GitRunResult>;

export interface OwnCommitsOptions {
  /** Il branch d'integrazione, cioè il «da dove in poi» della domanda. Default `main`. */
  mainRef?: string;
  /** Iniettato nei test, o condiviso da chi ne ha già uno. Default: `git` vero, che non lancia mai. */
  runGit?: GitRunner;
  /**
   * Gli altri branch già enumerati da chi chiama (`otherLocalBranches`), per non
   * ripetere il `for-each-ref`. Chi lo passa ha già gestito il suo `null`: qui
   * una lista vuota vale «nessun altro branch», non «non lo so».
   */
  others?: readonly string[];
  /**
   * Branches that are THIS card's own history and must not be subtracted: the
   * previous attempts' branches. A card re-dispatched onto a new worktree
   * continues the old branch, which stays in `refs/heads/` with no worktree;
   * subtracting it counted the card's own commits as foreign and the land tried
   * to cherry-pick "what remained" into the conflicts the merges had already
   * resolved (1929291c, 2026-09-04: three lands refused on a branch that
   * merged clean). Names as `refs/heads/...` or short: both are accepted.
   */
  ownRefs?: readonly string[];
}

/**
 * I nomi si normalizzano a `refs/heads/…` prima di finire in un range git: un
 * branch che si chiama come un file esistente renderebbe altrimenti ambiguo
 * `main..<nome>`, e git rifiuterebbe la domanda invece di rispondere.
 */
function refName(name: string): string {
  return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}

/**
 * Il runner vero, esportato perché la sottrazione non è l'unica domanda che si
 * fa a git su un branch di card: chi compone una GAMMA a partire dai commit
 * propri (`task-diff-range.ts`) deve poter passare QUESTO runner a
 * `listOwnCommits` e usarlo anche per le sue chiamate, altrimenti i test che ne
 * iniettano uno finto si troverebbero metà delle domande sul git vero.
 */
export async function defaultRunGit(cwd: string, args: string[], opts?: GitRunEnv): Promise<GitRunResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

function lines(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Il commit è DENTRO `ref`? La domanda si fa sul COMMIT e non sul ramo, ed è la
 * differenza fra sapere e non sapere: dopo un land riuscito il ramo della card
 * viene POTATO, mentre l'oggetto del commit resta nel repo (`gc.pruneExpire` qui
 * è 90 giorni). Chiedere del ramo, da quel momento in poi, risponde «non c'è» a
 * un lavoro che invece è atterrato.
 *
 * Tre valori, e servono tutti e tre:
 *   • `true`  — verificato dentro (uscita 0 di `merge-base --is-ancestor`);
 *   • `false` — verificato fuori (uscita 1);
 *   • `null`  — NON CONTABILE: lo sha non risolve, `ref` non esiste, la cartella
 *     non è un repo. Chi chiama non deve poterlo confondere con `false`, perché
 *     gli usi sono opposti: su «fuori» si lavora, su «non lo so» non si tocca
 *     niente. È lo stesso contratto del resto del modulo.
 *
 * Una sola copia perché la risposta deve essere una sola: il cancello del land
 * (`task-automerge.ts`) e quello del dispatch (`task-dispatcher.ts`) decidono
 * cose opposte — pubblicare o non ripartire — sulla stessa affermazione, e due
 * copie che divergono vorrebbero dire ridispacciare ciò che si è appena chiuso.
 */
export async function commitIsIn(
  repoPath: string,
  commit: string,
  ref: string,
  opts: Pick<OwnCommitsOptions, "runGit"> = {},
): Promise<boolean | null> {
  const sha = commit.trim();
  if (!sha) return null;
  const run = opts.runGit ?? defaultRunGit;
  const res = await run(repoPath, ["merge-base", "--is-ancestor", sha, ref]);
  if (res.code === 0) return true;
  // `merge-base --is-ancestor` esce 1 per «no» e con un codice qualsiasi per
  // «non ho potuto rispondere» (ref inesistente, sha sconosciuto, repo assente).
  // Collassare tutto su `false` trasformerebbe l'ignoranza in una risposta.
  return res.code === 1 ? false : null;
}

/**
 * Gli altri branch locali: tutti tranne questo e quello d'integrazione. Sono i
 * ref da cui si SOTTRAE, e servono anche a chi compone il messaggio per l'umano
 * (il cherry-pick suggerito dal land li elenca).
 *
 * I ref sono condivisi da tutti i worktree del repo, quindi la lista è la stessa
 * letta dal checkout principale o da dentro il worktree della card.
 */
export async function otherLocalBranches(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions = {},
): Promise<string[] | null> {
  const run = opts.runGit ?? defaultRunGit;
  const res = await run(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  if (res.code !== 0) return null;
  const excluded = new Set([refName(branch), refName(opts.mainRef ?? "main"), ...(opts.ownRefs ?? []).map(refName)]);
  return lines(res.stdout).filter((r) => !excluded.has(r));
}

/**
 * Argomenti del `rev-list` che isola i commit propri, `--not` incluso solo se serve.
 *
 * IL COMMIT DI RESIDUO NON E' UNA CONSEGNA, e va tolto qui.
 *
 * Quando la potatura trova un worktree sporco non butta le modifiche: le
 * committa da sola con `RESIDUE_SUBJECT`, per non perderle. Quel commit e'
 * pero' indistinguibile da un commit dell'agente per chi conta i commit propri,
 * e da li' in poi la card dichiara un debito che non ha. Misurato il 21/08 su
 * tre card (`86931f04`, `f0613e3b`, `5bfd7356`): la pastiglia rossa «non e' su
 * main» accusava un lavoro che su main c'era gia', e il loro `delivery_commit`
 * era esattamente il commit di salvataggio. I timestamp lo dicono: residui alle
 * 16:31 del 19/08, card aggiornate alle 16:33. In repo ce ne sono 96, e il
 * numero cresce a ogni potatura di un worktree sporco.
 *
 * Il filtro sta QUI e non in chi chiama perche' `rangeArgs` e' l'unico passaggio
 * comune a `listOwnCommits` e `countOwnCommits`, cioe' a tutti e sette i
 * consumatori — fra cui `landing-verdict.ts`, che e' proprio chi scrive
 * `unlanded`. Metterlo a valle vorrebbe dire scriverlo sette volte e
 * dimenticarlo all'ottavo.
 *
 * `--fixed-strings` perche' il soggetto e' testo, non una regex: senza, un
 * metacarattere nel soggetto cambierebbe in silenzio cosa viene filtrato.
 */
function rangeArgs(branch: string, mainRef: string, others: readonly string[]): string[] {
  const range = `${refName(mainRef)}..${refName(branch)}`;
  const senzaResidui = ["--fixed-strings", `--grep=${RESIDUE_SUBJECT}`, "--invert-grep"];
  return others.length
    ? [...senzaResidui, range, "--not", ...others.map(refName)]
    : [...senzaResidui, range];
}

/** Gli altri branch: quelli passati da chi chiama, o enumerati adesso. */
async function resolveOthers(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions,
): Promise<string[] | null> {
  if (opts.others) return [...opts.others];
  // Senza la lista da cui sottrarre non si può rispondere: cadere sul solo
  // `main..branch` vorrebbe dire rivendicare il lavoro altrui, cioè il difetto.
  return otherLocalBranches(repoPath, branch, opts);
}

/**
 * Gli SHA (interi, dal più RECENTE) dei commit propri del branch. `[]` = nessuno,
 * verificato. `null` = non contabile.
 *
 * Il primo elemento è il puntatore di consegna: «l'ultimo commit che questa card
 * ha davvero prodotto».
 */
export async function listOwnCommits(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions = {},
): Promise<string[] | null> {
  const run = opts.runGit ?? defaultRunGit;
  const others = await resolveOthers(repoPath, branch, opts);
  if (others === null) return null;
  const res = await run(repoPath, ["rev-list", ...rangeArgs(branch, opts.mainRef ?? "main", others)]);
  if (res.code !== 0) return null;
  return lines(res.stdout);
}

/**
 * QUANTI sono i commit propri. `0` = nessuno, verificato. `null` = non contabile.
 *
 * Ha la sua strada (`--count`) invece di misurare la lista: è la domanda che si
 * fa il cancello del land, e non paga il trasferimento di N sha per un numero.
 */
export async function countOwnCommits(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions = {},
): Promise<number | null> {
  const run = opts.runGit ?? defaultRunGit;
  const others = await resolveOthers(repoPath, branch, opts);
  if (others === null) return null;
  const res = await run(repoPath, ["rev-list", "--count", ...rangeArgs(branch, opts.mainRef ?? "main", others)]);
  if (res.code !== 0) return null;
  const n = res.stdout.trim();
  return /^\d+$/.test(n) ? Number.parseInt(n, 10) : null;
}

/** Il branch visto dal land: cosa porterebbe in tutto, e quanto di quello è suo. */
export interface AheadSplit {
  /** Tutti i commit che `main` non ha, dal più RECENTE. SHA interi. */
  ahead: string[];
  /** Di quelli, i PROPRI — sottoinsieme di `ahead`, stesso ordine. */
  own: string[];
  /** I ref da cui si è sottratto (`refs/heads/…`): servono a chi scrive la prova. */
  others: string[];
}

/**
 * Le DUE liste insieme, per chi non deve solo sapere quanti commit sono suoi ma
 * anche QUALI sono degli altri — la diagnostica del board-doctor, che dalla
 * differenza tira fuori il commit estraneo più recente (l'impronta della causa
 * condivisa fra più card).
 *
 * Sta qui e non nel doctor perché è la stessa sottrazione del land: due copie
 * divergono, e siccome il doctor CONFRONTA il suo insieme con la consegna
 * registrata da `deliveryPointer`, la deriva fra le due sarebbe proprio il
 * falso allarme che il controllo esiste per non dare.
 *
 * `null` = non contabile, come le altre.
 */
export async function splitAheadCommits(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions = {},
): Promise<AheadSplit | null> {
  const run = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const others = await resolveOthers(repoPath, branch, opts);
  if (others === null) return null;
  const aheadRes = await run(repoPath, ["rev-list", ...rangeArgs(branch, mainRef, [])]);
  if (aheadRes.code !== 0) return null;
  const ahead = lines(aheadRes.stdout);
  // Senza altri branch non c'è niente da sottrarre: la seconda `rev-list`
  // darebbe la stessa risposta, e il doctor gira su ogni card in review.
  if (others.length === 0) return { ahead, own: [...ahead], others };
  const own = await listOwnCommits(repoPath, branch, { ...opts, others });
  if (own === null) return null;
  return { ahead, own, others };
}

/** Cosa ha consegnato una card: il suo branch e il commit PROPRIO più recente. */
export interface DeliveryPointer {
  branch: string;
  /** `null` = «questa card non ha prodotto codice» — un'informazione, e va detta. */
  commit: string | null;
}

/**
 * La fotografia della consegna, presa sull'ingresso in `review` e ripresa dal
 * backfill periodico dell'audit: branch + commit PROPRIO più recente.
 *
 * Tre esiti, tutti e tre distinti apposta:
 *   • `{ branch, commit }` — c'è del lavoro suo, e quello è il puntatore durevole
 *     (il branch muore col reap, il commit no: `gc.pruneExpire` qui è 90 giorni);
 *   • `{ branch, commit: null }` — verificato: non ha prodotto codice. Registrarlo
 *     è meglio del ritratto sbagliato, e chi rivede lo legge come tale;
 *   • `null` — non si è potuto guardare: nessuna fotografia, così una consegna
 *     già registrata non viene cancellata da un singhiozzo di git.
 */
export async function deliveryPointer(
  repoPath: string,
  branch: string,
  opts: OwnCommitsOptions = {},
): Promise<DeliveryPointer | null> {
  const own = await listOwnCommits(repoPath, branch, opts);
  if (own === null) return null;
  return { branch, commit: own[0] ?? null };
}

/**
 * I file toccati dai commit propri, uniti in una lista sola, con l'unica cosa
 * che il path da solo non dice: se il file è NATO in questi commit.
 *
 * Prende l'uscita di `git show --name-status --format= --no-renames` — una riga
 * `<stato>\t<path>` per file — un'uscita per commit, dal più recente al più
 * vecchio. Serve a `deriveKind`, che senza il flag non può distinguere una
 * funzionalità nuova da una modifica a codice che esisteva già.
 *
 * `added` è vero se ANCHE UN SOLO commit proprio ha il file come `A`: nato qui e
 * poi modificato tre volte resta nato qui. È esattamente il perché non basta
 * guardare l'ultimo commit.
 *
 * `--no-renames` è dell'invocazione, non di questo parser, e serve: con i rename
 * git stampa `R100` e DUE path sulla stessa riga, e un file rinominato passerebbe
 * per un file nuovo, cioè trasformerebbe ogni riordino in una `feature`.
 */
export function mergeNameStatus(outputs: readonly string[]): TaskFile[] {
  const order: string[] = [];
  const added = new Set<string>();
  const seen = new Set<string>();
  for (const out of outputs) {
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue; // le righe senza stato non sono file (`--format=` lascia dei vuoti)
      const status = line.slice(0, tab).trim();
      const path = line.slice(tab + 1).trim();
      if (!status || !path) continue;
      if (!seen.has(path)) { seen.add(path); order.push(path); }
      // `A` e non `startsWith('A')`: `AM` non esiste in `show`, ma un `A` di
      // troppo scriverebbe «nuovo» su un file che non lo è.
      if (status === "A") added.add(path);
    }
  }
  return order.map((path) => ({ path, added: added.has(path) }));
}
