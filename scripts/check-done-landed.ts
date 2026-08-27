#!/usr/bin/env bun
/**
 * «Done» deve voler dire «è nel prodotto»: le card chiuse col commit di consegna
 * FUORI dal contenuto di main, contate a voce.
 *
 * Il guasto dell'11/08 (card `2e6964cb`): il land non è riuscito, il thread lo
 * scriveva — «⚠️ Land NON riuscito … Il branch del task NON è su main» — e lo
 * stato diceva `done`. Sulla board la card stava in Done come tutte le altre.
 * La colonna Done è l'unica cosa che si guarda quando si tira una riga: una card
 * lì dentro col codice fuori da main è lavoro che nessuno cerca più, e il GC dei
 * worktree può potarne il ramo. Quella volta era documentazione ed è stata
 * rimessa a mano; con del codice sarebbe sparita in silenzio.
 *
 * Il cancello che chiude il buco sta nel land (`task-automerge.ts` +
 * `landFallout`): un land fallito TOGLIE la card da Done. Questo script è la
 * MISURA — lo stesso conto fatto a mano quella notte — e serve a due cose: dire
 * che l'arretrato è stato smaltito, e accorgersi se il cancello ricomincia a
 * perdere.
 *
 * Due conti, non uno. Quello storico — le card chiuse col commit di consegna
 * fuori dal contenuto di main — e quello RECUPERABILE: le card chiuse il cui
 * RAMO esiste ancora e non è dentro main, cioè quelle su cui si può ancora fare
 * qualcosa. Il primo contiene anche rami già potati, che nessun bottone salva.
 *
 * Il conto recuperabile si legge a TRE esiti, non a due (`landing-verdict.ts`),
 * perché la discendenza mette storia e debito nella stessa lista. Misurato il
 * 12/08 sui 6 rami vivi fuori da topics-app: 2 avevano il contenuto su main
 * (il land ricopia, quindi lo sha non torna), 2 erano stati SUPERATI da un
 * lavoro atterrato tre giorni dopo che risolveva la stessa cosa meglio, 2 erano
 * debito vero. Sei righe identiche che dicevano tutte «landa prima del GC»
 * erano un elenco che si smette di leggere, e infatti nessuno lo leggeva.
 *
 *   dentro    il contenuto è di là comunque ci sia arrivato: niente da fare;
 *   superato  quei file su main li ha rifatti qualcun altro dopo. Stampato col
 *             commit e la data, se no è un'opinione;
 *   fuori     il DEBITO. Solo questo fa uscire il comando ≠0;
 *   non decidibile   nessuna riga distintiva da cercare. Detto in fondo e a
 *             parte: un forse in mezzo alle certezze le annacqua tutte.
 *
 *   bun run report:landed              # esce ≠0 solo se c'è del DEBITO vero
 *   bun run report:landed --json       # una riga JSON, per chi la vuole leggere a macchina
 *   bun run report:landed --strict     # fallisce anche sullo storico e sui commit SPARITI
 *   bun run report:landed --db <path>  # un altro database
 *
 * REFERTO, NON CANCELLO — e per costruzione, non per scelta. Si chiamava
 * `check:landed`, cioè come i sei `check:*` che la CI esegue, e quel nome era
 * l'unica cosa che si leggeva prima di trattarlo come una barra da tenere
 * verde. Non può esserlo:
 *
 *   · misura lo STATO DELLA BOARD, non il codice. Le righe 147-152 leggono
 *     `tasks WHERE status = 'done'`, le 196-217 leggono `task_comments` e i
 *     costi in `messages` — dati del database vivo, che cambiano quando qualcuno
 *     chiude una card, non quando cambia una riga di sorgente;
 *   · quel database è `data/topics.db`, che è in `.gitignore:174` e non è
 *     tracciato. Su un clone pulito, e quindi in CI, non esiste: la riga 105
 *     esce **2** prima di guardare qualsiasi cosa. Un passo di workflow che lo
 *     invocasse sarebbe rosso per sempre, e rosso per l'assenza di un file che
 *     nel repo non ci sarà mai;
 *   · guarda anche ALTRI repo. I checkout arrivano da `projects`, dai topic e
 *     da `scanWorkspaceProjects` (riga 128), quindi il debito che stampa può
 *     stare in un repo che non è questo — misurato il 13/08: dei 4 debiti, 2
 *     stavano in altri due repo della postazione (si leggono con `--json`, in
 *     `recoverable[].id`). Un cancello di *questo* repo che diventa rosso per
 *     un ramo di un altro non è un cancello di questo repo.
 *
 * Il suo codice d'uscita serve a chi legge il referto, non al deploy: dice
 * «c'è del lavoro consegnato che nessuno ha». Va guardato quando si tira una
 * riga sulla board, non prima di un push. Chi cerca la barra del deploy: è
 * `.github/workflows/ci.yml`, e questo file non c'è (né deve entrarci — il
 * perché è scritto lì, nell'elenco dei `check:*` che restano fuori).
 *
 * Sola lettura: apre il DB `{ readonly: true }` e gira solo comandi git di
 * lettura. Non ripara niente — landare è una decisione umana.
 *
 * «Nel contenuto di main», non «antenato di main»: il land RICOPIA i commit
 * della card (cherry-pick) invece di fonderli, quindi la copia atterrata ha un
 * altro sha e la discendenza direbbe di no su lavoro che è dentro. Il conto è
 * quello di `commitStatusFromRepo`, lo stesso dell'audit periodico — due copie
 * divergerebbero, e la copia sbagliata è quella che assolve.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../server/services/tasks";
import { branchExistsInRepo, commitStatusFromRepo, countCommitsAhead, resolveCommit, type BranchStatus } from "../server/services/branch-status";
import { classifyBranchLanding, classifyCommitLanding, indiceRigheMain, type LandingEsito, type LandingVerdict } from "../server/services/landing-verdict";
import { scanWorkspaceProjects } from "../server/services/project-path-resolver";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const JSON_OUT = argv.includes("--json");
const STRICT = argv.includes("--strict");
const DB_PATH = flag("--db") ?? process.env.TOPICS_DB
  ?? join(process.env.DATA_DIR ?? join(process.cwd(), "data"), "topics.db");
const WORKSPACE_DIR = process.env.DISPATCH_WORKSPACE_DIR ?? join(homedir(), ".openclaw", "workspace");

interface DoneRow {
  id: string;
  project_id: string;
  text: string;
  delivery_branch: string | null;
  delivery_commit: string;
  landing_state: string | null;
  landing_witnessed: number | null;
}

/** Una card chiusa e il verdetto sulla sua consegna. */
interface Verdict {
  id: string;
  text: string;
  projectId: string;
  branch: string | null;
  commit: string;
  /** `unmerged` = non è su main. `gone` = il commit non c'è più. */
  status: BranchStatus | "no-repo";
  /**
   * Da dove viene il verdetto. `land` = l'ha scritto il land che l'ha visto
   * succedere, mentre il ramo esisteva ancora: è un fatto, e nessuna euristica
   * lo tocca. `dedotto` = ricostruito qui dal solo commit, e allora vale quanto
   * vale — questo script esiste anche per dire quale delle due si sta leggendo.
   */
  fonte: "land" | "dedotto";
  repoPath: string | null;
}

if (!existsSync(DB_PATH)) {
  console.error(`nessun database in ${DB_PATH}. Passa --db <path> o DATA_DIR=…`);
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });

/**
 * `tasks.project_id` è un hash A SENSO UNICO del percorso (`projectIdForPath`):
 * per tornare alla cartella si ri-hasha ogni percorso che il DB conosce finché
 * uno combacia. Le sorgenti sono le stesse del server (progetti registrati,
 * cartelle dei topic, scansione del workspace) — meno una, e le card di quel
 * progetto diventerebbero «non verificabili» invece di essere guardate.
 */
function projectPaths(): string[] {
  const seen = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/")) return;
    const clean = p.replace(/\/+$/, "");
    if (clean) seen.add(clean);
  };
  try { for (const r of db.prepare("SELECT path FROM projects").all() as any[]) add(r.path); } catch { /* tabella assente */ }
  try {
    for (const r of db.prepare("SELECT DISTINCT project_path FROM topics WHERE project_path IS NOT NULL").all() as any[]) add(r.project_path);
  } catch { /* idem */ }
  for (const p of scanWorkspaceProjects(WORKSPACE_DIR)) add(p);
  return [...seen];
}

const byBoardId = new Map<string, string>();
for (const path of projectPaths()) {
  const id = projectIdForPath(path);
  // Primo che vince: l'ordine è progetti registrati → topic → workspace, cioè
  // dal più autorevole al più occasionale.
  if (!byBoardId.has(id) && existsSync(join(path, ".git"))) byBoardId.set(id, path);
}

// `landing_witnessed` può non esistere ancora (database precedente alla 099):
// la sua assenza vale «nessuna testimonianza», non un errore.
const hasWitness = (() => {
  try { return (db.prepare("PRAGMA table_info(tasks)").all() as any[]).some((c) => c.name === "landing_witnessed"); }
  catch { return false; }
})();

const rows = db.prepare(
  `SELECT id, project_id, text, delivery_branch, delivery_commit, landing_state,
          ${hasWitness ? "landing_witnessed" : "0 AS landing_witnessed"}
     FROM tasks
    WHERE archived = 0 AND status = 'done' AND delivery_commit IS NOT NULL`,
).all() as unknown as DoneRow[];

const verdicts: Verdict[] = [];
for (const r of rows) {
  const repoPath = byBoardId.get(r.project_id) ?? null;
  // Il verdetto TESTIMONIATO vince, e non si ricontrolla: l'ha scritto il land
  // mentre il ramo c'era ancora. Ricalcolarlo qui vorrebbe dire rimettere in
  // mezzo la deduzione che questo campo esiste per non usare più.
  if (r.landing_witnessed) {
    verdicts.push({
      id: r.id, text: r.text ?? "", projectId: r.project_id,
      branch: r.delivery_branch, commit: r.delivery_commit,
      status: r.landing_state === "landed" ? "merged" : "unmerged",
      fonte: "land", repoPath,
    });
    continue;
  }
  const status: BranchStatus | "no-repo" = repoPath
    ? await commitStatusFromRepo(repoPath, r.delivery_commit)
    : "no-repo";
  verdicts.push({
    id: r.id, text: r.text ?? "", projectId: r.project_id,
    branch: r.delivery_branch, commit: r.delivery_commit,
    status, fonte: "dedotto", repoPath,
  });
}

/**
 * Il METRO dei soldi: i turni di agente pagati su lavoro appena atterrato.
 *
 * L'impronta, misurata sui due casi visti a occhio l'11/08 (`4ec47331`,
 * `56677242`): la risposta dell'umano su una card in review vale come rifiuto e
 * RISVEGLIA l'agente (`review→in_progress`), poi arriva il land — e quel turno
 * gira per minuti su lavoro che è già su main. Si riconosce da tre cose
 * insieme: la card è stata rimessa in corso, un turno è partito entro 30
 * secondi da lì, e un «Mergiato su main» cade nello stesso minuto.
 *
 * NON entra nel codice d'uscita, di proposito: qui dentro c'è lo storico, che
 * non si può più non spendere. Serve a vedere se la DATA dell'ultimo caso
 * smette di avanzare — il cancello sta nel land (`cutLiveTurn` dopo
 * `settleLanded`), questo è solo il contatore che lo verifica.
 */
function turniPagatiDopoUnLand(): { turni: number; usd: number; ultimo: string | null } {
  try {
    const r = db.prepare(`
      WITH land AS (
        SELECT task_id, MAX(created_at) AS landed_at FROM task_comments
         WHERE kind = 'comment' AND content LIKE 'Mergiato su main%' GROUP BY task_id
      ),
      kick AS (
        SELECT task_id, created_at FROM task_comments
         WHERE kind = 'status' AND content LIKE '%review%in_progress%'
      ),
      sprechi AS (
        SELECT DISTINCT m.id, m.cost_cents, m.timestamp
          FROM land l
          JOIN tasks t  ON t.id = l.task_id
          JOIN topics tp ON tp.id = t.assigned_topic_id
          JOIN messages m ON m.session_key = tp.session_key AND m.role = 'assistant'
          JOIN kick k ON k.task_id = t.id
           AND (julianday(m.timestamp) - julianday(k.created_at)) * 86400 BETWEEN -1 AND 30
         WHERE (julianday(m.timestamp) - julianday(l.landed_at)) * 86400 BETWEEN -60 AND 300
           AND COALESCE(m.cost_cents, 0) > 0
      )
      SELECT COUNT(*) AS turni, COALESCE(SUM(cost_cents), 0) AS cents, MAX(timestamp) AS ultimo FROM sprechi
    `).get() as any;
    return { turni: r?.turni ?? 0, usd: (r?.cents ?? 0) / 100, ultimo: r?.ultimo ?? null };
  } catch {
    // Un host senza `messages` (o senza colonne di costo) non ha questo conto:
    // tacere è corretto, inventare uno zero no — lo dice chi stampa.
    return { turni: -1, usd: 0, ultimo: null };
  }
}

/**
 * Le card chiuse che sono ancora RECUPERABILI: il ramo di consegna esiste
 * tuttora nel repo e il suo contenuto non è dentro main. Sono quelle che un
 * click su «Landa su main» rimette a posto adesso — e per questo sono la misura
 * che deve dire zero, mentre il conto qui sopra include anche i rami già potati,
 * che nessun bottone può più salvare.
 *
 * Misurata la notte del 12/08 su `ee5ebbb4`: il land risolveva il worktree
 * ATTRAVERSO l'agente, quindi appena l'agente veniva rilasciato — a fine turno,
 * o fermandolo a mano — una consegna col ramo intatto diventava non-landabile e
 * la card restava in Done. Il cancello sta in `chooseMergeTarget`; questa è la
 * misura che dice se ne è rimasta fuori qualcuna.
 *
 * Due domande, in ordine di costo: quanti commit ha il ramo oltre main
 * (discendenza, una `rev-list`), e solo se ne ha, se il loro contenuto è
 * comunque di là (il land RICOPIA i commit, quindi la discendenza da sola
 * accuserebbe lavoro già atterrato).
 */
interface Alive {
  id: string; text: string; branch: string; ahead: number; repoPath: string;
  /**
   * Il terzo esito. La discendenza sa dire solo «dentro» o «fuori», e sono
   * pochi: misurato il 12/08 sui 6 rami vivi fuori da topics-app, questa lista
   * conteneva 2 rami già su main per contenuto, 2 rami che qualcun altro aveva
   * RIFATTO meglio tre giorni dopo, e 2 debiti veri. Presentati tutti e sei come
   * «landa prima che il GC lo poti», l'elenco è diventato uno che non si legge.
   */
  verdetto: LandingVerdict;
}

async function liveBranchesOutsideMain(): Promise<Alive[]> {
  const alive: Alive[] = [];
  // L'indice delle righe di main costa una `git grep` per REPO, non per ramo:
  // sei di queste card stanno nello stesso checkout.
  const indici = new Map<string, ReadonlySet<string>>();
  for (const v of verdicts) {
    if (!v.branch || !v.repoPath) continue;
    if (!(await branchExistsInRepo(v.repoPath, v.branch))) continue;
    const ahead = await countCommitsAhead(v.repoPath, v.branch);
    if (!ahead) continue; // 0 = già dentro per discendenza · null = non contabile
    const tip = await resolveCommit(v.repoPath, v.branch);
    if (!tip) continue;
    if ((await commitStatusFromRepo(v.repoPath, tip)) !== "unmerged") continue;
    let indiceMain = indici.get(v.repoPath);
    if (!indiceMain) {
      indiceMain = await indiceRigheMain(v.repoPath);
      indici.set(v.repoPath, indiceMain);
    }
    const verdetto = await classifyBranchLanding(v.repoPath, v.branch, { indiceMain });
    alive.push({ id: v.id, text: v.text, branch: v.branch, ahead, repoPath: v.repoPath, verdetto });
  }
  return alive;
}

const aliveOutside = await liveBranchesOutsideMain();
const perOutcome = (e: LandingEsito) => aliveOutside.filter((a) => a.verdetto.esito === e);
/** Il debito vero: nessuno ha quel contenuto e nessuno ha rifatto quei file. */
const debiti = perOutcome("fuori");
const superati = perOutcome("superato");
const dentroPerContenuto = perOutcome("dentro");
const indecisi = perOutcome("non-decidibile");
const outside = verdicts.filter((v) => v.status === "unmerged");
// Le card fuori da main che NON hanno più un ramo vivo: la loro riga è cronaca,
// non un'azione, e sta lontano dalle tre liste per non ingrossarle.
const viveIds = new Set(aliveOutside.map((a) => a.id));
const senzaRamo = outside.filter((v) => !viveIds.has(v.id));

/**
 * Anche qui la discendenza mente, e per lo stesso motivo: il land ricopia. Sulle
 * card senza più un ramo la sola domanda che resta è quella per contenuto, e
 * misurata il 12/08 assolveva due delle quattro card topics-app che il conto
 * storico dava per fuori. Restano nell'elenco solo quelle che il contenuto su
 * main non ce l'hanno davvero.
 */
async function ripassoStorico(): Promise<{ storico: Verdict[]; recuperate: Verdict[] }> {
  const storico: Verdict[] = [];
  const recuperate: Verdict[] = [];
  const indici = new Map<string, ReadonlySet<string>>();
  for (const v of senzaRamo) {
    if (!v.repoPath) { storico.push(v); continue; }
    let indiceMain = indici.get(v.repoPath);
    if (!indiceMain) {
      indiceMain = await indiceRigheMain(v.repoPath);
      indici.set(v.repoPath, indiceMain);
    }
    const esito = (await classifyCommitLanding(v.repoPath, v.commit, { indiceMain })).esito;
    (esito === "dentro" ? recuperate : storico).push(v);
  }
  return { storico, recuperate };
}
const { storico, recuperate } = await ripassoStorico();
const pruned = verdicts.filter((v) => v.status === "gone");
const unresolved = verdicts.filter((v) => v.status === "no-repo");
const landed = verdicts.filter((v) => v.status === "merged");

if (JSON_OUT) {
  console.log(JSON.stringify({
    checked: verdicts.length,
    landed: landed.length,
    outsideMain: outside.length,
    pruned: pruned.length,
    unresolvedProject: unresolved.length,
    liveBranchOutsideMain: aliveOutside.length,
    // La misura che deve dire zero non è più la lista intera: è il DEBITO, cioè
    // i rami vivi il cui contenuto non è su main e che nessuno ha rifatto.
    debito: debiti.length,
    superate: superati.length,
    dentroPerContenuto: dentroPerContenuto.length,
    nonDecidibili: indecisi.length,
    recoverable: aliveOutside.map((a) => ({
      id: a.id, branch: a.branch, ahead: a.ahead, text: a.text.slice(0, 80),
      esito: a.verdetto.esito,
      motivo: a.verdetto.motivo,
      righe: a.verdetto.righe,
      superatoDa: a.verdetto.superatoDa
        ? {
            commit: a.verdetto.superatoDa.sha,
            data: a.verdetto.superatoDa.data,
            subject: a.verdetto.superatoDa.subject,
          }
        : null,
    })),
    // Le card senza ramo che la DISCENDENZA dava per fuori e il CONTENUTO
    // ritrova su main, e quelle che restano fuori davvero.
    recuperatePerContenuto: recuperate.length,
    senzaRamoFuori: storico.length,
    witnessed: verdicts.filter((v) => v.fonte === "land").length,
    turniPagatiDopoUnLand: turniPagatiDopoUnLand(),
    cards: outside.map((v) => ({ id: v.id, commit: v.commit, branch: v.branch, fonte: v.fonte, text: v.text.slice(0, 80) })),
  }));
} else {
  const line = (v: Verdict) =>
    `    · ${v.id.slice(0, 8)} ${v.commit.slice(0, 8)}${v.branch ? ` (${v.branch})` : ""} ` +
    `[${v.fonte}] — ${v.text.slice(0, 60)}`;
  const witnessed = verdicts.filter((v) => v.fonte === "land").length;
  // Il conto per DISCENDENZA e quello per CONTENUTO, affiancati. Il primo da
  // solo era il numero che mentiva: il land ricopia i commit, quindi accusa di
  // «fuori» del lavoro che è dentro, e su 10 card ne accusava a torto 4.
  const insideReally = landed.length + recuperate.length + dentroPerContenuto.length;
  console.log(
    `card done con una consegna registrata: ${verdicts.length} · su main per discendenza: ${landed.length} · ` +
    `fuori: ${outside.length} · commit sparito: ${pruned.length} · progetto non risolto: ${unresolved.length}`,
  );
  console.log(
    `  ripassate per CONTENUTO: su main ${insideReally} ` +
    `(${recuperate.length + dentroPerContenuto.length} che la discendenza dava per fuori) · ` +
    `superate ${superati.length} · DEBITO ${debiti.length} · ` +
    `senza ramo, non più landabili ${storico.length}`,
  );
  // La riga che dice quanto ci si può fidare del numero qui sopra. Le card
  // vecchie non hanno una testimonianza e non l'avranno mai: il loro verdetto
  // è dedotto, e la deduzione sbaglia in modo noto (una card successiva che
  // riscrive gli stessi file la fa leggere come «fuori»).
  console.log(
    `  esito registrato dal land: ${witnessed}/${verdicts.length} · ` +
    `dedotto qui dal solo commit: ${verdicts.length - witnessed}`,
  );
  // Le tre liste. La discendenza da sola diceva «fuori» di tutte, e un elenco
  // dove il debito sta in mezzo ai fossili è un elenco che si smette di leggere.
  const capo = (a: Alive) => `    · ${a.id.slice(0, 8)} ${a.branch} (+${a.ahead}) — ${a.text.slice(0, 56)}`;
  console.log(
    `  card done col RAMO ancora vivo e fuori da main per discendenza: ${aliveOutside.length}` +
    ` → dentro ${dentroPerContenuto.length} · superate ${superati.length} · ` +
    `DEBITO ${debiti.length}${debiti.length === 0 ? "  ✓" : ""} · non decidibili ${indecisi.length}`,
  );

  if (debiti.length > 0) {
    console.log(`\n  DEBITO (${debiti.length}) — il contenuto non è su main e nessuno ha rifatto quei file:`);
    for (const a of debiti) {
      console.log(capo(a));
      console.log(`        ${a.verdetto.motivo}`);
      console.log(`        prova: git -C '${a.repoPath}' diff main...${a.branch} --stat`);
    }
    console.log("\n  azione: landa il ramo (bottone «Landa su main» sulla card) prima che il GC lo poti, oppure cherry-picka il commit a mano");
  }

  if (superati.length > 0) {
    // Col commit e la data, sempre. Senza, «superato» è un'opinione, e a
    // un'opinione che assolve del lavoro perso non ci si può appoggiare.
    console.log(`\n  SUPERATE (${superati.length}) — su main quei file li ha rifatti qualcun altro, dopo:`);
    for (const a of superati) {
      const s = a.verdetto.superatoDa!;
      console.log(capo(a));
      console.log(`        superato da ${s.sha.slice(0, 8)} del ${s.data.slice(0, 10)}: ${s.subject.slice(0, 64)}`);
      console.log(`        ${a.verdetto.motivo}`);
      console.log(`        prova: git -C '${a.repoPath}' log main --oneline ${s.sha}~1..main -- ${a.verdetto.file.slice(0, 3).join(" ")}`);
    }
  }

  if (dentroPerContenuto.length > 0) {
    console.log(`\n  DENTRO (${dentroPerContenuto.length}) — il contenuto è su main, la discendenza mente (il land ricopia):`);
    for (const a of dentroPerContenuto) console.log(`${capo(a)}\n        ${a.verdetto.motivo}`);
  }

  if (indecisi.length > 0) {
    // Stanno in fondo e sono loro soli. Un forse messo fra le certezze le
    // annacqua tutte, ed è il difetto per cui questa lista era diventata muta.
    console.log(`\n  NON DECIDIBILI (${indecisi.length}) — guardare a mano, non sono contate fra i debiti:`);
    for (const a of indecisi) console.log(`${capo(a)}\n        ${a.verdetto.motivo}`);
  }

  const spreco = turniPagatiDopoUnLand();
  if (spreco.turni < 0) {
    console.log("  turni pagati dopo un land: non misurabile su questo database (niente costi sui messaggi)");
  } else {
    console.log(
      `  turni di agente pagati su lavoro già atterrato: ${spreco.turni} · ` +
      `$${spreco.usd.toFixed(2)} · ultimo: ${spreco.ultimo?.slice(0, 16) ?? "mai"}` +
      "  (storico, non entra nel codice d'uscita: conta che la data smetta di avanzare)",
    );
  }
  if (storico.length > 0) {
    // Le card fuori da main il cui RAMO non c'è più: nessun bottone le rimette
    // a posto, quindi non sono un'azione. Restano perché la loro data che smette
    // di avanzare è la prova che il cancello del land ha smesso di perdere.
    console.log(`\n  storico (${storico.length}) — il contenuto su main non c'è, e il ramo nemmeno: niente da landare:`);
    // Raggruppate per checkout: la prova si incolla in un terminale per NON
    // crederci, e una prova che nomina il repo di un'ALTRA card non si incolla.
    const byRepo = new Map<string, Verdict[]>();
    for (const v of storico) byRepo.set(v.repoPath ?? "?", [...(byRepo.get(v.repoPath ?? "?") ?? []), v]);
    for (const [repo, group] of byRepo) {
      console.log(`\n  ${repo} — ${group.length}:`);
      for (const v of group) console.log(line(v));
      const first = group[0]!;
      console.log(
        `    prova: git -C '${repo}' merge-base --is-ancestor ${first.commit} main; ` +
        `git -C '${repo}' log main -F --grep="$(git -C '${repo}' log -1 --format=%s ${first.commit})"`,
      );
    }
  }
  if (pruned.length > 0) {
    // Non è un'assoluzione: il commit poteva essere stato potato PRIMA di
    // atterrare. È «non lo so», e va detto — `--strict` lo tratta da guasto.
    console.log(`\n  ${pruned.length} card hanno un commit che il repo non ha più (potato, o progetto spostato): non verificabili`);
    for (const v of pruned) console.log(line(v));
  }
  if (unresolved.length > 0) {
    const ids = [...new Set(unresolved.map((v) => v.projectId))];
    console.log(`\n  ${unresolved.length} card su ${ids.length} board di cui non si trova il checkout (${ids.slice(0, 5).join(", ")}): non guardate`);
  }
}

/**
 * Fallisce sul DEBITO, non sulla lista. Prima bastava un ramo fuori da main per
 * uscire rosso, e siccome nove volte su undici quel ramo era lavoro già dentro o
 * un fossile, il rosso non voleva più dire niente. Quello che il codice d'uscita
 * deve difendere è una cosa sola: che non ci sia lavoro consegnato che nessuno ha
 * e che il GC può potare.
 *
 * `--strict` tiene la barra vecchia: fallisce anche sullo storico non più
 * landabile e sui commit spariti dal repo, che sono «non lo so», non assoluzioni.
 */
process.exit(debiti.length > 0 || (STRICT && (storico.length > 0 || pruned.length > 0)) ? 1 : 0);
