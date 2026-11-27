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
import { useMemo, useSyncExternalStore } from 'react';
import { boardApi, boardIdForPath, type BoardProjectRef, type BoardFamilyLink } from './board';
import { unregisteredProjectName } from '../../../shared/project-name';
import { formatProjectFamilyLabel, mergedParentMap, projectFamilyLabel, type ProjectFamilyLabel } from '../../../shared/project-family';
import { subscribeFrames } from './wsFrameBus';

let projects: BoardProjectRef[] | null = null;
/** La cartella dove nascerà un progetto creato per nome: dedotta dal server,
 *  da MOSTRARE prima di creare (è una deduzione, non una configurazione). */
let newProjectDir: string | null = null;
/** Registered projects the picker does not offer (hidden folders): only their
 *  name and icon, so a lane or a chip heads them the way the Plan does. */
let labelOnly: BoardProjectRef[] = [];
/** The projects that sit under another one (accorpa / separa), in board ids. */
let families: BoardFamilyLink[] = [];
let inflight: Promise<BoardProjectRef[] | null> | null = null;
/** Projects created while the index was still `null`: they join the first
 *  answer instead of becoming the index themselves (see `addBoardProject`). */
let addedBeforeIndex: BoardProjectRef[] = [];
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
      const ids = new Set(res.projects.map((p) => p.projectId));
      projects = [...res.projects, ...addedBeforeIndex.filter((p) => !ids.has(p.projectId))].sort(byName);
      addedBeforeIndex = [];
      newProjectDir = res.newProjectDir ?? null;
      labelOnly = res.labelOnly ?? [];
      families = res.families ?? [];
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

/** Resolves with the index once it is known, or null when the fetch failed. */
export function loadBoardProjects(): Promise<BoardProjectRef[] | null> {
  return fetchOnce();
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

const EMPTY_FAMILIES: BoardFamilyLink[] = [];
const getFamilies = (): BoardFamilyLink[] => families;
const getNoFamilies = (): BoardFamilyLink[] => EMPTY_FAMILIES;

/** The family links, reactive. Empty until the index answers, and when nobody has a parent. */
export function useBoardFamilies(enabled = true): BoardFamilyLink[] {
  return useSyncExternalStore(enabled ? subscribeBoardProjects : noopSubscribe, enabled ? getFamilies : getNoFamilies, getNoFamilies);
}

/**
 * Re-reads only the family links. The index is deliberately loaded once per
 * document, but an accorpa / separa change moves cards between boards, so it
 * has to reach every open surface: it is announced by `project:updated`.
 */
let familyRefresh: Promise<void> | null = null;
export function refreshBoardFamilies(): Promise<void> {
  if (familyRefresh) return familyRefresh;
  familyRefresh = (async () => {
    try {
      const res = await boardApi.projects();
      families = res.families ?? [];
      publish();
    } catch { /* the links stay as they were; the next frame tries again */ } finally { familyRefresh = null; }
  })();
  return familyRefresh;
}

let familyFramesArmed = false;
function armFamilyFrames(): void {
  if (familyFramesArmed) return;
  familyFramesArmed = true;
  subscribeFrames(() => { if (projects !== null) void refreshBoardFamilies(); }, { types: ['project:updated', 'project:archived', 'project:deleted'] });
}

export function subscribeBoardProjects(cb: () => void): () => void {
  armFamilyFrames();
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
  // INDEX NOT IN YET: the project waits for the answer, it does not replace
  // it. Writing `[p]` made one project the whole index, and every recovery path
  // (`fetchOnce`, `armRecovery`, the mount) looks at `projects === null`: the
  // picker kept that single project for the life of the document.
  if (projects === null) {
    if (!addedBeforeIndex.some((x) => x.projectId === p.projectId)) addedBeforeIndex.push(p);
    if (!inflight) void fetchOnce();
    return;
  }
  if (projects.some((x) => x.projectId === p.projectId)) return;
  projects = [...projects, p].sort(byName);
  publish();
}

const noopSubscribe = () => () => {};
const getNull = () => null;
const getLabelOnly = (): BoardProjectRef[] => labelOnly;
const getEmpty = (): BoardProjectRef[] => EMPTY_REFS;
const EMPTY_REFS: BoardProjectRef[] = [];

/**
 * The index for NAMING and ICONS: the selectable projects plus the registered
 * ones the picker skips. The grouped board uses it so a lane carries the name
 * the Plan shows for the same project (a project in a hidden folder is not in
 * the picker, and would otherwise be headed by a name guessed from its id).
 * `null` until the first answer, like the index itself.
 */
export function useBoardProjectLabels(enabled = true): BoardProjectRef[] | null {
  const index = useBoardProjects(enabled);
  const extra = useSyncExternalStore(
    enabled ? subscribeBoardProjects : noopSubscribe,
    enabled ? getLabelOnly : getEmpty,
    getEmpty,
  );
  return useMemo(() => (index === null ? null : extra.length === 0 ? index : [...index, ...extra]), [index, extra]);
}

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

/**
 * Il nome di un progetto che nessuno ha registrato vive in `shared/`: lo usa
 * anche il Piano (server), e due funzioni di nome per lo stesso id davano alla
 * corsia e alla tessera due intestazioni diverse. Qui si riesporta perché i
 * chiamanti della Board lo importano da questo store.
 */
export { projectNameFromId, UNKNOWN_PROJECT_NAME } from '../../../shared/project-name';

/**
 * Risolve una lista di `projectId` (quelli che compaiono nei task) in
 * `BoardProjectRef`, usando l'indice per nome e `path` — cioè per l'ICONA — e
 * ricadendo su un ref sintetico (`path: ''`) per gli id che l'indice non
 * conosce, così un progetto sparito dal disco resta comunque filtrabile invece
 * di sparire dall'elenco.
 */
/** The index's own name for a board id, falling back to the id-derived guess. */
function nameOfBoardId(id: string): string {
  const entry = projects?.find((p) => p.projectId === id) ?? labelOnly.find((p) => p.projectId === id);
  return entry?.name ?? unregisteredProjectName(id);
}

/**
 * «Sito Armonia · Nuvola»: the ONE place that turns a board id into the label
 * a person reads, parent-aware. Every surface that named a card by cutting the
 * hash off `task.projectId` (`cloud-sim`, as if it were a project of its own)
 * instead reads this, so a project merged (`accorpa`) into another always
 * says which one it belongs to.
 */
export function familyLabelPartsForId(projectId: string): ProjectFamilyLabel {
  return projectFamilyLabel(projectId, mergedParentMap(families), nameOfBoardId);
}

/** `familyLabelPartsForId`, flattened — for a plain string context (a tooltip, a table cell, a drag-preview subtitle). */
export function familyLabelForId(projectId: string): string {
  return formatProjectFamilyLabel(familyLabelPartsForId(projectId));
}

/** `familyLabelForId`, from a project's path instead of its board id. */
export function familyLabelForPath(path: string): string {
  return familyLabelForId(boardIdForPath(path));
}

/** Reactive `familyLabelPartsForId`, for a component that renders the parent and the child with different weight. */
export function useProjectFamilyLabel(projectId: string, enabled = true): ProjectFamilyLabel {
  const index = useBoardProjectLabels(enabled);
  const links = useBoardFamilies(enabled);
  return useMemo(() => {
    const nameOf = (id: string) => index?.find((p) => p.projectId === id)?.name ?? unregisteredProjectName(id);
    return projectFamilyLabel(projectId, mergedParentMap(links), nameOf);
  }, [index, links, projectId]);
}

/**
 * The ids a cross-project view has to resolve a NAME for: every visible
 * task's project, plus every project the index already knows. A family label
 * («Sito Armonia · Nuvola») needs the PARENT's name too, and a parent with no
 * task of its own in the current filter never shows up among `taskProjectIds`
 * — without the index's ids added in, that parent falls back to its raw board
 * id instead of its name.
 */
export function projectNameIndexIds(
  taskProjectIds: readonly string[],
  index: BoardProjectRef[] | null,
): string[] {
  return [...new Set([...taskProjectIds, ...(index ?? []).map((p) => p.projectId)])];
}

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
      // la stessa funzione del Piano, che dà «Progetto sconosciuto» a un id senza nome.
      return { projectId: id, name: unregisteredProjectName(id), path: '' };
    })
    .sort(byName);
}
