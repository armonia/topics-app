/**
 * L'AUDIT DELL'ATTERRAGGIO: «done» deve voler dire «e' nel prodotto».
 *
 * La GC dei worktree decide cosa e' sicuro DISTRUGGERE; questo decide cosa e'
 * davvero ARRIVATO. Sono due domande diverse, e la perdita del 19/07 viveva
 * nello spazio fra loro: il task diceva done, il branch non c'era piu', il
 * codice non era da nessuna parte.
 *
 * Estratto da `server.ts` il 18/08, quando il cancello di dimensione ha
 * protestato per la seconda volta in un giorno (4.731 righe, tetto 4.717). Come
 * per `delivery-backfill.ts`, era un pezzo autonomo dentro il bootstrap: quasi
 * tutto cio' che usa sono import che questo file prende da se', e restano
 * iniettati solo i CINQUE riferimenti che vivono davvero in `server.ts`.
 *
 * `announce` e' l'unica differenza legittima fra la passata periodica e il
 * timbro su UNA card: la passata deve DIRE sulla card che una consegna non e'
 * su main (una riga, datata, e dal 18/08 con `kind: 'service'` perche' lo stesso
 * fatto ha gia' un chip); il timbro post-land no — li' il thread ha appena
 * scritto perche' il land non e' riuscito, e ripeterlo sarebbe il commento
 * numero due sullo stesso fatto.
 */
import { auditLandings, classifyLandingEsito, type AuditTask, type LandingState } from "./landing-audit";
import { branchExistsInRepo, commitStatusFromRepo } from "./branch-status";
import { classifyBranchLanding, classifyCommitLanding, indiceRigheMain } from "./landing-verdict";
import { landedMergeRange } from "./task-diff-range";
import { buildProjectCandidates, resolveProjectPath } from "./project-path-resolver";
import type { ProjectStore } from "./project-store";

/** I cinque riferimenti che vivono in `server.ts` e non altrove. */
export interface AuditWiring {
  projectStore: ProjectStore;
  workspaceDir: string;
  extraPaths: () => string[];
  svc: {
    addComment(a: { taskId: string; author: string; kind?: "service"; content: string }): unknown;
    get(id: string): { task: AuditTask & { landingState: LandingState | null } } | null | undefined;
    recordLandingState(a: { taskId: string; state: LandingState; checkedAt: string }): unknown;
    listLandingAuditCandidates(): AuditTask[];
  };
  broadcast(msg: unknown): void;
  /** La passata di backfill, che gira PRIMA dell'audit. */
  backfill(): Promise<void>;
}

/**
 * Le dipendenze dell'audit, meno la lista di chi guardare — così la passata
 * periodica e il timbro su UNA card fanno lo stesso conto. Se divergessero, il
 * verdetto istantaneo dopo un land e quello del giro dopo potrebbero
 * contraddirsi, e il semaforo tornerebbe a non voler dire niente.
 *
 * `announce` è l'unica differenza legittima: la passata deve DIRE sulla card
 * che una consegna non è su main (una riga, datata); il timbro post-land no —
 * lì il thread ha appena scritto perché il land non è riuscito, e ripeterlo
 * sarebbe il commento numero due sullo stesso fatto.
 */
function landingAuditDeps(deps: AuditWiring, listCandidates: () => AuditTask[], announce: boolean) {
  // `tasks.project_id` is the BOARD id — `projectIdForPath(path)`, a one-way
  // hash — not a ProjectStore UUID. Asking the store for it returns undefined
  // for every real board, and the audit reads a missing repo as "can't tell":
  // wired that way the counter sat on `unverifiable` forever and could never
  // catch the failure it exists for. Invert the hash the way the dispatcher
  // does (resolveProject), building the candidate list ONCE per sweep — it
  // scans the workspace dir, and re-scanning it per task buys nothing.
  const candidates = buildProjectCandidates({
    projectStore: deps.projectStore,
    workspaceDir: deps.workspaceDir,
    extraPaths: deps.extraPaths,
  });
  // L'indice delle righe di main costa una `git grep` dell'intero albero, e la
  // paga UNA volta per repo per passata: le card di una board stanno tutte nello
  // stesso checkout, e senza cache l'avrebbero pagata una a testa.
  const indici = new Map<string, ReadonlySet<string>>();
  const indiceDi = async (repoPath: string): Promise<ReadonlySet<string>> => {
    const gia = indici.get(repoPath);
    if (gia) return gia;
    const nuovo = await indiceRigheMain(repoPath);
    indici.set(repoPath, nuovo);
    return nuovo;
  };
  return {
    listCandidates,
    repoPath: (projectId: string) => resolveProjectPath(projectId, candidates)?.path ?? null,
    commitStatus: (repoPath: string, commit: string) => commitStatusFromRepo(repoPath, commit),
    // La seconda domanda, solo su chi la prima ha già dato per fuori: è lo
    // STESSO conto di `report:landed`, che è il modo in cui la misura a mano e la
    // pastiglia sulla card non possono più dire due cose diverse.
    debtVerdict: async (task: AuditTask, repoPath: string): Promise<LandingState> => {
      const indiceMain = await indiceDi(repoPath);
      // Col ramo ancora vivo si può chiedere tutto (patch inversa, conflitto,
      // supersessione); potato il ramo resta la sola domanda sul contenuto.
      const verdetto = task.deliveryBranch && (await branchExistsInRepo(repoPath, task.deliveryBranch))
        ? await classifyBranchLanding(repoPath, task.deliveryBranch, { indiceMain })
        : await classifyCommitLanding(repoPath, task.deliveryCommit ?? "", { indiceMain });
      return classifyLandingEsito(verdetto.esito);
    },
    // LA TERZA MANIGLIA, e l'unica che risponde quando le altre due sono
    // sparite: il merge che il land scrive su main porta il nome della card
    // (`merge task <id>: …`) e non lo pota nessuno. La domanda e la sua
    // prudenza stanno gia' in `landedMergeRange`, che il pannello «Modifiche»
    // usa per la stessa identificazione: `--merges` perche' il land e' `--no-ff`
    // e senza quel filtro un commit qualunque che citi l'id passerebbe per un
    // atterraggio, e `-F` perche' il titolo della card e' prosa.
    //
    // `null` = nessun merge trovato, che non e' una smentita.
    landedMerge: async (task: AuditTask, repoPath: string): Promise<boolean | null> => {
      const trovato = await landedMergeRange(repoPath, task.id).catch(() => null);
      return trovato ? true : null;
    },
    // IL VERDETTO DEVE ARRIVARE ALLO SCHERMO, non solo alla colonna del database.
    //
    // `landingState` e' l'unica cosa che questa riga cambia, ed e' cio' che
    // disegna la pastiglia «non e' su main» sulla card, la banda in cima al
    // drawer e il contatore del debito in testa alla board. La passata gira da
    // un timer, quindi nessuna rotta trasmette il suo esito: senza il frame,
    // una card che ATTERRA resta accusata su ogni schermo aperto finche'
    // qualcuno non ricarica, e il rimedio a un guasto sembra il guasto.
    //
    // SOLO SUL CAMBIO. `record` timbra ogni candidata a ogni giro, anche le
    // duecento che ripetono da settimane la stessa risposta, e ogni
    // `task:updated` fa ri-scaricare l'intera board a ogni client: senza il
    // confronto, la cura per una board ferma sarebbe una board che si ricarica
    // duecento volte ogni mezz'ora. Solo `landingCheckedAt` cambia in quel caso,
    // e non lo guarda nessuna superficie.
    record: (taskId: string, state: LandingState, checkedAt: string) => {
      const prima = deps.svc.get(taskId)?.task.landingState ?? null;
      deps.svc.recordLandingState({ taskId, state, checkedAt });
      if (prima === state) return;
      const fresh = deps.svc.get(taskId)?.task;
      if (fresh) deps.broadcast({ type: "task:updated", projectId: fresh.projectId, task: fresh });
    },
    previousState: (taskId: string) => deps.svc.get(taskId)?.task.landingState ?? null,
    // The whole point: a delivery that never reached main must SAY so, on the
    // task, once — not sit silently in a column for 8 days.
    onNewlyUnlanded: announce
      ? (task: AuditTask) => {
          try {
            deps.svc.addComment({
              taskId: task.id, author: "system",
              // SERVICE, e la ragione la dichiara la riga qui sotto: lo STATO ha
              // già una banda in cima al drawer e un badge sulla card
              // (`landingState`), e questo commento serve solo a DATARE il
              // momento in cui è successo. Una riga che non aggiunge un fatto è
              // per definizione servizio, e questa era la peggiore della board:
              // una card in review ha per definizione lavoro fuori da main,
              // quindi la nota scatta su OGNI card della colonna, sempre DOPO la
              // consegna, e mentre l'umano dorme resta l'ultima riga del thread.
              // Misurata il 18/08: era la parola stampata su 3 card su 4, al
              // posto del riassunto dell'agente — e diceva «landa il ramo» a chi
              // in review il bottone «Landa» non ce l'ha nemmeno.
              kind: "service",
              content: `Non è su main: \`${task.deliveryCommit?.slice(0, 8)}\`${task.deliveryBranch ? ` (${task.deliveryBranch})` : ""}. Landa il ramo prima che venga potato.`,
            });
            const fresh = deps.svc.get(task.id)?.task;
            if (fresh) deps.broadcast({ type: "task:updated", projectId: task.projectId, task: fresh });
          } catch (err) { console.warn("[landing-audit] comment failed", err); }
        }
      : undefined,
    now: () => new Date().toISOString(),
    log: (msg: string) => console.log(msg),
  };
}

export async function runLandingAudit(deps: AuditWiring) {
  await deps.backfill().catch((err) => console.warn("[landing-audit] backfill failed", err));
  return auditLandings(
    landingAuditDeps(deps, () => deps.svc.listLandingAuditCandidates(), /*announce*/ true),
  ).catch((err) => { console.error("[landing-audit] sweep failed", err); return null; });
}

/**
 * Il verdetto DEDOTTO per UNA card, subito. Lo chiama il land (`stampLanding`)
 * quando l'esito non l'ha visto lui — nessun ramo da guardare, o «non c'era
 * niente da portare». Dove invece l'ha visto scrive il fatto e non passa di
 * qui: una deduzione sopra una testimonianza è un declassamento.
 */
export async function auditOneLanding(deps: AuditWiring, taskId: string): Promise<void> {
  const t = deps.svc.get(taskId)?.task;
  if (!t) return;
  // Senza consegna registrata non c'e' niente da verificare, e si tace. Con
  // un'accusa gia' scritta invece si prosegue, perche' c'e' qualcosa da
  // RITIRARE: `markLandPending` timbra «non e' su main» appena il land viene
  // chiesto, e questa e' la sua via d'uscita. `auditLandings` sa gia' che senza
  // commit l'unica risposta possibile e' «non lo so», piu' il merge del land.
  if (!t.deliveryCommit && t.landingState !== "unlanded") return;
  const one: AuditTask = {
    id: t.id, projectId: t.projectId,
    deliveryBranch: t.deliveryBranch ?? null, deliveryCommit: t.deliveryCommit,
  };
  await auditLandings(landingAuditDeps(deps, () => [one], /*announce*/ false))
    .catch((err) => { console.warn("[landing-audit] verdetto singolo fallito", err); return null; });
}
