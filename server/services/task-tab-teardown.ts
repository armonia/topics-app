/**
 * Le tab di un task ARCHIVIATO si smontano — record `ui_state` compresi.
 *
 * PERCHÉ ESISTE. `task-browser-tabs:<id>` e `task-browser-layout:<id>` nascono
 * quando un task apre un browser e non muoiono MAI: un task non si cancella, si
 * archivia (soft-delete), quindi non c'è nessun hard-delete a cui agganciare la
 * pulizia. Misurato sul db vivo l'11/08: 91 record `task-browser-*` su 172 righe
 * di `ui_state` (31 KB su 101 KB) — erano 75 su 155 (21 KB su 87 KB) il giorno
 * prima, da quando il server scrive il record da sé (`task-tab-persist.ts`)
 * anche senza nessun client che guarda.
 *
 * Il costo di rete di quei record è stato tolto a monte: l'`ui-state:init` non
 * porta più i due prefissi (`UI_STATE_INIT_EXCLUDED_PREFIXES` in
 * `routes/ui-state.ts`), quindi una riga in più non è più un pezzo di payload a
 * ogni riconnessione di ogni client. Restano il disco, il contesto browser vivo
 * dietro la tab e il rumore — che è ciò che questa purga chiude.
 *
 * COSA GARANTISCE. Dopo `purgeTaskBrowserState` su un task:
 *   1. le sue due chiavi `ui_state` non esistono più,
 *   2. i contesti browser dietro le sue tab (e i gemelli `_ws` nel workspace)
 *      sono distrutti lato server e chiusi su ogni device (`browser:close-pane`),
 *   3. i client che stanno guardando dimenticano la chiave — glielo dice il
 *      `task:deleted` che la rotta emette con l'intero sottoalbero.
 *
 * SOLO ARCHIVIATI. Un task `done` NON archiviato conserva tutto: la tab è la sua
 * consegna, e finché la card sta sulla board la si deve poter riaprire. È anche
 * il motivo per cui, oggi, la resa di questa purga è piccola (84 delle 91 righe
 * misurate appartengono a task `done` non archiviati): qui si tappa la falla,
 * non si recupera il pregresso.
 *
 * CONVERGENTE, come `archive-topic.ts`. Ri-archiviare deve RIPARARE: la purga è
 * idempotente e `sweepArchivedTaskBrowserState` la ripassa al boot su tutto ciò
 * che è già archiviato — è l'unica strada che i record trapelati prima di questo
 * codice hanno per tornare a posto senza una query a mano.
 *
 * NIENTE TOMBSTONE, qui. Il tombstone serve dove la cancellazione deve battere
 * una riscrittura concorrente su un documento condiviso (`pane-store-v2`).
 * Questi record sono per-task e il task è appena uscito dalla board: una riga
 * svuotata invece che cancellata resterebbe nello snapshot, cioè esattamente il
 * costo che stiamo togliendo. La rete di sicurezza contro una resurrezione è
 * doppia: il client dimentica la chiave sul `task:deleted`, e il ripasso al boot
 * ricancella quel che dovesse ricomparire.
 */
import type { Database } from "bun:sqlite";
import { parseTaskTabs } from "./task-tab-persist";
import { workspaceTwinContextId } from "../../shared/task-tab-context";

export const TASK_TABS_PREFIX = "task-browser-tabs:";
export const TASK_LAYOUT_PREFIX = "task-browser-layout:";

/** Le due chiavi `ui_state` possedute da un task. */
export function taskBrowserKeysFor(taskId: string): string[] {
  return [`${TASK_TABS_PREFIX}${taskId}`, `${TASK_LAYOUT_PREFIX}${taskId}`];
}

export interface TaskTabTeardownDeps {
  db: Database;
  /**
   * `broadcastToAll`. Assente ⇒ nessun frame (è il caso del ripasso al boot:
   * non c'è ancora nessun client, e i contesti browser non esistono).
   */
  broadcastToAll?: (msg: any) => void;
  /**
   * `browserService.destroyContext`. Best-effort e non attesa: un contesto che
   * non è mai esistito (pane nativa, tab mai aperta davvero) rifiuta e non deve
   * far fallire l'archiviazione.
   */
  destroyContext?: (contextId: string) => Promise<void> | void;
}

export interface TaskTabTeardownReport {
  /** I task effettivamente toccati (root + sottoalbero, o l'esito del ripasso). */
  taskIds: string[];
  /** Le chiavi `ui_state` cancellate. */
  keysDeleted: string[];
  /** Byte di `key + value` liberati — è la misura che conta, non le righe. */
  bytesFreed: number;
  /** I contextId rilasciati (tab + gemelli `_ws`), nell'ordine in cui li abbiamo chiusi. */
  contextsReleased: string[];
}

const EMPTY_REPORT: TaskTabTeardownReport = {
  taskIds: [],
  keysDeleted: [],
  bytesFreed: 0,
  contextsReleased: [],
};

/**
 * Il task e tutti i suoi discendenti, a qualunque profondità — lo STESSO
 * sottoalbero che `tasks.archive` archivia in cascata. Le righe ci sono ancora
 * (archiviare è un soft-delete), quindi la query vale prima e dopo.
 */
export function taskSubtreeIds(db: Database, taskId: string): string[] {
  if (!taskId) return [];
  const rows = db
    .query(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
       )
       SELECT id FROM subtree`,
    )
    .all(taskId) as { id: string }[];
  const ids = rows.map((r) => r.id);
  // Un id che non è (più) nella tabella non ha sottoalbero, ma può avere le sue
  // due chiavi: la purga deve poterlo comunque ripulire.
  return ids.length ? ids : [taskId];
}

/**
 * Cancella le due chiavi `ui_state` dei task indicati e rilascia i contesti
 * browser che ci trovava dentro.
 *
 * Sincrona sul database (una sola transazione IMMEDIATE, come ogni scrittura di
 * `ui_state`), best-effort su tutto il resto: broadcast e `destroyContext`
 * partono dopo il commit e non vengono attesi.
 */
export function purgeTaskBrowserState(
  deps: TaskTabTeardownDeps,
  taskIds: readonly string[],
): TaskTabTeardownReport {
  const ids = [...new Set(taskIds.filter((id): id is string => !!id))];
  if (!ids.length) return { ...EMPTY_REPORT };

  const keys = ids.flatMap(taskBrowserKeysFor);
  const placeholders = keys.map(() => "?").join(",");

  let found: { key: string; value: string }[] = [];
  try {
    found = deps.db
      .transaction(() => {
        const rows = deps.db
          .query(`SELECT key, value FROM ui_state WHERE key IN (${placeholders})`)
          .all(...keys) as { key: string; value: string }[];
        if (!rows.length) return [];
        deps.db.run(`DELETE FROM ui_state WHERE key IN (${placeholders})`, keys);
        return rows;
      })
      .immediate();
  } catch (err) {
    // Non si ingoia, ma non si fa fallire l'archiviazione: il task È archiviato,
    // e il ripasso al boot ripasserà di qui. Fallire qui e basta lascerebbe la
    // board coerente e il registro sporco, senza che nessuno lo sappia.
    console.error(
      `[task-tabs] teardown fallito per taskIds=${ids.join(",")}:`,
      err instanceof Error ? err.message : err,
    );
    return { ...EMPTY_REPORT, taskIds: ids };
  }

  if (!found.length) return { ...EMPTY_REPORT, taskIds: ids };

  // I contesti da rilasciare stanno DENTRO il record delle tab: una volta
  // cancellata la riga nessuno sa più che esistevano, quindi vanno letti prima
  // (sopra, nella transazione) e chiusi qui.
  const contexts: string[] = [];
  for (const row of found) {
    if (!row.key.startsWith(TASK_TABS_PREFIX)) continue;
    let parsed: unknown = null;
    try { parsed = JSON.parse(row.value); } catch { continue; }
    for (const tab of parseTaskTabs(parsed).tabs) {
      contexts.push(tab.contextId);
      // Il gemello nel workspace è una SECONDA view viva sullo stesso contenuto
      // (`shared/task-tab-context.ts`): chiudere solo la tab lo lascerebbe lì.
      contexts.push(workspaceTwinContextId(tab.contextId));
    }
  }

  for (const contextId of contexts) {
    // Prima la chiusura sui device (è la stessa strada di
    // `POST /api/.../browser/close-pane`), poi il contesto headless.
    try { deps.broadcastToAll?.({ type: "browser:close-pane", contextId }); } catch { /* best-effort */ }
    try {
      const p = deps.destroyContext?.(contextId);
      if (p && typeof (p as Promise<void>).catch === "function") {
        void (p as Promise<void>).catch(() => { /* nessun contesto headless: pane nativa */ });
      }
    } catch { /* idem */ }
  }

  return {
    taskIds: ids,
    keysDeleted: found.map((r) => r.key),
    bytesFreed: found.reduce((n, r) => n + r.key.length + r.value.length, 0),
    contextsReleased: contexts,
  };
}

/**
 * L'aggancio dell'archiviazione: purga il task E tutto il suo sottoalbero.
 * Restituisce anche gli id toccati, che la rotta mette nel `task:deleted` così
 * i client dimenticano le chiavi invece di ri-PUTtarle dal loro debounce.
 */
export function teardownArchivedTaskBrowserState(
  deps: TaskTabTeardownDeps,
  taskId: string,
): TaskTabTeardownReport {
  return purgeTaskBrowserState(deps, taskSubtreeIds(deps.db, taskId));
}

/**
 * Il ripasso al boot: ogni chiave `task-browser-*` il cui task è archiviato (o
 * non esiste più) se ne va. È il backstop che ripara il pregresso e qualunque
 * record risuscitato da un client disconnesso durante l'archiviazione.
 *
 * Il ramo "task inesistente" si spegne da solo se la tabella `tasks` è vuota:
 * un database senza task non deve trasformare TUTTE le chiavi in orfane.
 */
export function sweepArchivedTaskBrowserState(deps: TaskTabTeardownDeps): TaskTabTeardownReport {
  const rows = deps.db
    .query(
      `SELECT key FROM ui_state WHERE key LIKE '${TASK_TABS_PREFIX}%' OR key LIKE '${TASK_LAYOUT_PREFIX}%'`,
    )
    .all() as { key: string }[];
  if (!rows.length) return { ...EMPTY_REPORT };

  const { total } = deps.db.query("SELECT COUNT(*) AS total FROM tasks").get() as { total: number };

  const candidates = new Set<string>();
  for (const { key } of rows) {
    const id = key.startsWith(TASK_TABS_PREFIX)
      ? key.slice(TASK_TABS_PREFIX.length)
      : key.slice(TASK_LAYOUT_PREFIX.length);
    if (id) candidates.add(id);
  }

  const doomed: string[] = [];
  for (const id of candidates) {
    const row = deps.db.query("SELECT archived FROM tasks WHERE id = ?").get(id) as
      | { archived: number }
      | null;
    if (row) {
      if (row.archived) doomed.push(id);
    } else if (total > 0) {
      doomed.push(id);
    }
  }

  return purgeTaskBrowserState(deps, doomed);
}
