/**
 * boardProjectsStore — l'INDICE dei progetti della board (`GET
 * /api/all-boards/projects`), condiviso da ogni superficie che sceglie o
 * filtra un progetto: il composer del task, l'header del drawer di dettaglio,
 * il filtro «Progetto» della kanban.
 *
 * Perché uno store e non una fetch per componente. L'indice è l'UNICO posto da
 * cui si ricava il `path` di un progetto, e senza `path` non c'è icona
 * (`ProjectFavicon` la risolve dal percorso). Finché ogni superficie se lo
 * caricava da sola, la superficie che caricava TARDI mostrava il nome ma non
 * l'icona: il chip del composer chiamava `loadProjects()` solo al focus o
 * all'apertura del menu, quindi con una bozza ripristinata — che espande il
 * composer senza alcun focus — il chip restava per sempre col pallino di
 * ripiego, mentre il drawer, che fetcha al mount, l'icona ce l'aveva. Stesso
 * progetto, due superfici, due risposte diverse.
 *
 * Qui l'indice si carica una volta sola (single-flight), lo tengono tutti, e
 * un progetto appena creato entra nella lista per TUTTI i sottoscrittori nello
 * stesso istante.
 */
import { useSyncExternalStore } from 'react';
import { boardApi, type BoardProjectRef } from './board';

let projects: BoardProjectRef[] | null = null;
/** La cartella dove nascerà un progetto creato per nome: dedotta dal server,
 *  da MOSTRARE prima di creare (è una deduzione, non una configurazione). */
let newProjectDir: string | null = null;
let inflight: Promise<BoardProjectRef[] | null> | null = null;
const listeners = new Set<() => void>();
/**
 * Quando l'ultima fetch è FALLITA, e il ritardo prima di riprovare.
 *
 * Serve perché questo indice è l'UNICO posto da cui esce il `path` su disco di
 * un progetto, e senza path non c'è icona (`ProjectFavicon` con `path` vuoto non
 * rende niente, per decisione). Prima, un errore scriveva `projects = []` — che
 * per chi legge è indistinguibile da «nessun progetto» — e da quel momento la
 * guardia `projects === null` non scattava più, e non restava nessun'altra
 * strada per ricostruirlo: l'indice era perso per la VITA DEL DOCUMENTO.
 *
 * Non è teorico e non è raro: misurato sul server di produzione, `…/tasks` fa
 * 88.936 richieste contro 318 di `…/projects`, cioè 280:1. I task si riprendono
 * da soli a ogni giro, questo indice aveva UNA occasione. Su una PWA installata
 * — un documento longevo che iOS congela e riprende, e che parla al Mac via
 * LAN — quell'unica occasione cade dentro un Wi-Fi che salta, una ripresa fuori
 * rete o uno dei riavvii graceful del server, e le icone non tornano più.
 */
let lastFailAt = 0;
/** Corto: la finestra di guasto tipica è un riavvio del server o un cambio di
 *  rete, cioè secondi. Non è un backoff crescente perché non c'è una raffica da
 *  contenere: il ritentativo parte da un montaggio o da un risveglio, eventi
 *  che l'utente genera uno alla volta. */
const RETRY_AFTER_MS = 3000;

function publish(): void {
  listeners.forEach((cb) => cb());
}

const byName = (a: BoardProjectRef, b: BoardProjectRef) => a.name.localeCompare(b.name);

/**
 * L'indice, caricato UNA volta per vita del documento (single-flight).
 *
 * Non esiste un ricarico forzato, e non è una dimenticanza: l'unico modo di
 * invalidare l'indice dall'interno dell'app è creare un progetto, e quella
 * strada lo aggiorna sul posto (`addBoardProject`) invece di rifare il giro.
 * Chi legge questo store lo fa per il `path` — cioè per l'icona — e un
 * ricarico periodico costerebbe richieste a ogni risveglio senza cambiare
 * niente: `armRecovery` infatti riprova solo quando l'indice NON c'è.
 */
async function fetchOnce(): Promise<BoardProjectRef[] | null> {
  if (projects !== null) return projects;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await boardApi.projects();
      projects = res.projects.slice().sort(byName);
      newProjectDir = res.newProjectDir ?? null;
      lastFailAt = 0;
    } catch {
      // «NON LO SO» RESTA null, e non diventa una lista vuota.
      //
      // Per chi RENDE le due cose si comportano uguale — la pastiglia ricade su
      // nome-dall'id e nessuna icona, mai uno spinner infinito, che è
      // l'invariante che questo ramo difende. Ma per lo STORE sono opposte:
      // `[]` è una risposta, `null` è una domanda aperta. Scrivendo `[]` la
      // guardia in `subscribeBoardProjects` non scattava mai più e l'indice
      // moriva col documento (vedi `lastFailAt`).
      lastFailAt = Date.now();
    } finally {
      inflight = null;
    }
    publish();
    return projects;
  })();
  return inflight;
}

/** L'indice, o `null` finché la prima fetch non è tornata. */
export function getBoardProjects(): BoardProjectRef[] | null {
  return projects;
}

/** La cartella dove finirebbe un progetto creato per nome (`null` prima della
 *  prima fetch, o se il server non sa dirlo). */
export function getNewProjectDir(): string | null {
  return newProjectDir;
}

/** Reattivo, per la riga «Crea "x"… in <cartella>». */
export function useNewProjectDir(enabled = true): string | null {
  return useSyncExternalStore(
    enabled ? subscribeBoardProjects : noopSubscribe,
    enabled ? getNewProjectDir : getNull,
    getNull,
  );
}

/**
 * LA PORTA DI RIENTRO, e sta QUI e non nel hook del socket.
 *
 * Gli istanti che significano «la rete è tornata / l'app si è risvegliata» sono
 * gli unici in cui un documento longevo — la PWA installata, che iOS congela e
 * riprende invece di ricaricare — può recuperare un indice perso. L'app li
 * ascolta già in `useWebSocket`, ma agganciarsi là vorrebbe dire infilare questa
 * preoccupazione dentro la logica del socket, che ha le sue uscite anticipate
 * (`reconnectNow` esce subito se la socket è già aperta — e l'indice può essere
 * perso con la socket sanissima). Lo store si ripara da sé: i listener si
 * montano al primo sottoscrittore e restano, perché sono globali per documento e
 * non per componente.
 *
 * Non fa niente quando l'indice c'è: `fetchOnce` esce subito.
 */
let recoveryArmed = false;
function armRecovery(): void {
  // La guardia chiede le capacità che il corpo USA — e sono su DUE oggetti:
  // il primo aggancio è su `document`, gli altri due su `window`. Controllare
  // solo l'esistenza di `document` lasciava passare sia il caso "document
  // parziale" (stub dei test) sia il caso "window assente".
  if (
    recoveryArmed ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function' ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) return;
  recoveryArmed = true;
  const recover = () => {
    if (document.hidden) return;
    if (projects === null && !inflight) void fetchOnce();
  };
  document.addEventListener('visibilitychange', recover);
  window.addEventListener('online', recover);
  window.addEventListener('focus', recover);
}

export function subscribeBoardProjects(cb: () => void): () => void {
  listeners.add(cb);
  armRecovery();
  // Un montaggio è già un ritentativo: se l'indice non c'è e l'ultimo tentativo
  // è fallito da più di `RETRY_AFTER_MS`, si riprova. Prima bastava che il
  // primo tentativo fallisse perché nessun montaggio successivo provasse più.
  if (projects === null && !inflight && Date.now() - lastFailAt >= RETRY_AFTER_MS) void fetchOnce();
  return () => { listeners.delete(cb); };
}

/**
 * Inserisce un progetto appena creato senza aspettare un altro giro sul
 * server. Idempotente: se l'id c'è già la lista non cambia (né identità né
 * ordine), così un doppio invio non fa lampeggiare i menu aperti.
 */
export function addBoardProject(p: BoardProjectRef): void {
  if (projects?.some((x) => x.projectId === p.projectId)) return;
  projects = [...(projects ?? []), p].sort(byName);
  publish();
}

const noopSubscribe = () => () => {};
const getNull = () => null;

/**
 * L'indice dei progetti, reattivo.
 *
 * `enabled=false` non sottoscrive e non fa partire nessuna fetch — serve alle
 * superfici che il selettore non lo mostrano affatto (il composer dentro una
 * board di progetto, dove il progetto è implicito).
 */
export function useBoardProjects(enabled = true): BoardProjectRef[] | null {
  return useSyncExternalStore(
    enabled ? subscribeBoardProjects : noopSubscribe,
    enabled ? getBoardProjects : getNull,
    getNull,
  );
}

/** Cosa si scrive quando il progetto non si sa quale sia. Una frase, non un
 *  codice: chi legge deve capire che manca un dato, non decifrarlo. */
export const UNKNOWN_PROJECT_NAME = 'Progetto sconosciuto';

/** Un UUID: otto-quattro-quattro-quattro-dodici cifre esadecimali. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Il nome leggibile di un progetto PRIMA che l'indice arrivi (o quando quel
 * progetto non c'è più): l'id della board meno il suffisso di hash. Non è
 * l'icona — quella richiede il `path` e quindi l'indice — ma evita che il chip
 * mostri una stringa con l'hash attaccato.
 *
 * UN UUID NON HA UN NOME DENTRO, e togliergli l'ultimo pezzo non lo rende
 * leggibile: `405fbb0d-6fdd-4874-b52d-ce96180f9e2a` diventava
 * `405fbb0d-6fdd-4874-b52d`, che è lo stesso codice con quattro cifre in meno.
 * Segnalato: «vedo nei filtri un progetto con un codice strano. Non dovrei mai
 * vedere un codice, perché è incomprensibile».
 *
 * Un id del genere arriva da un task che punta a un progetto che l'indice non
 * conosce (misurato: uno su quindici, un progetto mai registrato). In quel caso
 * l'unica cosa onesta è dire che il progetto non si sa quale sia, invece di
 * spacciare un frammento di esadecimale per un nome.
 *
 * `null` e non una stringa: il chiamante deve poter decidere COME dirlo, e
 * `String(null)` a schermo sarebbe peggio dell'UUID.
 */
export function projectNameFromId(projectId: string): string | null {
  if (UUID.test(projectId)) return null;
  const withoutHash = projectId.replace(/-[^-]+$/, '');
  // Un id tutto esadecimale anche dopo il taglio non è un nome: stessa ragione.
  return /^[0-9a-f-]{12,}$/i.test(withoutHash) ? null : withoutHash;
}

/**
 * Risolve una lista di `projectId` (quelli che compaiono nei task) in
 * `BoardProjectRef`, usando l'indice per nome e `path` — cioè per l'ICONA — e
 * ricadendo su un ref sintetico (`path: ''`) per gli id che l'indice non
 * conosce, così un progetto sparito dal disco resta comunque filtrabile invece
 * di sparire dall'elenco.
 */
export function resolveProjectRefs(
  ids: readonly string[],
  index: BoardProjectRef[] | null,
): BoardProjectRef[] {
  const known = new Map((index ?? []).map((p) => [p.projectId, p]));
  return ids
    .map((id) => {
      const noto = known.get(id);
      if (noto) return noto;
      // Un progetto che l'indice non conosce resta FILTRABILE - sparire
      // dall'elenco nasconderebbe i suoi task - ma non si inventa un nome:
      // `null` diventa «Progetto sconosciuto» dove si disegna.
      const nome = projectNameFromId(id);
      return { projectId: id, name: nome ?? UNKNOWN_PROJECT_NAME, path: '' };
    })
    .sort(byName);
}
