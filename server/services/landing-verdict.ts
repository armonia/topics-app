/**
 * Il ramo di una card chiusa: `dentro`, `superato`, `fuori` — o «non lo so».
 *
 * `check:landed` chiedeva una domanda sola («la punta è dentro il contenuto di
 * main?») e da una risposta binaria tirava fuori un elenco unico: «landa il ramo
 * prima che il GC lo poti». Misurato il 12/08 sui 6 rami vivi fuori da
 * topics-app, quell'elenco conteneva 2 rami il cui lavoro è su main, 2 rami che
 * qualcun altro ha RIFATTO meglio tre giorni dopo, e 2 debiti veri. Nove voci di
 * cui due azionabili sono un elenco che si smette di leggere, e infatti.
 *
 * La discendenza mente in due modi, e sono due modi diversi:
 *   · il land RICOPIA i commit (cherry-pick), quindi la copia atterrata ha un
 *     altro sha e il ramo resta «fuori» anche col contenuto dentro;
 *   · un problema può essere risolto da un ALTRO, in un altro modo. Il ramo del
 *     19/07 faceva l'outline delle domande con un IntersectionObserver in 159
 *     righe; il 22/07 su main è atterrato un navigatore a pallini in 64 righe che
 *     risolve la stessa cosa meglio. Quel ramo è un fossile, non un debito.
 *
 * Quindi tre esiti, più un quarto che è la parte onesta:
 *   · `dentro`      il contenuto è su main, comunque ci sia arrivato. Prova per
 *                   CONTENUTO: i file toccati sono identici di là, oppure le
 *                   righe distintive del ramo si trovano già su main.
 *   · `superato`    ogni file che il ramo tocca è stato cambiato su main DOPO il
 *                   commit del ramo, le righe del ramo non ci sono, e il ramo
 *                   non si fonde più pulito: main ha rifatto lo STESSO terreno.
 *                   Si dice col commit e la data che l'hanno superato, così si
 *                   controlla: da solo, «superato» sarebbe un'opinione.
 *   · `fuori`       il contenuto non c'è e nessuno ha rifatto quei file. Solo
 *                   questo è debito, e solo qui ha senso «landa prima del GC».
 *   · `non-decidibile`  il ramo non ha righe abbastanza lunghe da cercare. Va
 *                   detto. Un forse messo fra i debiti per prudenza annacqua
 *                   tutte le certezze che gli stanno intorno, ed è esattamente
 *                   il difetto che questo modulo esiste per non ripetere.
 *
 * Il metodo NON dimostra l'equivalenza semantica, e non finge di farlo: dice
 * dove sono finite le righe e chi ha toccato quei file dopo. La prova è
 * ricontrollabile a mano con due comandi git, che chi stampa affianca al
 * verdetto.
 */

import { filterUniqueSourceFiles } from "./branch-status";
import { defaultRunGit, listOwnCommits, type GitRunner } from "./own-commits";

/**
 * Quanto dev'essere lunga una riga per valere come impronta del ramo. Sotto i 60
 * caratteri si finisce a cercare `});`, `const [open, setOpen] = useState(false)`
 * e le chiusure di JSX, che stanno su main in ogni caso e direbbero «dentro» di
 * qualunque cosa.
 */
export const RIGA_DISTINTIVA_MIN = 60;

/** Sotto tre impronte il campione non regge un verdetto: si dice «non lo so». */
export const RIGHE_MINIME = 3;

/**
 * La quota di impronte che devono stare su main perché il ramo sia «dentro».
 * Non 1: il lavoro atterra e POI evolve, quindi qualche riga viene riscritta. Il
 * numero non è arbitrario, è dove cade il crinale misurato sui 6 casi del 12/08
 * (dentro: 1.00 e 0.82 · fuori o superati: 0.12, 0.07, 0.04, 0.00). Fra 0.82 e
 * 0.12 non c'è niente, e la soglia sta nel vuoto.
 */
export const SOGLIA_DENTRO = 0.75;

/** Tetto ai commit propri letti: oltre, il campione di righe è già abbondante. */
const MAX_COMMIT = 50;

export type LandingEsito = "dentro" | "superato" | "fuori" | "non-decidibile";

/** Il commit di main che ha rifatto i file del ramo dopo di lui. */
export interface CommitSuperante {
  sha: string;
  /** Data del commit, ISO. */
  data: string;
  subject: string;
  /** Quanti dei file del ramo tocca: è il motivo per cui è QUESTO e non un altro. */
  fileToccati: number;
}

export interface LandingVerdict {
  esito: LandingEsito;
  /** Una riga di motivazione, già pronta da stampare accanto al verdetto. */
  motivo: string;
  /** Le impronte cercate su main e quante ne sono state trovate. */
  righe: { cercate: number; presenti: number };
  /** I file sorgente che il ramo tocca (rumore generato escluso). */
  file: string[];
  /** Di quelli, i file che su main non esistono affatto: non si superano, mancano. */
  assentiSuMain: string[];
  /** Valorizzato solo su `superato`. Senza, «superato» non si stampa. */
  superatoDa: CommitSuperante | null;
  /** Quanti commit di main hanno toccato quei file dopo il ramo. */
  commitDopo: number;
}

export interface LandingVerdictOptions {
  mainRef?: string;
  runGit?: GitRunner;
  /**
   * L'indice delle righe di main, se chi chiama lo ha già costruito. Serve a
   * pagarlo UNA volta per repo invece che una volta per ramo: `check:landed`
   * classifica fino a nove rami e sei stanno nello stesso checkout.
   */
  indiceMain?: ReadonlySet<string>;
}

/**
 * Tutte le righe lunghe presenti su `mainRef`, per poter chiedere «questa riga
 * è di là?» senza pagare una `git grep` a domanda.
 *
 * Una `git grep` per riga costava mezzo secondo l'una: su un ramo con 75
 * impronte erano 35 secondi, e la misura di un solo repo non stava dentro il
 * minuto. Un `grep` col pattern VUOTO stampa invece l'intero albero in una
 * chiamata sola (0,2s su 150k righe), e da lì l'appartenenza è un `Set`. Le
 * righe corte non entrano: sono le uniche che non verranno mai chieste, e sono
 * i due terzi del volume.
 */
export async function indiceRigheMain(
  repoPath: string,
  mainRef = "main",
  runGit: GitRunner = defaultRunGit,
): Promise<Set<string>> {
  const indice = new Set<string>();
  // `-I` salta i binari, `-h` toglie il prefisso col nome del file.
  const res = await runGit(repoPath, ["grep", "-h", "-I", "-e", "", mainRef]);
  if (res.code !== 0) return indice;
  for (const riga of res.stdout.split("\n")) {
    const t = riga.trim();
    if (t.length >= RIGA_DISTINTIVA_MIN) indice.add(t);
  }
  return indice;
}

/** Una riga vale come impronta se è lunga e contiene qualcosa di alfanumerico. */
export function isRigaDistintiva(riga: string): boolean {
  const t = riga.trim();
  return t.length >= RIGA_DISTINTIVA_MIN && /[A-Za-z0-9]/.test(t);
}

interface DiffRaccolto {
  file: string[];
  /** Le righe aggiunte, per file. */
  aggiunte: Map<string, string[]>;
}

/**
 * Le righe che i commit PROPRI del ramo aggiungono, per file. `--unified=0`
 * perché il contesto non è lavoro del ramo: cercarlo su main direbbe «dentro»
 * sulle tre righe che il ramo ha solo sfiorato.
 */
async function raccogliDiff(
  repoPath: string,
  own: string[],
  git: GitRunner,
): Promise<DiffRaccolto> {
  const aggiunte = new Map<string, string[]>();
  for (const sha of own.slice(0, MAX_COMMIT)) {
    const res = await git(repoPath, ["show", "--format=", "--unified=0", "--no-color", "-M", sha]);
    if (res.code !== 0) continue;
    let corrente: string | null = null;
    for (const riga of res.stdout.split("\n")) {
      if (riga.startsWith("+++ ")) {
        const p = riga.slice(4).trim();
        corrente = p === "/dev/null" ? null : p.replace(/^b\//, "");
        if (corrente && !aggiunte.has(corrente)) aggiunte.set(corrente, []);
        continue;
      }
      // Solo le intestazioni vere, riconosciute dallo spazio: una riga aggiunta
      // che comincia per `++` (un `++i;` del codice) diventa `+++i;` nel diff, e
      // un confronto senza spazio la butterebbe via come se fosse un'intestazione.
      if (riga.startsWith("--- ") || riga.startsWith("@@")) continue;
      if (corrente && riga.startsWith("+")) aggiunte.get(corrente)!.push(riga.slice(1));
    }
  }
  const file = filterUniqueSourceFiles([...aggiunte.keys()]);
  for (const k of [...aggiunte.keys()]) if (!file.includes(k)) aggiunte.delete(k);
  return { file, aggiunte };
}

/** Quali dei file del ramo esistono su `mainRef`. Una `ls-tree` per tutti. */
async function fileSuMain(
  repoPath: string,
  mainRef: string,
  file: string[],
  git: GitRunner,
): Promise<Set<string>> {
  const res = await git(repoPath, ["ls-tree", "-r", "--name-only", mainRef, "--", ...file]);
  if (res.code !== 0) return new Set(file); // non lo so: nessuno viene dichiarato assente
  return new Set(res.stdout.split("\n").map((r) => r.trim()).filter(Boolean));
}

/** Il commit più recente di `mainRef` che tocca `file`, o `null`. */
async function ultimoTocco(
  repoPath: string,
  mainRef: string,
  file: string,
  git: GitRunner,
): Promise<CommitSuperante | null> {
  const res = await git(repoPath, ["log", mainRef, "-1", "--format=%H%x09%cI%x09%s", "--", file]);
  if (res.code !== 0) return null;
  const riga = res.stdout.split("\n")[0]?.trim() ?? "";
  const [sha, data, ...resto] = riga.split("\t");
  if (!sha || !data) return null;
  return { sha, data, subject: resto.join("\t"), fileToccati: 1 };
}

/**
 * Il ramo si fonderebbe ancora dentro main senza conflitti?
 *
 * È la domanda che separa «superato» da «debito», e le due si somigliano solo a
 * guardare le date. Misurato il 12/08 su `epic-chimera`: il ramo AGGIUNGE una
 * sezione in fondo a CONTRIBUTING.md, main quel file l'ha toccato due volte dopo
 * per tutt'altro, e la sola regola delle date lo assolveva come superato. Non lo
 * era: quella sezione su main non c'è, e il bottone «Landa» funzionerebbe ancora.
 *
 * Un conflitto invece dice che main ha rifatto lo STESSO terreno, e nello stesso
 * momento dice la cosa pratica che serve a chi legge: quel ramo non si landa
 * più con un click, quindi trattarlo da debito non aiuterebbe nessuno.
 *
 * `merge-tree --write-tree` esce 0 se pulito, 1 se in conflitto, altro se non sa
 * (git troppo vecchio, ref illeggibile). Al «non so» si risponde «nessun
 * conflitto»: si finisce nella lista dei debiti, che è dove si stava prima, e
 * quella lista si guarda.
 */
async function inConflittoConMain(
  repoPath: string,
  mainRef: string,
  branch: string,
  git: GitRunner,
): Promise<boolean> {
  const res = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", mainRef, branch]);
  return res.code === 1;
}

/** Quanti commit di main hanno toccato quei file dopo `dopo`. */
async function commitDiMainDopo(
  repoPath: string,
  mainRef: string,
  file: string[],
  dopo: string,
  git: GitRunner,
): Promise<number> {
  if (file.length === 0) return 0;
  const res = await git(repoPath, ["log", mainRef, "--format=%cI", "--", ...file]);
  if (res.code !== 0) return 0;
  return res.stdout.split("\n").map((r) => r.trim()).filter((d) => d && d > dopo).length;
}

/**
 * Il commit di main che ha superato il ramo, se OGNI file toccato è stato
 * ricambiato di là dopo. Basta un file rimasto fermo su main perché non sia
 * supersessione: quel file il ramo lo cambia ancora, e nessuno l'ha rifatto.
 *
 * Fra i candidati vince quello che tocca PIÙ file del ramo, non il più recente:
 * il più recente è spesso una rifinitura di passaggio, mentre quello che li
 * rifà quasi tutti è il lavoro che ha preso il posto del ramo. A parità, il più
 * recente. Il caso misurato il 12/08: su ChatMessages/ChatOutline/ChatWorkspace
 * vince il navigatore a pallini del 22/07 (2 file su 3), non il fix al
 * disclaimer del 23/07 (1 su 3), ed è il primo che un umano riconosce.
 *
 * Un file che su main NON esiste non è superato, manca: e allora non lo è
 * nemmeno il ramo, perché quel pezzo di lavoro non ce l'ha nessuno.
 */
async function cercaSupersessione(
  repoPath: string,
  mainRef: string,
  file: string[],
  esistenti: ReadonlySet<string>,
  dopo: string,
  git: GitRunner,
): Promise<CommitSuperante | null> {
  if (file.length === 0) return null;
  const perSha = new Map<string, CommitSuperante>();
  for (const f of file) {
    if (!esistenti.has(f)) return null;
    const tocco = await ultimoTocco(repoPath, mainRef, f, git);
    // Nessun tocco, o un tocco che precede il ramo: questo file su main è come
    // il ramo l'ha trovato, quindi non c'è niente che lo abbia superato.
    if (!tocco || tocco.data <= dopo) return null;
    const gia = perSha.get(tocco.sha);
    if (gia) gia.fileToccati += 1;
    else perSha.set(tocco.sha, { ...tocco });
  }
  const candidati = [...perSha.values()].sort(
    (a, b) => b.fileToccati - a.fileToccati || b.data.localeCompare(a.data),
  );
  return candidati[0] ?? null;
}

/** La data (ISO) del commit proprio più recente del ramo. */
async function dataDelRamo(repoPath: string, own: string[], git: GitRunner): Promise<string | null> {
  let ultima: string | null = null;
  for (const sha of own.slice(0, MAX_COMMIT)) {
    const res = await git(repoPath, ["log", "-1", "--format=%cI", sha]);
    const d = res.code === 0 ? res.stdout.trim() : "";
    if (d && (!ultima || d > ultima)) ultima = d;
  }
  return ultima;
}

/**
 * Le impronte del ramo, e quante ne ha main. La ricerca è su TUTTO l'albero e
 * non nel solo file d'origine: una riga atterrata può essere finita altrove
 * (rinomina, componente estratto), e chiamarla persa sarebbe di nuovo l'errore
 * della discendenza, cioè guardare il contenitore invece del contenuto.
 */
function contaPresenti(
  aggiunte: Map<string, string[]>,
  indice: ReadonlySet<string>,
): { cercate: number; presenti: number } {
  const impronte = new Set<string>();
  for (const righe of aggiunte.values()) {
    for (const r of righe) {
      const t = r.trim();
      if (isRigaDistintiva(t)) impronte.add(t);
    }
  }
  let presenti = 0;
  for (const imp of impronte) if (indice.has(imp)) presenti += 1;
  return { cercate: impronte.size, presenti };
}

/** Il ramo lascia ogni file che tocca identico a main? */
async function tuttiIFileIdentici(
  repoPath: string,
  mainRef: string,
  branch: string,
  file: string[],
  git: GitRunner,
): Promise<boolean> {
  if (file.length === 0) return false;
  const res = await git(repoPath, ["diff", "--quiet", branch, mainRef, "--", ...file]);
  return res.code === 0;
}

/**
 * Il verdetto a tre esiti su un ramo di consegna ancora vivo.
 *
 * Chi chiama ha già stabilito che il ramo esiste e che la sua punta non è dentro
 * main per discendenza: qui si risponde alla domanda dopo, cioè se quello che il
 * ramo porta sia comunque arrivato, sia stato rifatto da altri, o manchi davvero.
 *
 * L'ordine delle domande è l'ordine della fiducia. Prima le due prove di
 * CONTENUTO, perché «il lavoro è di là» batte qualunque altra spiegazione.
 * Poi la supersessione, che è una spiegazione e come tale va firmata con un
 * commit e una data. Il debito resta alla fine, e solo se c'era abbastanza da
 * cercare: quando non c'era, l'esito è «non lo so» e si dice.
 */
export async function classifyBranchLanding(
  repoPath: string,
  branch: string,
  opts: LandingVerdictOptions = {},
): Promise<LandingVerdict> {
  const git = opts.runGit ?? defaultRunGit;
  const mainRef = opts.mainRef ?? "main";
  const nudo = { righe: { cercate: 0, presenti: 0 }, file: [], assentiSuMain: [], superatoDa: null, commitDopo: 0 };

  if ((await git(repoPath, ["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`])).code !== 0) {
    return { ...nudo, esito: "non-decidibile", motivo: `non decidibile: il repo non ha ${mainRef}` };
  }
  const own = await listOwnCommits(repoPath, branch, { mainRef, runGit: git });
  if (own === null) {
    return { ...nudo, esito: "non-decidibile", motivo: "non decidibile: i commit propri del ramo non sono contabili" };
  }
  if (own.length === 0) {
    return { ...nudo, esito: "dentro", motivo: "nessun commit proprio oltre main" };
  }

  const { file, aggiunte } = await raccogliDiff(repoPath, own, git);
  if (file.length === 0) {
    return { ...nudo, esito: "dentro", motivo: "tocca solo file generati (lock, bundle, versione): niente da perdere" };
  }

  const indice = opts.indiceMain ?? (await indiceRigheMain(repoPath, mainRef, git));
  const esistenti = await fileSuMain(repoPath, mainRef, file, git);
  const assentiSuMain = file.filter((f) => !esistenti.has(f));
  const righe = contaPresenti(aggiunte, indice);
  const base = { righe, file, assentiSuMain };

  if (await tuttiIFileIdentici(repoPath, mainRef, branch, file, git)) {
    const quanti = file.length === 1 ? "l'unico file toccato è identico" : `tutti e ${file.length} i file toccati sono identici`;
    return { ...base, esito: "dentro", superatoDa: null, commitDopo: 0, motivo: `${quanti} su main` };
  }
  if (righe.cercate >= RIGHE_MINIME && righe.presenti / righe.cercate >= SOGLIA_DENTRO) {
    return {
      ...base, esito: "dentro", superatoDa: null, commitDopo: 0,
      motivo: `${righe.presenti}/${righe.cercate} righe distintive sono già su main`,
    };
  }

  const dataRamo = await dataDelRamo(repoPath, own, git);
  // Due condizioni, e servono tutte e due: che main abbia rifatto quei file DOPO
  // (le date), e che abbia rifatto lo stesso terreno (il conflitto). Con le sole
  // date, un ramo che aggiunge un paragrafo in fondo a un file molto trafficato
  // veniva assolto da modifiche che non lo riguardavano.
  const inConflitto = await inConflittoConMain(repoPath, mainRef, branch, git);
  const superatoDa =
    dataRamo && inConflitto
      ? await cercaSupersessione(repoPath, mainRef, file, esistenti, dataRamo, git)
      : null;
  if (superatoDa && dataRamo) {
    const commitDopo = await commitDiMainDopo(repoPath, mainRef, file, dataRamo, git);
    const quali = file.length === 1 ? "l'unico file che tocca è cambiato" : `tutti e ${file.length} i file che tocca sono cambiati`;
    return {
      ...base, esito: "superato", superatoDa, commitDopo,
      motivo:
        `${quali} su main dopo il ramo (${dataRamo.slice(0, 10)}), in ${commitDopo} commit; ` +
        `di suo su main ne restano ${righe.presenti}/${righe.cercate} righe`,
    };
  }
  if (righe.cercate >= RIGHE_MINIME) {
    const mancanti = assentiSuMain.length ? `, e ${assentiSuMain.length} dei suoi file su main non esistono` : "";
    // Se si fonde ancora pulito, il bottone «Landa su main» funziona: è la
    // differenza fra un debito che si paga con un click e uno da cherry-pick.
    const landabile = inConflitto ? "; non si fonde pulito, va ripreso a mano" : "; si fonde ancora pulito su main";
    return {
      ...base, esito: "fuori", superatoDa: null, commitDopo: 0,
      motivo: `${righe.cercate - righe.presenti}/${righe.cercate} righe distintive non sono su main${mancanti}${landabile}`,
    };
  }
  return {
    ...base, esito: "non-decidibile", superatoDa: null, commitDopo: 0,
    motivo: `non decidibile: nessuna riga distintiva (solo ${righe.cercate} righe da ${RIGA_DISTINTIVA_MIN} caratteri in su)`,
  };
}
