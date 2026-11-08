/**
 * projectTaskCounts — quanti task ha ogni progetto, per stato.
 *
 * Serve al filtro «Progetto» della kanban, che elencava i progetti senza dire
 * quanto lavoro ci fosse dietro ognuno: su una board generale con dodici
 * progetti la lista era un indice di nomi, e per sapere quale stesse aspettando
 * qualcosa bisognava accenderli uno alla volta.
 *
 * L'aritmetica sta QUI, fuori dal disegno, per la stessa ragione di
 * `boardTabCounts`: è la parte verificabile senza montare niente, e le due
 * superfici che la leggono (i chip in barra e le righe del menu) devono contare
 * allo stesso modo.
 *
 * La chiave non è `t.projectId` ma una funzione, perché il filtro raggruppa i
 * task «senza progetto» — che sul server sono di due specie — sotto una riga
 * sola: chi conta deve poter dire come si raggruppa.
 */
import type { BoardTask, TaskStatus } from './board';

export interface ProjectCounts {
  /** In attesa di un umano. */
  review: number;
  /** Un agente ci sta lavorando adesso. */
  inProgress: number;
  /** In coda: backlog + todo. */
  queued: number;
  /** Tutto ciò che non è chiuso: review + in corso + in coda. */
  open: number;
  done: number;
  total: number;
}

const EMPTY = (): ProjectCounts => ({ review: 0, inProgress: 0, queued: 0, open: 0, done: 0, total: 0 });

const BUCKET: Record<TaskStatus, keyof ProjectCounts> = {
  backlog: 'queued',
  todo: 'queued',
  in_progress: 'inProgress',
  review: 'review',
  done: 'done',
};

/**
 * I conteggi per ogni chiave prodotta da `keyOf`. I progetti senza nemmeno un
 * task non compaiono: la lista del filtro nasce dai task, quindi una chiave
 * assente vuol dire che quel progetto non è nemmeno in lista.
 */
export function projectTaskCounts(
  tasks: readonly BoardTask[] | null | undefined,
  keyOf: (t: BoardTask) => string,
): Record<string, ProjectCounts> {
  const out: Record<string, ProjectCounts> = {};
  for (const t of tasks ?? []) {
    const key = keyOf(t);
    const c = (out[key] ??= EMPTY());
    const bucket = BUCKET[t.status];
    if (bucket === undefined) continue;
    c[bucket]++;
    c.total++;
    if (t.status !== 'done') c.open++;
  }
  return out;
}

/**
 * La riga di spiegazione completa, per il `title`: tutti e cinque gli stati,
 * zeri compresi. Il disegno mostra solo ciò che conta, ma chi si ferma col
 * mouse sta chiedendo il dettaglio, e lì un «backlog: 0» è una risposta.
 */
export function countsSummary(c: ProjectCounts, label: Record<TaskStatus, string>): string {
  return [
    `${label.review}: ${c.review}`,
    `${label.in_progress}: ${c.inProgress}`,
    `in coda: ${c.queued}`,
    `${label.done}: ${c.done}`,
  ].join(' · ');
}
