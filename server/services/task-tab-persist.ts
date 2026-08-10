/**
 * task-tab-persist — server-side durability for the browser tabs an AGENT opens
 * while working a dispatched task.
 *
 * Il modello di consegna di un task è «tab del task + file consegnati»: la tab
 * che l'agente apre con `open_browser_pane` È il risultato, quindi deve
 * sopravvivere al turno. Finora non sopravviveva: il fork task-owned in
 * `routes/topics.ts` si limitava a `broadcastToAll({type:"browser:open-task-tab"})`
 * e l'UNICO scrittore del record `task-browser-tabs:<taskId>` era il client
 * (`useTaskBrowserTabsSync` → `taskBrowserTabs.upsertTab` → PUT /api/ui-state).
 * Un dispatch gira in background, spesso senza nessuna finestra Topics aperta:
 * niente client connesso ⇒ nessuno consuma il broadcast ⇒ la tab non viene MAI
 * scritta, e al risveglio dell'app il task arriva in review senza il suo
 * risultato. Qui il server scrive il record da sé, così la tab c'è comunque.
 *
 * Il reducer è un MIRROR di `upsertTab` in `client/src/state/taskBrowserTabs.ts`
 * (stessa forma del record, stessa idempotenza per contextId): i due scrittori
 * convergono sullo stesso valore, quindi il client che riceve anche il proprio
 * `browser:open-task-tab` e ri-PUTta non produce divergenza — solo un seq in più.
 * La scrittura resta last-write-wins (nessun CAS), come il PUT del client.
 */

/** Una tab del gruppo browser posseduto dal task (mirror di `TaskBrowserTab`). */
export interface StoredTaskTab {
  contextId: string;
  url: string;
  title: string;
  seq: number;
  parked?: boolean;
  titleSource?: "auto" | "user";
}

/** Il record `task-browser-tabs:<taskId>` (mirror di `TaskBrowserTabsState`). */
export interface StoredTaskTabs {
  tabs: StoredTaskTab[];
  activeContextId: string | null;
  nextSeq: number;
}

export const EMPTY_TASK_TABS: StoredTaskTabs = { tabs: [], activeContextId: null, nextSeq: 0 };

/** La chiave ui-state per le tab di un task. GEMELLA di `keyFor` nel client. */
export const taskTabsKeyFor = (taskId: string): string => `task-browser-tabs:${taskId}`;

/**
 * Legge un valore ui-state grezzo (JSON già parsato) nella forma canonica.
 * Tollerante come il `sanitizeTaskTabs` del client: qualunque cosa non
 * riconoscibile torna vuota invece di far esplodere il path di apertura.
 */
export function parseTaskTabs(raw: unknown): StoredTaskTabs {
  if (!raw || typeof raw !== "object") return EMPTY_TASK_TABS;
  const o = raw as Record<string, unknown>;
  const src = Array.isArray(o.tabs) ? o.tabs : [];
  const tabs: StoredTaskTab[] = [];
  let maxSeq = -1;
  for (const t of src) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.contextId !== "string" || !r.contextId) continue;
    const seq = typeof r.seq === "number" && Number.isFinite(r.seq) ? r.seq : tabs.length;
    if (seq > maxSeq) maxSeq = seq;
    const tab: StoredTaskTab = {
      contextId: r.contextId,
      url: typeof r.url === "string" ? r.url : "",
      title: typeof r.title === "string" ? r.title : "",
      seq,
    };
    if (r.parked === true) tab.parked = true;
    if (r.titleSource === "user" || r.titleSource === "auto") tab.titleSource = r.titleSource;
    tabs.push(tab);
  }
  const active = typeof o.activeContextId === "string" && tabs.some((t) => t.contextId === o.activeContextId)
    ? (o.activeContextId as string)
    : null;
  const nextSeq = typeof o.nextSeq === "number" && o.nextSeq > maxSeq ? o.nextSeq : maxSeq + 1;
  return { tabs, activeContextId: active, nextSeq };
}

/**
 * Append/riusa la tab sotto un contextId coniato ALTROVE (qui: il fork server).
 * Idempotente: un ctx già presente viene rinfrescato (url/title), UN-parcheggiato
 * e attivato, mai duplicato. Mirror esatto di `upsertTab` nel client.
 */
export function upsertTaskTab(
  state: StoredTaskTabs,
  contextId: string,
  url: string,
  title = "",
): StoredTaskTabs {
  const existing = state.tabs.find((t) => t.contextId === contextId);
  if (existing) {
    return {
      ...state,
      tabs: state.tabs.map((t) =>
        t.contextId === contextId
          ? { ...t, url: url || t.url, title: title || t.title, parked: false }
          : t,
      ),
      activeContextId: contextId,
    };
  }
  const seq = state.nextSeq;
  return {
    tabs: [...state.tabs, { contextId, url, title, seq }],
    activeContextId: contextId,
    nextSeq: seq + 1,
  };
}

/** Il minimo che serve a questo modulo dal db (iniettabile nei test). */
type Db = import("bun:sqlite").Database;

/**
 * Scrive nel record `task-browser-tabs:<taskId>` la tab appena aperta
 * dall'agente e ne broadcasta l'aggiornamento. Best-effort: un errore di
 * persistenza NON deve far fallire l'apertura del browser (il turno dell'agente
 * prosegue, e un client connesso scriverebbe comunque il record).
 *
 * Nessun `sourceClientId` nel broadcast: la scrittura non è di nessun client,
 * quindi TUTTI devono applicarla (il bridge scarta solo l'eco del proprio id).
 *
 * @returns true se il record è stato scritto (false se già identico o in errore).
 */
export function persistAgentTaskTab(
  db: Db,
  // `any` come `purgeTopicFromUiState`: il tipo `OutboundMessage` del server è
  // controvariante sul parametro, quindi un `(msg: unknown) => void` non lo accetta.
  broadcastToAll: (msg: any) => void,
  taskId: string,
  contextId: string,
  url: string,
): boolean {
  if (!taskId || !contextId) return false;
  const key = taskTabsKeyFor(taskId);
  try {
    const outcome = db.transaction((): { value: string; server_seq: number } | null => {
      const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as
        | { value: string }
        | null;
      let current: unknown = null;
      if (row?.value) {
        try { current = JSON.parse(row.value); } catch { current = null; }
      }
      // Ri-normalizzato prima di serializzare: l'upsert (mirror del client)
      // scrive `parked:false` su una tab già viva, che è la stessa cosa di
      // «assente» ma cambierebbe i byte a ogni riapertura identica — e ogni
      // scrittura brucia un server_seq e sveglia tutti i client.
      const next = parseTaskTabs(upsertTaskTab(parseTaskTabs(current), contextId, url));
      const serialized = JSON.stringify(next);
      // Già a posto (riapertura dello stesso url sulla stessa tab attiva): non
      // bruciare un server_seq né svegliare i client con un frame inutile.
      if (row?.value === serialized) return null;
      const { maxSeq } = db.query(
        "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
      ).get() as { maxSeq: number };
      const nextSeq = maxSeq + 1;
      db.run(
        `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
         VALUES (?, ?, 2, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           payload_version = 2,
           server_seq = excluded.server_seq,
           updated_at = datetime('now')`,
        [key, serialized, nextSeq],
      );
      return { value: serialized, server_seq: nextSeq };
      // IMMEDIATE come il PUT di /api/ui-state: due scrittori concorrenti con
      // BEGIN DEFERRED possono leggere lo stesso MAX(server_seq) e collidere.
    }).immediate();
    if (!outcome) return false;
    broadcastToAll({
      type: "ui-state:updated",
      key,
      value: JSON.parse(outcome.value),
      payload_version: 2,
      server_seq: outcome.server_seq,
    });
    return true;
  } catch (err) {
    console.error(`[task-tabs] persist failed for taskId=${taskId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
