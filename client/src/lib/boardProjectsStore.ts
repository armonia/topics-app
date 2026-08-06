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
let inflight: Promise<BoardProjectRef[] | null> | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  listeners.forEach((cb) => cb());
}

const byName = (a: BoardProjectRef, b: BoardProjectRef) => a.name.localeCompare(b.name);

async function fetchOnce(force = false): Promise<BoardProjectRef[] | null> {
  if (!force && projects !== null) return projects;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      projects = (await boardApi.projects()).slice().sort(byName);
    } catch {
      // Una lista vuota è la stessa cosa che «non lo so» per chi rende: il
      // chip ricade su nome-dall'id e nessuna icona, invece di girare per
      // sempre su uno spinner. Il prossimo `reload` riprova.
      projects = [];
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

export function subscribeBoardProjects(cb: () => void): () => void {
  listeners.add(cb);
  if (projects === null && !inflight) void fetchOnce();
  return () => { listeners.delete(cb); };
}

/** Rilegge l'indice dal server (dopo che qualcuno ha creato un progetto fuori da qui). */
export function reloadBoardProjects(): Promise<BoardProjectRef[] | null> {
  return fetchOnce(true);
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

/**
 * Il nome leggibile di un progetto PRIMA che l'indice arrivi (o quando quel
 * progetto non c'è più): l'id della board meno il suffisso di hash. Non è
 * l'icona — quella richiede il `path` e quindi l'indice — ma evita che il chip
 * mostri una stringa con l'hash attaccato.
 */
export function projectNameFromId(projectId: string): string {
  return projectId.replace(/-[^-]+$/, '');
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
    .map((id) => known.get(id) ?? { projectId: id, name: projectNameFromId(id), path: '' })
    .sort(byName);
}
