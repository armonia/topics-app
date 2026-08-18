/**
 * IL BACKFILL DELLA CONSEGNA: la passata che riempie i buchi lasciati dagli
 * altri percorsi.
 *
 * Una card arriva in review da PIU' porte, e solo due scattano la fotografia
 * della consegna (la rotta sull'edge verso review, e `onTurnEnd` nel
 * dispatcher). Le altre — `askParkedChildren` chiamata da un cambio di stato dei
 * figli, che scrive `status='review'` con una UPDATE grezza — non passano di li'
 * e lasciano la card senza ramo, senza commit o senza numeri.
 *
 * Aggiungere una terza e una quarta copia di `captureDelivery` e' esattamente
 * il difetto gia' pagato una volta (vedi `task-delivery-capture.ts`: «ne
 * esistevano TRE copie, e la terza mancava proprio dove serviva di piu'»).
 * Questa passata ripara per tutti, e non ha bisogno di sapere da quale porta la
 * card sia entrata.
 *
 * ── Due scritture distinte, e la distinzione e' il punto ────────────────────
 * · consegna NUOVA (commit mai registrato) ⇒ `recordDelivery`, che azzera anche
 *   `landing_state` / `landing_witnessed`. E' giusto: un verdetto su un'altra
 *   consegna non vale piu'.
 * · consegna GIA' REGISTRATA a cui mancano solo i NUMERI ⇒ `setDeliveryStat`,
 *   che scrive solo quelli. Passare da `recordDelivery` qui butterebbe via il
 *   verdetto testimoniato a ogni giro di trenta minuti, su 294 card.
 *
 * Estratto da `server.ts` il 18/08, quando il cancello di dimensione ha
 * protestato: era un pezzo autonomo con dipendenze nette, non un frammento del
 * bootstrap.
 */
import type { Database } from "bun:sqlite";
import type { ProjectCandidate } from "./project-path-resolver";
import type { ProjectStore } from "./project-store";

/** Solo cio' che serve: la passata non deve poter fare altro. */
export interface BackfillDeps<D = unknown> {
  db: Pick<Database, "prepare">;
  projectStore: ProjectStore;
  svc: {
    recordDelivery(a: { taskId: string; branch: string | null; commit: string | null;
      stat: { filesChanged: number; insertions: number; deletions: number } | null }): void;
    setDeliveryStat(a: { taskId: string; filesChanged: number; insertions: number; deletions: number }): boolean;
  };
  workspaceDir: string;
  /** Lazy come nel chiamante: l'elenco si legge al momento della passata. */
  extraPaths: () => string[];
  buildProjectCandidates(a: { projectStore: ProjectStore; workspaceDir: string; extraPaths?: () => string[] }): ProjectCandidate[];
  deliveryBranchDeps(candidati: ProjectCandidate[]): D;
  resolveDeliveryBranch(deps: D, taskId: string): Promise<{ repoPath: string; branch: string } | null>;
  deliveryPointer(repoPath: string, branch: string): Promise<{ branch: string; commit: string | null } | null>;
  worktreeDiffStat(cwd: string, opts: { branch?: string }): Promise<{ filesChanged: number; insertions: number; deletions: number } | null>;
}

export async function backfillDeliveries<D>(deps: BackfillDeps<D>): Promise<void> {
  // ANCHE CHI IL COMMIT CE L'HA MA NON HA I NUMERI. La condizione guardava solo
  // `delivery_commit IS NULL`, e i numeri non li scriveva comunque nessuno qui:
  // `recordDelivery` senza `stat` mette NULL per contratto. Risultato misurato il
  // 18/08 su topics-app: 294 card in review/done con un ramo, un commit e nessun
  // numero — la colonna chiedeva «Approva» senza dire cosa si approva. Su
  // `7588f2c1` il ramo portava 3 file +190 −12, su `348559d3` 3 file +39 −137, e
  // la card non lo diceva.
  //
  // Il buco sta nei percorsi che portano una card in review SENZA passare da
  // fine turno: `askParkedChildren` chiamata da un cambio di stato dei figli
  // scrive `status='review'` con una UPDATE grezza, e `captureDelivery` — che
  // vive nel dispatcher e nella rotta — non passa di li'. E' la QUARTA copia
  // mancante dello stesso gesto (vedi `task-delivery-capture.ts`): invece di
  // aggiungerne una quinta, la passata periodica la ripara per tutti.
  const rows = deps.db.prepare(
    `SELECT id, delivery_commit FROM tasks
      WHERE archived = 0 AND status IN ('review', 'done')
        AND (delivery_commit IS NULL OR delivery_files_changed IS NULL)`,
  ).all() as Array<{ id: string; delivery_commit: string | null }>;
  // I candidati di progetto una volta sola: costruirli scandisce la cartella di
  // lavoro, e qui si cicla su tutte le card senza consegna.
  const candidati = deps.buildProjectCandidates({
    projectStore: deps.projectStore,
    workspaceDir: deps.workspaceDir,
    extraPaths: deps.extraPaths,
  });
  const branchDeps = deps.deliveryBranchDeps(candidati);
  for (const row of rows) {
    // Il worktree se è vivo, altrimenti il ramo che la card si è tenuta. Senza
    // questo ripiego una card che ha perso la cartella non poteva più essere
    // fotografata da nessuno, e `delivery_commit` restava NULL per sempre: sono
    // le 23 card misurate il 18/08 su topics-app, 13 delle quali ferme su
    // un'accusa che l'audit non poteva più togliere.
    const ref = await deps.resolveDeliveryBranch(branchDeps, row.id).catch(() => null);
    if (!ref) continue;
    // Stessa domanda della cattura in review: il commit PROPRIO più recente, non
    // la punta del ramo — altrimenti questo giro riscriverebbe ogni 30 minuti il
    // lavoro di un'altra sessione sopra le card senza consegna.
    // Awaited: the audit right below must see what we just recorded, otherwise
    // a backfilled task waits a full interval for its first verdict.
    const ptr = await deps.deliveryPointer(ref.repoPath, ref.branch).catch(() => null);
    // Niente commit propri (o domanda senza risposta): non si scrive niente e si
    // riprova al giro dopo — se intanto l'altro branch landa o sparisce, la
    // stessa domanda cambia risposta da sola. In particolare NON si ripiega
    // sulla punta: vedi `taskDeliveryRef`, dove c'è la misura del perché.
    // I NUMERI, anche quando il commit c'è già. Due strade distinte apposta:
    // se la consegna è NUOVA (commit mai registrato) la scrive `recordDelivery`,
    // che azzera anche il verdetto — ed è giusto, un verdetto su un'altra
    // consegna non vale. Se invece manca solo la MISURA su una consegna che non
    // è cambiata, si scrive solo quella: passare da `recordDelivery` butterebbe
    // via il verdetto testimoniato a ogni giro.
    const commitNuovo = !row.delivery_commit;
    if (!ptr?.commit) continue;
    // QUANTO lavoro c'è dentro, con lo stesso misuratore del worktree vivo: si
    // conta dal PADRE del commit proprio più vecchio, non dalla punta, così una
    // card non si prende il lavoro di un'altra sessione. `null` = non misurabile
    // (git in errore, ramo sparito a metà), e allora `stat: null` lascia la
    // colonna vuota: un silenzio onesto, mai uno zero che direbbe «non ha
    // prodotto niente». I ref sono condivisi fra i worktree, quindi il checkout
    // principale basta a misurare il ramo.
    const stat = await deps.worktreeDiffStat(ref.repoPath, { branch: ptr.branch }).catch(() => null);
    if (commitNuovo) {
      deps.svc.recordDelivery({
        taskId: row.id, branch: ptr.branch, commit: ptr.commit,
        stat: stat ? { filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions } : null,
      });
    } else if (stat) {
      deps.svc.setDeliveryStat({
        taskId: row.id,
        filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions,
      });
    }
  }
}
