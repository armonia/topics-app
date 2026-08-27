import { TASK_STATUSES, type TaskStatus } from "./board";

/** Il minimo che serve alla tray: il contratto della card sta in `board.ts`,
 *  ma il guscio non ha bisogno di conoscerlo tutto per disegnare una riga. */
export interface TrayTaskInput {
  id: string;
  text: string;
  status: string;
  projectId: string;
}

/**
 * Il menu della tray, dal lato dei DATI.
 *
 * Oggi la tray dice solo le chat che aspettano una risposta. I task della board
 * non ci sono: per sapere che c'è una card in review si apre la app. Questa è la
 * parte che si può decidere e provare senza toccare il Rust — quale roba va nel
 * menu, in che ordine, con che etichetta — e sta qui, condivisa, per la stessa
 * ragione per cui ci sta il resto del contratto della board: il menu nativo lo
 * costruisce il guscio, ma COSA ci va dentro lo decide un posto solo.
 *
 * L'ordine dei gruppi NON è alfabetico e non è quello delle colonne: è quello
 * dell'urgenza per chi guarda una tray. Prima ciò che aspetta una decisione
 * (`review`), poi ciò che sta correndo (`in_progress`), poi la coda. `backlog` e
 * `done` non entrano: il primo non è lavoro in corso, il secondo è finito, e una
 * tray che elenca tutto smette di essere un richiamo e diventa una seconda board.
 */
export const TRAY_GROUP_ORDER = ["review", "in_progress", "todo"] as const;
export type TrayGroupStatus = (typeof TRAY_GROUP_ORDER)[number];

/** Quante righe per gruppo. Oltre, il menu diventa una lista da scorrere. */
export const TRAY_ROWS_PER_GROUP = 5;

export interface TrayRow {
  /** Il task da aprire col deep-link. */
  id: string;
  title: string;
  /** Il progetto, per la riga: due card omonime su board diverse capitano. */
  projectId: string;
}

export interface TrayGroup {
  status: TrayGroupStatus;
  /** TUTTI i task del gruppo, anche quelli che non entrano fra le righe. */
  count: number;
  rows: TrayRow[];
}

/** Un titolo che sta in una riga di menu, senza tagliare a metà una parola. */
export function trayTitle(text: string, max = 44): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const tagliato = t.slice(0, max - 1);
  const spazio = tagliato.lastIndexOf(" ");
  // Sotto i due terzi il taglio sulla parola perde troppo: meglio spezzare.
  return `${(spazio > max * 0.6 ? tagliato.slice(0, spazio) : tagliato).trimEnd()}…`;
}

/**
 * I task aperti raggruppati per stato, pronti per il menu.
 *
 * PURA e senza I/O: prende la stessa lista che alimenta i badge in-app
 * (`useGlobalBoard` / `boardTasksStore`) e la riduce. Un gruppo VUOTO non esce:
 * una voce «Review (0)» nel menu è rumore che si legge come un difetto.
 */
export function trayBoardGroups(
  tasks: readonly TrayTaskInput[],
  opts: { rowsPerGroup?: number } = {},
): TrayGroup[] {
  const perGroup = Math.max(1, opts.rowsPerGroup ?? TRAY_ROWS_PER_GROUP);
  const out: TrayGroup[] = [];
  for (const status of TRAY_GROUP_ORDER) {
    const miei = tasks.filter((t) => t.status === status);
    if (miei.length === 0) continue;
    out.push({
      status,
      count: miei.length,
      rows: miei.slice(0, perGroup).map((t) => ({
        id: t.id,
        title: trayTitle(t.text),
        projectId: t.projectId,
      })),
    });
  }
  return out;
}

/** Il totale che va sul glifo: le righe che chiedono qualcosa a un umano. */
export function trayBoardAttention(groups: readonly TrayGroup[]): number {
  return groups.find((g) => g.status === "review")?.count ?? 0;
}

/** Gli stati che la tray NON mostra, dichiarati invece che dedotti dal filtro. */
export const TRAY_HIDDEN_STATUSES: readonly TaskStatus[] =
  TASK_STATUSES.filter((s): s is TaskStatus => !(TRAY_GROUP_ORDER as readonly string[]).includes(s));
