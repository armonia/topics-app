/**
 * board.ts — client API + types for the Kanban board (human surface).
 *
 * Talks to the project-scoped `/api/boards/:projectId/...` endpoints
 * (server/routes/tasks.ts, actor="human"). Porta il proprio fetch wrapper, così
 * non si accoppia al resto di lib/api.ts; il contratto e l'identità della board
 * arrivano invece da `shared/board.ts`. The AGENT surface (`/api/sessions/...`)
 * is driven by MCP, not from here.
 */

// Il contratto della board sta in `shared/board.ts`, dichiarato UNA volta e
// letto dai due lati del filo: `export … from` ri-esporta ma non porta i nomi
// in scope locale, e qui sotto servono, quindi l'import gemello non è ridondante.
export { MAX_FANOUT, TASK_STATUSES, ACTIVE_DISPATCH_STATES, PARKED_STOPPED, PARKED_WAITED_OUT, isAgentWorking, isThreadSpeech, parseStatusEvent, hasPlanApproveOption, parseQuestionBlock, showsLandingDebt, showsDeployProposal } from '../../../shared/board';
// Il tetto globale di concorrenza: estremi, arrotondamento e formula del numero
// EFFETTIVO. Stessa cartella condivisa e stesso motivo del resto: il dispatcher
// applica questo calcolo, il pannello impostazioni della board lo scrive sotto
// gli occhi di una persona, e due copie inizierebbero a dire numeri diversi.
export { GLOBAL_CAP_MIN, GLOBAL_CAP_MAX, GLOBAL_CAP_OFF, clampGlobalCap, effectiveDispatchCap } from '../../../shared/board';
export type { GlobalDispatchCap } from '../../../shared/board';
// The comparison the SERVER matches a picked option with, and the one reserved
// label the client has to recognise by name. The board de-duplicates an agent's
// quick reply against the button beside it, and once the buttons became
// translatable it could no longer do that by comparing its own label (see
// `Board/taskChoices.ts`). The other three reserved labels stay server-side:
// they are matched, never drawn.
export { normalizeActionLabel, LAND_ACTION_LABEL } from '../../../shared/board';
export type {
  TaskStatus, TaskComment, CardComment, ReviewCheck, CheckRun, BoardSettings, BoardSettingsPatch, DispatchCapacity, BlockerRef,
  LandingTicket,
  SubtaskWork, QueueReason, QueueTone,
} from '../../../shared/board';
// Le etichette: stessa cartella condivisa, stesso vocabolario chiuso. Il client
// non ne tiene una copia — un'etichetta in più qui e non lì è un filtro che non
// filtra niente, sullo stesso modello di `BoardSettings`.
export { CLOSER_LABELS, KIND_LABELS, whoCloses } from '../../../shared/task-labels';
export type { TaskLabel, TaskLabelRow } from '../../../shared/task-labels';
import type { TaskLabel, TaskLabelRow } from '../../../shared/task-labels';
import type {
  TaskStatus, TaskComment, CardComment, CheckRun, BoardSettings, BoardSettingsPatch, DispatchCapacity, BlockerRef, LandingTicket, SubtaskWork,
  QueueReason,
} from '../../../shared/board';
// Who spoke on a comment. The stored `author` is an identity, so the label a
// person reads is derived from it, on the same rule the server uses. Keeping a
// second rule in the client is how the card and the thread would start
// disagreeing about who said something.
export { commentAuthorLabel } from '../../../shared/comment-author';
// Il tentativo di un fan-out: stesso contratto del server, stessa cartella condivisa.
// Passa solo `attemptHasWork`, che è un predicato e non ha lingua. Il diffstat
// (`formatAttemptStat`) NON passa più di qui: la UI lo vuole tradotto, e la sua
// versione con dizionario vive in `components/Board/format.ts` (`attemptStat`).
// Quella in `shared/` resta al server, che con essa scrive il confronto nel
// thread del task.
export { attemptHasWork } from '../../../shared/task-attempt';
// Solo `TaskAttempt` passa di qui (la board lo importa da questo modulo).
// `AttemptState` si prende da `shared/task-attempt`, dov'è dichiarato ed è già
// da lì che lo importa chi lo usa (il servizio lato server).
export type { TaskAttempt } from '../../../shared/task-attempt';
import type { TaskAttempt } from '../../../shared/task-attempt';

/**
 * Reserved board id for tasks created WITHOUT a project (work spanning several
 * projects, or not decided yet). They live on the global board; the dispatcher
 * ignores them until a human assigns a real project via "Sposta su…".
 */
export const UNASSIGNED_PROJECT_ID = '_none';

/**
 * Virtual board id for "project: Auto" — the server resolves the real board
 * from a known project name mentioned in the task text (unique hit), falling
 * back to UNASSIGNED_PROJECT_ID when none/ambiguous.
 */
export const AUTO_PROJECT_ID = '_auto';

/**
 * A project-less "Auto" task is routed server-side to a scaffolded catch-all
 * board (workspace/generale → id "generale-<hash>") so it can actually DISPATCH
 * — the dispatcher only ticks real boards. But on the UI that "generale" name is
 * noise (the user wants no such label), so the board treats a catch-all task
 * exactly like UNASSIGNED_PROJECT_ID: no project chip. Mirrors the server's
 * join(workspaceDir, "generale"); a real top-level project literally named
 * "generale" is reserved for the catch-all by convention.
 */
export const isCatchAllProjectId = (projectId: string): boolean =>
  /^generale-[a-z0-9]+$/.test(projectId);

/** No user-facing project: unassigned OR the catch-all — both render with no chip. */
export const isProjectlessId = (projectId: string): boolean =>
  projectId === UNASSIGNED_PROJECT_ID || isCatchAllProjectId(projectId);

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

/**
 * La misura a cui va reso il glifo di stato (`StatusIcon`), in pixel.
 *
 * Vive QUI — nel modulo puro che sia il glifo sia l'aritmetica della riga
 * «Board» in sidebar importano già — e non accanto al disegno, perché serve a
 * due parti che non si vedono fra loro: chi disegna (`viewBox="0 0 16 16"`) e
 * chi deve riservargli spazio (`countWidth` in `boardProjectChips`). Erano due
 * numeri scritti a mano in due file, e sono già stati d'accordo per sbaglio una
 * volta di troppo: quando il glifo è passato da 12 a 14 l'aritmetica è rimasta
 * indietro, e la riga ha sbordato finché qualcuno non l'ha misurata.
 *
 * 14 è anche `ROW_GLYPH` (lib/selectionStyles), cioè la misura di OGNI glifo di
 * riga dell'app: «tutte le icone dovrebbero avere formato standard». I due
 * numeri non sono importati l'uno dall'altro di proposito — vivono in due
 * sistemi (il disegno di un glifo, la griglia della sidebar) che possono
 * legittimamente separarsi — ma finché coincidono è perché devono.
 */
export const STATUS_GLYPH_PX = 14;

/**
 * Perché il sistema ha portato in review un task che l'agente non ha consegnato.
 * Cause diverse = decisioni diverse per il reviewer — perciò testi diversi e non
 * un generico "chiuso dal sistema".
 */
export const SYSTEM_DELIVERY_REASON: Record<'retries_exhausted' | 'model_refused' | 'fanout' | 'parked_children', string> = {
  retries_exhausted:
    "L'agent ha finito i tentativi senza mettere in review da solo: sotto può non esserci un deliverable. Rimandandolo indietro riparte sulla stessa sessione.",
  model_refused:
    "Il modello si è rifiutato di proseguire: nessun ritentativo automatico può sbloccarlo. Serve una decisione tua: rimandarlo indietro identico otterrebbe lo stesso rifiuto.",
  fanout:
    "Fan-out: più agenti hanno lavorato lo stesso task in parallelo, ognuno nel suo worktree. Scegli quale tentativo tenere dal pannello Tentativi. Gli altri vengono buttati.",
  parked_children:
    "Non è un blocco, è una domanda: gli unici sottotask aperti sono parcheggiati in backlog, dove nessun dispatcher li prende. Rispondi coi due bottoni e il task riparte da solo.",
};

/** Il testo giusto per una consegna di sistema, causa nota o meno. */
export function systemDeliveryNote(reason: BoardTask['deliveredReason']): string {
  return reason
    ? SYSTEM_DELIVERY_REASON[reason]
    : "Non l'ha consegnato l'agent: ce l'ha portato il sistema a fine turno. Sotto può non esserci un deliverable. Guarda il thread prima di aprire il diff.";
}

/** Etichetta corta per la chip sulla card (la prosa lunga è nel title). */
/**
 * `retries_exhausted` dice «turni finiti», NON «non consegnato».
 *
 * Questo chip si monta solo quando `senzaConsegna` e' falso — cioe' quando il
 * lavoro C'E' per costruzione: il caso davvero vuoto ha gia' il suo chip
 * (`reviewEvidence().kind === 'empty'`) che sopprime questo. Con la vecchia
 * parola, misurato il 18/08 su `0a17739e`, la riga chip diceva contemporaneamente
 * «non consegnato», «9 file +759 −21» e «checks verdi» — tre affermazioni, due
 * delle quali smentivano la prima, a quattro pixel di distanza. I 9 file sono
 * veri: `git diff --shortstat main...topics/tame-crane` li conferma.
 *
 * Il tooltip diceva gia' la cosa giusta («ce l'ha portato il sistema a fine
 * turno»), ma su una card si legge l'ETICHETTA, e su touch il tooltip non
 * esiste. Il segnale che vale — «nessun agente ha dichiarato di aver finito» —
 * resta intero: cambia la parola, non il chip.
 */
const SYSTEM_DELIVERY_CHIP: Record<'retries_exhausted' | 'model_refused' | 'fanout' | 'parked_children', string> = {
  retries_exhausted: 'turni finiti',
  model_refused: 'agent bloccato',
  fanout: 'scegli il tentativo',
  parked_children: 'sottotask parcheggiati',
};

/**
 * «Questo non l'ha consegnato l'agent»: cosa scriverci sulla card, o `null` se
 * la consegna è vera.
 *
 * Funzione pura come `blockedByChip` e `reopenedChip`, e per lo stesso motivo:
 * il chip esisteva dal 29/07 ma viveva dentro il JSX della card, dove un test
 * unitario non lo raggiunge e il drawer non lo riusa.
 *
 * Vale solo in `review`, dove la domanda è «cosa guardo?». Su una card chiusa
 * sarebbe archeologia, e il drawer conserva comunque il fatto per esteso.
 */
export function systemDeliveryChip(
  task: Pick<BoardTask, 'status' | 'deliveredBy' | 'deliveredReason'>,
): { label: string; title: string } | null {
  if (task.status !== 'review' || task.deliveredBy !== 'system') return null;
  return {
    // Causa non registrata: si dice il fatto certo — l'ha portata il sistema —
    // senza affermare che sotto non ci sia niente, che qui non lo sappiamo.
    label: task.deliveredReason ? SYSTEM_DELIVERY_CHIP[task.deliveredReason] : 'portata dal sistema',
    title: systemDeliveryNote(task.deliveredReason),
  };
}

/**
 * DUE CHIP PER LO STESSO FATTO SONO UNO SOLO, e questa e' la regola che sceglie.
 *
 * `systemDeliveryChip` esiste dal 29/07 e dice «non l'ha consegnato l'agent».
 * `reviewEvidence(...).kind === 'empty'` e' arrivato il 17/08 e dice «l'agent
 * non ha prodotto niente». Il secondo insieme e' contenuto nel primo per
 * costruzione — `empty` pretende `delivered_by = 'system'` in review, che e'
 * esattamente la condizione del primo — quindi ogni card `empty` ne portava
 * DUE, stesso ambra e stessa icona: sulla card `5cf58e29` si leggeva «non
 * consegnato» e «Niente consegnato» a 268px di larghezza, uno accanto all'altro.
 *
 * Chi vince. Quando la ragione di sistema e' `null` o `retries_exhausted` le
 * due chip dicono le STESSE parole, e vince «niente consegnato» perche' il suo
 * tooltip e' quello utile: dice che non c'e' un diff da guardare e cosa fare
 * invece. Le altre tre ragioni (`model_refused`, `fanout`, `parked_children`)
 * aggiungono un fatto che l'altra non ha, e allora vince la ragione.
 *
 * Nessun test lo prendeva: `card-meta-row-completeness` verifica che una chip
 * si MONTI, non che due non dicano la stessa cosa.
 */
export function nothingDeliveredWins(reason: BoardTask['deliveredReason']): boolean {
  return reason === null || reason === undefined || reason === 'retries_exhausted';
}

/**
 * La card è in review SENZA che nessuno abbia consegnato niente.
 *
 * Misurato il 13/08 su due card vere: 5472e584 aveva consegnato, c0849d9d era
 * finita lì col turno esaurito, e sulla board erano indistinguibili. Le SCELTE
 * erano le stesse («Landa su main» verde sulla card, «Approva» verde nel
 * drawer), quindi la differenza si scopriva solo aprendo un diff vuoto.
 *
 * Due delle quattro ragioni di sistema restano fuori, e non per prudenza: hanno
 * già una superficie loro, e la scelta giusta lì non è nessuna di queste.
 * `fanout` si decide dal pannello Tentativi (quale tentativo tenere), e
 * `parked_children` è una domanda con le sue due risposte rapide. Riscrivere
 * anche i loro bottoni sarebbe una decisione diversa da questa.
 */
export function isUnfinishedReview(
  task: Pick<BoardTask, 'status' | 'deliveredBy' | 'deliveredReason'>,
): boolean {
  if (task.status !== 'review' || task.deliveredBy !== 'system') return false;
  return task.deliveredReason === null
    || task.deliveredReason === 'retries_exhausted'
    || task.deliveredReason === 'model_refused';
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * I DUE VERSI DELL'ATTESA, e perché non possono condividere una parola.
 *
 * Fino al 12/08 la stessa card poteva portare «in attesa di: X» e «3 in
 * attesa», che sono fatti OPPOSTI: il primo è «io aspetto un altro», il
 * secondo è «altri tre aspettano me» — e chiudere questa card, nel secondo
 * caso, ne sblocca tre. L'unico indizio era il numero davanti, e la
 * disambiguazione stava nel `title`: cioè in un tooltip, che vede solo chi ha
 * un mouse e sa di doverlo cercare. Su un telefono non esisteva proprio.
 *
 * Quindi i due verbi ora si scrivono qui, uno accanto all'altro, e non
 * condividono nemmeno una parola: **«aspetta …»** = io aspetto. **«… la
 * aspettano»** = altri aspettano me. Il test in `board.test.ts` pinna che
 * restino disgiunti — è l'unica cosa che impedisce alla parola di tornare.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * IO ASPETTO un altro task: cosa scriverci, o `null` se non va disegnato.
 *
 * Decide dal LINK (`blockedByTaskId`), non da chi c'è nella lista che il client
 * ha in mano. La card lo derivava cercando il bloccante fra i task fetchati —
 * un progetto, `rootsOnly`, non archiviati — quindi un bloccante fuori da quel
 * taglio faceva sparire il chip e la card sembrava libera di partire mentre il
 * dispatcher la teneva ferma. Il titolo lo risolve il server (`blockedBy`);
 * quando manca il chip resta, degradato: «c'è un legame» è l'informazione che
 * conta, il titolo è il di più.
 *
 * Muto solo quando il bloccante è chiuso o archiviato — lo stesso predicato del
 * gate di dispatch lato server: lì il task riparte, qui il chip si spegne.
 */
export function blockedByChip(
  task: Pick<BoardTask, 'blockedByTaskId' | 'blockedBy'>,
): { label: string; title: string } | null {
  if (!task.blockedByTaskId) return null;
  const b = task.blockedBy;
  if (b && (b.status === 'done' || b.archived)) return null;
  return b
    ? {
      label: `aspetta: ${b.text}`,
      title: `Questa card aspetta «${b.text}»: non parte finché quella non chiude.`,
    }
    : {
      label: 'aspetta un altro task',
      title: 'Questa card aspetta un altro task: non parte finché quello non chiude. Il titolo non è disponibile qui.',
    };
}

/**
 * ALTRI ASPETTANO ME: quanti, e cosa succede quando chiudo. `null` = nessuno.
 *
 * Il verbo è coniugato apposta al plurale con la card come oggetto — «3 la
 * aspettano» — perché è la forma che NON si può leggere al contrario. «3 in
 * attesa», che c'era prima, si legge benissimo come «questa card sta
 * aspettando tre cose», ed è il rovescio esatto della verità: qui la card è
 * quella che sblocca, non quella bloccata.
 */
export function waitingOnThisChip(
  task: Pick<BoardTask, 'waitingOnCount' | 'status'>,
): { label: string; title: string } | null {
  const n = task.waitingOnCount;
  if (n <= 0 || task.status === 'done') return null;
  return n === 1
    ? { label: '1 la aspetta', title: 'Un task aspetta questa card: parte da solo quando la chiudi.' }
    : { label: `${n} la aspettano`, title: `${n} task aspettano questa card: partono da soli quando la chiudi.` };
}

/**
 * Il chip «chi la lavora» di un sottotask senza agente proprio: cosa scriverci,
 * o `null` se non va disegnato.
 *
 * Due chip e non uno, perché le due risposte servono a due persone diverse.
 * `parent-turn` rassicura chi guarda la board — la card è in mano a qualcuno,
 * dentro il turno di un antenato, ed è il flusso voluto. `unattended` è invece
 * l'unico caso che chiede un intervento: nessuno la sta lavorando, e finora non
 * lo diceva nessuno (il recupero orfani filtra sul chip di dispatch, che in
 * questa forma non c'è). Tacere sul primo per non urlare il secondo lascerebbe
 * la card ambigua com'era: è proprio la coppia che la disambigua.
 *
 * Il titolo dell'antenato lo risolve il server (`subtaskWork.ancestor`): la
 * lista della board è un progetto solo, `rootsOnly`, non archiviati, e il padre
 * di un sottotask quasi mai ci sta dentro.
 */
export function subtaskWorkChip(
  task: Pick<BoardTask, 'subtaskWork'>,
): { kind: SubtaskWork['kind']; label: string; title: string } | null {
  const w = task.subtaskWork;
  if (!w) return null;
  if (w.kind === 'unattended') {
    return {
      kind: 'unattended',
      label: 'nessuno la lavora',
      title: 'In corso, ma senza agente suo e senza nessun antenato al lavoro: è rimasta qui. Rimettila in coda o chiudila.',
    };
  }
  return {
    kind: 'parent-turn',
    label: 'nel turno del padre',
    title: `La lavora l'agente di: ${w.ancestor.text}`,
  };
}

/**
 * La ragione di coda da disegnare sulla riga di uno step, o `null` se la riga
 * non deve dire niente.
 *
 * Uno step non compare MAI in una colonna della board (le colonne sono
 * `rootsOnly` e recuperano i soli step orfani): l'albero dei sottotask del
 * padre è l'unico posto dove quella riga sta già sotto gli occhi. Il dato
 * viaggia già nel payload di ogni figlio — mancava solo chi lo disegnasse.
 *
 * Filtro su `stalled` e non su «c'è una ragione»: `queued` e `waiting` sono la
 * vita normale di uno step (in coda, oppure in mano al padre) e riempirebbero la
 * checklist di chip che non chiedono niente a nessuno. La visibilità comprata
 * col rumore non è visibilità: la riga davvero ferma sparirebbe tra le altre.
 */
export function subtaskQueueChip(
  task: Pick<BoardTask, 'queueReason'>,
): QueueReason | null {
  const reason = task.queueReason;
  if (!reason || reason.tone !== 'stalled') return null;
  return reason;
}

/**
 * Se la riga di uno step si apre nel drawer.
 *
 * Una riga nuda (niente descrizione, niente figli, nessun tab d'agente) non ha
 * niente da mostrare: resta uno `span`, così non finge un click che non porta
 * da nessuna parte. Ma una riga FERMA ha qualcosa da dire — il motivo per
 * esteso, che nel chip sta troncato — e allora deve potersi aprire.
 */
export function subtaskOpenable(
  task: Pick<BoardTask, 'description' | 'assignedTopicId' | 'subtaskCount' | 'queueReason'>,
): boolean {
  return !!task.description || task.subtaskCount > 0 || !!task.assignedTopicId || !!subtaskQueueChip(task);
}

/**
 * Il chip «riaperta»: una card che ERA consegnata e non lo è più lo dice sulla
 * card, dove si guarda — non solo nel thread.
 *
 * Misurato l'11/08: undici card uscite da `done` in sei ore. Non se n'era persa
 * nessuna, ma dalla colonna si vedeva solo un buco al posto di una cosa fatta, e
 * il motivo (che c'era sempre) viveva nel commento. `null` = la card non è mai
 * uscita dalla consegna, o ci è tornata (allora il ciclo è chiuso e il segno
 * cade).
 *
 * Il tooltip non nomina più la colonna di partenza: adesso il segno si accende
 * anche uscendo da `review`, e «Era in Done» sarebbe stato falso su tre uscite
 * su quattro.
 */
export function reopenedChip(
  task: Pick<BoardTask, 'reopenedAt' | 'reopenedBy' | 'reopenedActor'>,
): { label: string; title: string; detail: string } | null {
  if (!task.reopenedAt) return null;
  const when = new Date(task.reopenedAt);
  const quando = Number.isNaN(when.getTime()) ? task.reopenedAt : when.toLocaleString('it-IT');
  const chi = task.reopenedActor === 'human'
    ? 'da te'
    : task.reopenedActor === 'system'
      ? 'dal sistema'
      : `da un agent${task.reopenedBy ? ` (${task.reopenedBy})` : ''}`;
  // `detail` è la stessa frase senza preamboli: la banda del drawer ha già la
  // parola «Riaperta» in grassetto e ripeterla la renderebbe illeggibile.
  return {
    label: 'riaperta',
    detail: `${chi} il ${quando}`,
    title: `Aveva consegnato: riaperta ${chi} il ${quando}. Il motivo è nel thread della card.`,
  };
}


/**
 * La priorità «auto» è una promessa SULLA CODA, e come tutte le promesse ha una
 * scadenza.
 *
 * `priorityAuto` vuol dire: nessuno ha scelto, la sceglierà l'agent appena
 * inquadra il lavoro. Ha senso finché il task è ancora in coda — è lì che la
 * priorità serve, perché è l'ordine con cui i task partono. Appena il task È
 * partito, la coda l'ha già servito: la priorità non ordina più niente, e quella
 * valutazione, se non è arrivata, non arriverà.
 *
 * Continuare a scrivere «Priorità auto» sulla scheda di un task in lavorazione
 * promette all'umano una cosa che non succederà, e nasconde il valore
 * effettivamente in vigore (il default, Media, se nessuno ha toccato niente).
 * Dopo la coda si mostra il valore vero.
 */
export function priorityAwaitingAgent(task: { status: TaskStatus; priorityAuto: boolean }): boolean {
  return task.priorityAuto && (task.status === 'backlog' || task.status === 'todo');
}


export interface BoardTask {
  id: string;
  projectId: string;
  text: string;
  /**
   * SOLO dal dettaglio (`boardApi.get`). La lista non la porta: erano 470 KB
   * sui 1,4 MB del feed per un testo che la card taglia comunque a due righe.
   * Chi disegna una card legge `descriptionPreview`.
   */
  description: string | null;
  /**
   * I primi 240 caratteri della descrizione — ciò che la card disegna.
   *
   * Opzionale perché un server più vecchio del client non lo manda (il guscio
   * Tauri incorpora il suo `public/` e può restare indietro rispetto al server
   * su :3333): chi lo legge ricade su `description`.
   */
  descriptionPreview?: string | null;
  /**
   * Gli ultimi commenti PARLATI del thread, dal più vecchio al più recente:
   * quello che la card in review mostra (l'ultima parola dell'agente e la
   * richiesta umana a cui risponde). Il server li attacca SOLO alle schede in
   * review, che sono le uniche a disegnarli.
   *
   * `undefined` = questo server non li manda (client più nuovo del server) e la
   * card torna a chiedere il dettaglio; `[]` = non c'è niente da mostrare, e
   * nessuna richiesta parte.
   */
  recentComments?: CardComment[];
  status: TaskStatus;
  priority: number;
  /** Nobody chose a priority: the dispatched agent evaluates and sets one. */
  priorityAuto: boolean;
  kanbanOrder: number;
  assignedTo: string | null;
  /** ON THE WIRE: it arrives only when it has a value (absent = never happened). */
  dueDate?: string;
  createdAt: string;
  /** ON THE WIRE: it arrives only when it has a value (absent = never happened). */
  completedAt?: string;
  updatedAt: string;
  /** Topic (chat tab) the dispatched agent works this task in, if any. */
  assignedTopicId: string | null;
  /** null = not dispatched; queued | starting | working | needs_input. */
  dispatchState: string | null;
  /** Why the last dispatch attempt was released/parked (visible feedback). */
  dispatchError: string | null;
  /** Parent task when this is a nested subtask (unlimited depth). */
  parentTaskId: string | null;
  /** Reviewable output (http/https URL) shown in the task's review panel.
   *  ON THE WIRE: it arrives only when it has a value. */
  outputUrl?: string;
  /**
   * Esito della sonda server-side sull'output_url.
   * `'live'` = risponde, `'dead'` = morto, `'unknown'` = mai provata.
   * `null` = nessun output_url, campo non rilevante.
   * Il client mostra il link solo su `live`; su `dead` mostra un avviso;
   * su `unknown` (incluso `null`) tace.
   */
  urlProbeStatus: 'live' | 'dead' | 'unknown' | null;
  urlProbeCheckedAt?: string;
  /** Screenshot della consegna (path assoluto allowlistato) — thumbnail
   *  sulla card, servito via /api/media. */
  /** A che punto e' la corsa dei controlli, mentre `checksState` e' `running`.
   *  Assente da un server piu' vecchio: la card torna a dire «check in corso». */
  checksProgress?: { done: number; total: number } | null;
  previewImage: string | null;
  /** LE ALTRE evidenze allegate nel thread, per il carosello della card.
   *  Vuoto (o assente, da un server piu' vecchio) = una slide sola. */
  previewImages?: string[];
  /** L'anteprima è stata RITIRATA perché non era evidenza (duplicata, un
   *  placeholder, un errore). Stato della card, non messaggio nel thread: si
   *  spegne da solo appena ne arriva una nuova. `null` = mai successo. */
  previewRetiredAt: string | null;
  previewRetiredReason: string | null;
  /** Paths the retirement rejected: the server already drops them from `previewImages`. */
  previewRejected?: string[];
  /** Dispatch contract: agent delivers a PLAN to review before implementing. */
  planFirst: boolean;
  /** IL commento che È il piano — scritto dal server quando il piano arriva
   *  (contratto piano-prima). `null` sui task nati prima del puntatore: la tab
   *  "Piano" ha una ricaduta esplicita per quelli. */
  planCommentId?: string;
  /** When the current claim started — anchors the live "ci sta mettendo" ticker. */
  inProgressAt?: string;
  /** Cumulative agent effort across every turn (dispatcher-recorded).
   *  agentTokens = input+output+cacheWrite (dedup by API message id); cache
   *  READS ride separately — the context re-read pressure, not "work" tokens. */
  agentMs: number;
  agentTokens: number;
  agentCacheReadTokens: number;
  /** Direct-children counters (board badges: "↳ done/total"). */
  subtaskCount: number;
  subtaskDoneCount: number;
  /** Human interactions in the thread: 'user' comments (kind='comment') — the
   *  AI/agent, system notes and status events are excluded. Shown on the card. */
  userCommentCount: number;
  /** Model the dispatched agent runs on; null = provider default ("Auto"). */
  model: string | null;
  /** Lo sforzo con cui il task ha girato davvero (dal topic dell'agente). Con la
   *  board su `auto` lo sceglie il classificatore, e questo è l'unico posto in
   *  cui la scelta si legge: è la leva di costo più pesante che abbiamo. */
  effort?: string | null;
  /** Root task this one is gated on — the dispatcher won't start it until that task is done. */
  blockedByTaskId: string | null;
  /** Lo stesso bloccante risolto dal server (titolo + stato + archiviato). È la
   *  fonte del chip «in attesa di»: la lista fetchata non lo contiene sempre.
   *  null = nessun link, o la riga puntata non esiste più. */
  blockedBy: BlockerRef | null;
  /** Chi lavora questo sottotask quando non ha un agente suo — derivato dalla
   *  catena dei padri dal server. `null` = la domanda non si pone. */
  subtaskWork: SubtaskWork | null;
  /** L'altra metà del legame, contata dal server: quanti task VIVI (non
   *  archiviati, non done) aspettano questo. È la fonte del chip «N in attesa»:
   *  contandoli nella lista fetchata sparivano i dipendenti che sono sottotask
   *  o stanno in un altro progetto. */
  waitingOnCount: number;
  /**
   * PERCHÉ questa card è ferma in `todo`, in una frase GIÀ SCRITTA dal server.
   * `null` fuori da `todo`, o con un agente già in volo.
   *
   * Qui non c'è niente da derivare, ed è apposta: la decisione di non
   * dispacciare la prende il dispatcher, e due dei suoi ingredienti non stanno
   * nemmeno sulla card (l'interruttore di dispatch, e la posizione in una coda
   * che è machine-wide mentre questa lista è un progetto solo). Dedurla qui
   * vorrebbe dire dire la regola di ieri con la faccia sicura, il giorno che il
   * dispatcher cambia — lo stesso conto già pagato con `waitingOnCount`.
   */
  queueReason: QueueReason | null;
  /** When blocked, hand the new agent the blocker's session context instead of a cold start. */
  reuseBlockerContext: boolean;
  /** Branch the task delivered on, snapshot at review-time (diagnostics). */
  deliveryBranch: string | null;
  /** Tip of that branch at review-time — the durable handle the audit checks. */
  deliveryCommit: string | null;
  /** Da quando la card aspetta una risposta umana. `null` = mai passata di qui
   *  dopo la migration: non si inventa un istante che nessuno ha registrato. */
  reviewAt: string | null;
  /** QUANTO lavoro c'è dentro la consegna. `null` = non misurato (git muto o
   *  card senza worktree), che è diverso da zero: zero direbbe «misurato, non
   *  ha prodotto niente». Serve alla colonna review, che chiedeva «Approva»
   *  senza dire cosa si stesse approvando. */
  deliveryFilesChanged: number | null;
  deliveryInsertions: number | null;
  deliveryDeletions: number | null;
  /** Landing audit verdict: is the delivered work actually on main?
   *  null = never audited (no delivery recorded). 'unlanded' is the alarm. */
  landingState: "landed" | "unlanded" | "unverifiable" | "superseded" | null;
  landingCheckedAt?: string;
  /** Deploy proposed at approve (board setting `deployCommand`). `null` = never
   *  proposed. `'proposed'` shows the "Deploya ora" banner; the outcome
   *  (`deployed`/`failed`) is told in the thread as a system comment. */
  deployState: "proposed" | "running" | "deployed" | "failed" | null;
  /** Esito dei checks pre-review. null = mai girati — NON un verde. */
  /**
   * `unknown` = i comandi non sono arrivati in fondo (quasi sempre il tetto dei
   * 20 minuti su una macchina carica). NON e' una sfumatura di `fail`: rosso
   * dice «il codice e' rotto, non approvare», non-misurato dice «non lo
   * sappiamo». Misurate il 18/08: 6 card su 15 marcate rosse erano solo scadute.
   */
  checksState: "running" | "pass" | "fail" | "unknown" | null;
  checksAt: string | null;
  /** Commit su cui sono girati: se il branch è avanzato, il verde è scaduto. */
  checksCommit: string | null;
  checks: CheckRun[] | null;
  /** Chi l'ha portato in review. 'system' = non è una consegna: è un turno finito
   *  male che qualcuno deve guardare, e sotto può non esserci un deliverable. */
  deliveredBy: 'agent' | 'human' | 'system' | null;
  /** Perché, quando `deliveredBy === 'system'`. La prosa sta nel thread. */
  deliveredReason: 'retries_exhausted' | 'model_refused' | 'fanout' | 'parked_children' | null;
  /** Chi ha chiuso la card l'ultima volta: 'human' = una decisione di Attilio
   *  (approvazione o trascinamento) e un agent non la riapre. */
  doneActor: 'human' | 'agent' | 'system' | null;
  /** La card è USCITA da done: quando, per mano di chi, con che ruolo. Resta
   *  finché non torna done. È il chip «riaperta»: senza, la colonna mostrava
   *  solo un buco dove c'era una cosa fatta. */
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedActor: 'human' | 'agent' | 'system' | null;
  /** Le etichette (migration 100), con chi le ha scritte. `visibile`/`invisibile`
   *  decidono chi chiude la card e le DERIVA il server dal diff alla consegna;
   *  il resto filtra. Vocabolario e regola: `shared/task-labels.ts`. */
  labels: TaskLabelRow[];
}

export interface TaskWithThread {
  task: BoardTask;
  comments: TaskComment[];
  /** Direct subtasks (drawer list). */
  children: BoardTask[];
}

/**
 * Derive the board `projectId` from an absolute project path.
 *
 * Stessa dichiarazione del server, non una gemella: `boardIdForPath` è il nome
 * con cui il client la conosce (`TopicTree`, `KanbanBoardPane`), ma la funzione
 * è quella di `shared/board.ts`. Il test di parità qui accanto resta: adesso
 * misura che l'alias punti ancora al vettore giusto, non che due copie siano
 * ancora d'accordo.
 */
export { projectIdForPath as boardIdForPath } from '../../../shared/board';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await resp.text().catch(() => '');
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!resp.ok) throw new Error((parsed as { error?: string } | undefined)?.error || text || resp.statusText);
  return parsed as T;
}

export interface CreateTaskBody {
  text: string;
  description?: string | null;
  priority?: number;
  assignee?: string | null;
  status?: TaskStatus;
  /** Nest under this task (subtask, unlimited depth). */
  parentTaskId?: string | null;
  /** Dispatch contract: the agent plans first, implements after human approval. */
  planFirst?: boolean;
  /** Model the dispatched agent runs on; omitted/null = provider default ("Auto"). */
  model?: string | null;
  /** Gate: don't dispatch until this root task is done. */
  blockedByTaskId?: string | null;
  /** When blocked, hand the new agent the blocker's session context. */
  reuseBlockerContext?: boolean;
  /**
   * Il link (parent o blocker) arriva da una proposta di intake ACCETTATA: il
   * server scrive il perché nei thread di entrambe le card. Senza questo flag
   * il link resta muto — che va bene per uno step aggiunto a mano dal drawer,
   * mai per un collegamento che qualcuno ha solo confermato con un click.
   */
  intakeLink?: boolean;
  /** Il motivo, in chiaro, così com'è stato mostrato prima del click. */
  intakeReason?: string;
}

/**
 * La proposta dell'intake: dove andrebbe il testo che stai scrivendo. È una
 * PROPOSTA — finché non la si accetta non esiste nessun collegamento, e il
 * default (non fare niente) resta "task nuovo".
 */
// Dichiarata in shared/: la calcola il server e la disegna il client, e due
// copie libere di divergere sono esattamente ciò che il cancello sui doppioni
// di tipo esiste per impedire.
export type { LinkProposal } from '../../../shared/board';
import type { LinkProposal } from '../../../shared/board';

export interface UpdateTaskBody {
  status?: TaskStatus;
  priority?: number;
  assignee?: string | null;
  text?: string;
  description?: string | null;
  kanbanOrder?: number;
  /** http(s) URL of the reviewable output; empty string clears it. */
  outputUrl?: string;
  /** Screenshot della consegna per la card (path assoluto allowlistato);
   *  empty string clears it. */
  previewImage?: string;
  /** Model the dispatched agent runs on; null clears back to "Auto". */
  model?: string | null;
  /** Gate: don't dispatch until this root task is done; null clears it. */
  blockedByTaskId?: string | null;
  /** When blocked, hand the new agent the blocker's session context. */
  reuseBlockerContext?: boolean;
  /** Agent delivers a plan to approve before implementing. */
  planFirst?: boolean;
}

/** Machine-wide dispatch settings (server: reserved board_settings row '*'). */
export interface GlobalSettings {
  /** Auto-dispatch master switch — a Todo task starts an agent on any board. */
  autoDispatch: boolean;
  /** The ONE machine-wide concurrency cap is auto-sized from live capacity. */
  maxAgentsAuto: boolean;
  /** The fixed machine-wide cap used when `maxAgentsAuto` is off. */
  maxAgents: number;
}

/** One commit that a publish (push) would ship. */
export interface PublishCommit {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

/** Per-file summary line of a unified diff. status: A/M/D/R (git name-status). */
export interface DiffFileStat {
  path: string;
  additions: number; // -1 = binary
  deletions: number; // -1 = binary
  status: string;
}

/**
 * Perché NON c'è un diff — tre risposte, e tenerle separate è il punto: prima
 * erano lo stesso silenzio (il pannello non si disegnava affatto), e «la card non
 * ha prodotto codice» era indistinguibile da «non ho potuto guardare».
 *
 *  · `no_changes`     — la gamma esiste ed è venuta fuori vuota. Verificato.
 *  · `unreadable`     — nessuna gamma ricostruibile: il worktree è potato e non
 *                       c'è un riferimento durevole (o la card ha lavorato in
 *                       loco, senza un ramo suo da leggere).
 *  · `not_dispatched` — nessun agente ci ha mai lavorato: non c'è una domanda.
 */
export type DiffMissCode = 'no_changes' | 'unreadable' | 'not_dispatched';

/** Da dove viene la gamma — cambia cosa stai leggendo, quindi si dice. */
export type DiffSource = 'worktree' | 'landed-merge' | 'delivery-commit';

/** A unified-diff bundle: per-file stat + the raw patch, capped server-side. */
export interface DiffBundle {
  branch: string | null;
  range?: string;
  base?: string | null;
  stat: DiffFileStat[];
  patch: string;
  truncated: boolean;
  code?: DiffMissCode;
  source?: DiffSource | null;
}

/**
 * Il totale in testa al pannello: quanti file, quante righe.
 *
 * Si conta sullo STAT, non sul patch: lo stat è completo per contratto (git lo
 * dà per numstat, che non ha tetto), il patch no — oltre il tetto del payload è
 * tagliato, e un totale contato lì direbbe «3 file» su una consegna da 40.
 * I binari escono come `-1`: contano come file toccato, non come righe.
 */
export function diffTotals(stat: DiffFileStat[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const s of stat) {
    if (s.additions > 0) additions += s.additions;
    if (s.deletions > 0) deletions += s.deletions;
  }
  return { files: stat.length, additions, deletions };
}

/**
 * Ha senso chiedersi «cosa ha cambiato» per questa card?
 *
 * Sì appena qualcuno ci ha lavorato (o avrebbe dovuto): un agente assegnato, una
 * consegna registrata, o una card che sta in review/done — ed è quest'ultimo il
 * caso che conta, perché è lì che il silenzio faceva più danno. No su una card
 * di backlog che nessuno ha ancora toccato: quella la domanda non ce l'ha, e una
 * barra «Modifiche: non dispatchata» su ogni riga del backlog è solo rumore.
 */
export function hasCodeQuestion(
  t: Pick<BoardTask, 'assignedTopicId' | 'deliveryBranch' | 'deliveryCommit' | 'status'>,
): boolean {
  return !!t.assignedTopicId || !!t.deliveryBranch || !!t.deliveryCommit
    || t.status === 'review' || t.status === 'done';
}

/**
 * Nota di revisione ancorata a una riga del diff, in sospeso finché non parte
 * come commento all'agente. Vive qui e non accanto al componente perché è una
 * forma DI DATI della board: la bozza la persiste in ui-state (`boardDrafts`),
 * e `lib/` non può dipendere da `components/`.
 */
export interface DiffNote {
  id: string;
  /** Path `b/` del file, come lo mostra la card del diff. */
  path: string;
  /** Riga a cui è appesa la nota, nel lato indicato da `side`. */
  line: number;
  /** `new` = riga del file dopo la modifica; `old` = riga rimossa. */
  side: 'new' | 'old';
  /** La riga stessa, ricitata all'agente: senza, "riga 42" è ambiguo dopo un edit. */
  code: string;
  /** Testo scritto dall'umano. */
  body: string;
}

/** A project's unpushed state for the Publish control. */
export interface PublishProject {
  projectId: string;
  name: string;
  branch: string;
  ahead: number;
  commits: PublishCommit[];
}

/** One entry of the board index (task-detail project selector). */
export interface BoardProjectRef {
  projectId: string;
  name: string;
  path: string;
}

const enc = encodeURIComponent;

/** Lo stato della modalità notturna, come lo riporta il server. */
export interface NightStatus {
  enabled: boolean;
  until: string | null;
  startedAt: string | null;
  action: 'off' | 'dispatch' | 'wait' | 'expire';
  reason: string | null;
  load1: number;
  cores: number;
  busySessions: number;
  endsInMs: number | null;
}

export const boardApi = {
  /** `archived: true` = SOLO l'archivio di questa board (come `list({archived})`
   *  sui progetti). Assente = i vivi, cioè la board di sempre. */
  list: (projectId: string, status?: TaskStatus, labels?: readonly TaskLabel[], opts?: { archived?: boolean }) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (labels?.length) qs.set('labels', labels.join(','));
    if (opts?.archived) qs.set('archived', '1');
    const q = qs.toString();
    return req<{ tasks: BoardTask[] }>(`/boards/${enc(projectId)}/tasks${q ? `?${q}` : ''}`).then(r => r.tasks);
  },
  /** Riscrive l'INTERO insieme di etichette (PUT): la board manda ciò che vuole
   *  vedere, quindi togliere l'ultima etichetta è una chiamata come le altre.
   *  Da qui `invisibile` si può scrivere — questa è la porta umana. */
  setLabels: (projectId: string, taskId: string, labels: readonly TaskLabel[]) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/labels`, {
      method: 'PUT', body: JSON.stringify({ labels }),
    }),
  /**
   * The global cross-project feed (GET /api/all-boards/tasks). Read-only list;
   * each task carries its own `projectId`, so per-task mutations route back
   * through the normal project-scoped endpoints via that id.
   */
  listAll: (status?: TaskStatus) =>
    req<{ tasks: BoardTask[] }>(`/all-boards/tasks${status ? `?status=${status}` : ''}`).then(r => r.tasks),
  /**
   * LA PORTA UNICA «da un id al suo task, a qualunque profondità».
   *
   * `listAll` è `rootsOnly` — le colonne mostrano le radici, gli step vivono
   * nell'albero del genitore — quindi `(await listAll()).find(t => t.id === id)`
   * è `undefined` per QUALSIASI sottotask, e chi lo usava come risolutore
   * (drawer, deep-link `/task/<id>`, click su una notifica) non arrivava a
   * niente. Questa è la sola funzione da chiamare quando si ha in mano un id e
   * si vuole il suo task: non filtra per profondità né per progetto.
   *
   * `null` = quell'id non esiste (risposta, non errore: il server risponde 200).
   * Un rifiuto della promise è un guasto di TRASPORTO — chi aspetta un deep-link
   * deve poterli distinguere: sul primo smette, sul secondo riprova.
   */
  resolve: (taskId: string) =>
    req<{ task: BoardTask | null }>(`/all-boards/tasks/${enc(taskId)}`).then(r => r.task ?? null),
  create: (projectId: string, body: CreateTaskBody) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  /** "Dove va questo testo?" — sola lettura, non tocca un solo task. */
  suggestLink: (projectId: string, text: string, description?: string | null) =>
    req<{ proposal: LinkProposal | null }>(`/boards/${enc(projectId)}/intake/suggest`, {
      method: 'POST', body: JSON.stringify({ text, description }),
    }).then(r => r.proposal),
  get: (projectId: string, taskId: string) =>
    req<TaskWithThread>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`),
  update: (projectId: string, taskId: string, patch: UpdateTaskBody) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  archive: (projectId: string, taskId: string) =>
    req<{ ok: boolean }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}`, { method: 'DELETE' }),
  /** Il ritorno dalla DELETE: riporta la card sulla board, col suo sottoalbero e
   *  la sua colonna. Rotta a sé, come per i progetti — la PATCH non archivia e
   *  quindi non disarchivia. */
  restore: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/restore`, { method: 'POST' }),
  /** `quiet` = ANNOTAZIONE, non consegna: il commento si salva e si vede, ma il
   *  server si ferma lì. Nessun reject, nessun resume, la card non si muove.
   *  Senza, un commento su una card in review RIMANDA il task all'agent. */
  comment: (projectId: string, taskId: string, content: string, opts?: { mentions?: string[]; media?: string[]; quiet?: boolean }) =>
    req<TaskComment>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/comments`, { method: 'POST', body: JSON.stringify({ content, mentions: opts?.mentions, media: opts?.media, quiet: opts?.quiet }) }),
  /** `force` scavalca il gate sui checks rossi: è una scelta esplicita dell'umano,
   *  mai il default (il server risponde 409 `checks_failed` senza). */
  review: (projectId: string, taskId: string, decision: 'approve' | 'reject', comment?: string, opts?: { force?: boolean }) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/review`, { method: 'POST', body: JSON.stringify({ decision, comment, force: opts?.force }) }),
  /** Land the task's branch on main (accept if still in review, then merge locally
   *  + rebuild). Explicit, decoupled from approve — never pushes online.
   *  Risponde `202`: il land è ACCODATO, non ancora avvenuto — `landing` dice in
   *  quanti ha davanti, e `landStatus` com'è finito. */
  land: (projectId: string, taskId: string) =>
    req<BoardTask & { landing: LandingTicket }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/land`, { method: 'POST', body: JSON.stringify({}) }),
  /** L'esito del land richiesto per questo task (404 se non ne è mai stato chiesto uno). */
  landStatus: (projectId: string, taskId: string) =>
    req<{ landing: LandingTicket; pending: number }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/land`),
  /** Confirm a proposed deploy (board setting `deployCommand`): runs the command
   *  in the project's main checkout. Never automatic — this IS the human click. */
  deploy: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/deploy`, { method: 'POST', body: JSON.stringify({}) }),
  /**
   * «Ricattura evidenza» su una card GIÀ in review: riavvia l'anteprima dal suo
   * worktree e la rifotografa. Non sveglia l'agent, non consuma un tentativo, non
   * muove il task di colonna — e se non è possibile, il motivo arriva nel thread
   * come review-note. Può metterci decine di secondi (boot + screenshot).
   */
  recapturePreview: (projectId: string, taskId: string) =>
    req<{ task: BoardTask; previewImage: string | null; outputUrl: string | null }>(
      `/boards/${enc(projectId)}/tasks/${enc(taskId)}/preview`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** Move a root task (and its subtree) to another board. */
  move: (projectId: string, taskId: string, toProjectId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/move`, { method: 'POST', body: JSON.stringify({ toProjectId }) }),
  /** Stop a running dispatch: parks the task and aborts the agent's turn. */
  stop: (projectId: string, taskId: string) =>
    req<BoardTask>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/stop`, { method: 'POST', body: JSON.stringify({}) }),
  /** Every board the server can resolve (the project selector's options), più
   *  `newProjectDir`: la cartella in cui nascerebbe un progetto creato per
   *  nome. È dedotta lato server, e va MOSTRATA prima di creare. */
  projects: () =>
    req<{ projects: BoardProjectRef[]; newProjectDir: string | null }>('/all-boards/projects'),
  /** Per-project commits on the current branch not yet pushed — feeds the Publish control.
   *  `commits` is the exact list a push would ship (newest first, capped at 50). */
  publishStatus: () =>
    req<{ projects: PublishProject[] }>('/all-boards/publish-status').then(r => r.projects),
  /** Push a project's current branch to its remote (triggers deploy CI where configured). */
  publish: (projectId: string) =>
    req<{ ok: boolean; branch: string; output?: string; error?: string }>(`/boards/${enc(projectId)}/publish`, { method: 'POST', body: JSON.stringify({}) }),
  /** Unified diff of the commits a publish would push (what ships). */
  publishDiff: (projectId: string) =>
    req<DiffBundle>(`/boards/${enc(projectId)}/publish-diff`),
  /** Unified diff of what a dispatched task changed in its isolated worktree.
   *  `attemptId` sposta la lettura su UN tentativo del fan-out invece che sul
   *  task: è così che si confrontano N alternative prima di sceglierne una. */
  taskDiff: (projectId: string, taskId: string, attemptId?: string) =>
    req<DiffBundle>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/diff${attemptId ? `?attempt=${enc(attemptId)}` : ''}`),
  /** I tentativi paralleli di un fan-out. Lista vuota = task dispatchato normalmente. */
  attempts: (projectId: string, taskId: string) =>
    req<{ attempts: TaskAttempt[] }>(`/boards/${enc(projectId)}/tasks/${enc(taskId)}/attempts`).then(r => r.attempts),
  /** Sceglie il vincitore: il task punta al suo worktree, gli altri vengono buttati. */
  selectAttempt: (projectId: string, taskId: string, attemptId: string) =>
    req<{ task: BoardTask; attempts: TaskAttempt[] }>(
      `/boards/${enc(projectId)}/tasks/${enc(taskId)}/attempts/${enc(attemptId)}/select`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  /** Scaffold a NEW workspace project (dir + CLAUDE.md); 409 on name collision. */
  createProject: (name: string) =>
    req<BoardProjectRef>('/all-boards/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  getSettings: (projectId: string) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`),
  updateSettings: (projectId: string, patch: BoardSettingsPatch) =>
    req<BoardSettings>(`/boards/${enc(projectId)}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /**
   * Lo stato della modalità notturna di una board: accesa sì, ma sta dispacciando
   * o aspettando, e perché. Passa dallo STESSO calcolo del gate del dispatcher,
   * quindi l'interfaccia non può dire una cosa diversa da quella che succede.
   */
  nightStatus: (projectId: string) =>
    req<NightStatus>(`/boards/${enc(projectId)}/night-status`),
  /** Recommended auto concurrency cap for this machine right now (CPU/load). */
  dispatchCapacity: () =>
    req<DispatchCapacity>('/system/dispatch-capacity'),
  /** The GLOBAL auto-dispatch switch (one for every board, incl. the global one). */
  getGlobalDispatch: () =>
    req<{ autoDispatch: boolean }>('/all-boards/settings').then(r => r.autoDispatch),
  setGlobalDispatch: (autoDispatch: boolean) =>
    req<{ autoDispatch: boolean }>('/all-boards/settings', { method: 'PATCH', body: JSON.stringify({ autoDispatch }) }).then(r => r.autoDispatch),
  /** GLOBAL settings: auto-dispatch switch + the ONE machine-wide cap (auto/number). */
  getGlobalSettings: () =>
    req<GlobalSettings>('/all-boards/settings'),
  /** Update the machine-wide cap: `auto` toggle and/or a fixed `max` number. */
  setGlobalCap: (patch: { auto?: boolean; max?: number }) =>
    req<GlobalSettings>('/all-boards/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.auto !== undefined ? { maxAgentsAuto: patch.auto } : {}),
        ...(patch.max !== undefined ? { maxAgents: patch.max } : {}),
      }),
    }),
};

// ── Server-persisted drafts ──────────────────────────────────────────────────
// A half-written task or reply is work too: drafts live in the generic
// ui-state store (LWW), so they survive reloads/app restarts and follow the
// user across clients. Writes are debounced per key; failures are silent
// (the in-memory text is never blocked on the network).

export interface ComposerDraft {
  text: string;
  model: string | null;
  prio: number | null;
  planFirst: boolean;
  /**
   * La colonna in cui nascerà il task (Todo o Backlog). Facoltativo: le bozze
   * scritte prima che la scelta esistesse non ce l'hanno, e per loro l'assenza
   * vale Todo, cioè quello che il composer faceva sempre.
   */
  status?: TaskStatus;
}

async function uiGet<T>(key: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/ui-state/${key}`); // PANE-01-ALLOWED: draft keys, not pane state
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return (d?.value ?? null) as T | null;
  } catch { return null; }
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
function uiPutDebounced(key: string, value: unknown, ms = 800): void {
  const t = draftTimers.get(key);
  if (t) clearTimeout(t);
  draftTimers.set(key, setTimeout(() => {
    draftTimers.delete(key);
    // PANE-01-ALLOWED: draft keys, not pane state
    fetch(`/api/ui-state/${key}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }).catch(() => {});
  }, ms));
}

const TASK_DRAFTS_KEY = 'board-task-drafts';
const TASK_DRAFTS_CAP = 50;
let taskDraftsCache: Record<string, string> | null = null;

const REVIEW_NOTES_KEY = 'board-review-notes';
/** Più basso del cap delle bozze: una review in sospeso è per definizione una alla volta. */
const REVIEW_NOTES_CAP = 10;
let reviewNotesCache: Record<string, DiffNote[]> | null = null;

export const boardDrafts = {
  getComposer: () => uiGet<ComposerDraft>('board-composer-draft'),
  putComposer: (d: ComposerDraft) => uiPutDebounced('board-composer-draft', d),
  /** Immediate clear (submit) — no debounce window to resurrect the sent text. */
  clearComposer: () => uiPutDebounced('board-composer-draft', { text: '', model: null, prio: null, planFirst: false, status: 'todo' }, 0),

  async getTaskDraft(taskId: string): Promise<string> {
    if (!taskDraftsCache) taskDraftsCache = (await uiGet<Record<string, string>>(TASK_DRAFTS_KEY)) ?? {};
    return taskDraftsCache[taskId] ?? '';
  },
  putTaskDraft(taskId: string, text: string): void {
    if (!taskDraftsCache) taskDraftsCache = {};
    if (text) taskDraftsCache[taskId] = text;
    else delete taskDraftsCache[taskId];
    // Bounded map: drop the oldest entries past the cap (insertion order).
    const keys = Object.keys(taskDraftsCache);
    for (let i = 0; i < keys.length - TASK_DRAFTS_CAP; i++) delete taskDraftsCache[keys[i]];
    uiPutDebounced(TASK_DRAFTS_KEY, taskDraftsCache, text ? 800 : 0);
  },

  /** Note di revisione ancorate al diff, in sospeso finché non si spediscono. */
  async getReviewNotes(taskId: string): Promise<DiffNote[]> {
    if (!reviewNotesCache) reviewNotesCache = (await uiGet<Record<string, DiffNote[]>>(REVIEW_NOTES_KEY)) ?? {};
    return reviewNotesCache[taskId] ?? [];
  },
  putReviewNotes(taskId: string, notes: DiffNote[]): void {
    if (!reviewNotesCache) reviewNotesCache = {};
    if (notes.length) reviewNotesCache[taskId] = notes;
    else delete reviewNotesCache[taskId];
    const keys = Object.keys(reviewNotesCache);
    for (let i = 0; i < keys.length - REVIEW_NOTES_CAP; i++) delete reviewNotesCache[keys[i]];
    // Svuotare è immediato: dopo l'invio non deve esistere una finestra in cui
    // un reload resuscita note già spedite.
    uiPutDebounced(REVIEW_NOTES_KEY, reviewNotesCache, notes.length ? 800 : 0);
  },
};
