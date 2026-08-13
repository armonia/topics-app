/**
 * tab-resolver — da un permalink (`/tab/…`, `shared/tab-link.ts`) a una risposta
 * che un AGENTE può usare: che cos'è quella tab, se è ancora aperta, su quale
 * superficie vive, e QUALE tool chiamare dopo per vederne il contenuto.
 *
 * ── Perché esiste, e perché è tre passi e non uno ────────────────────────────
 * Un link non è uno stato. Chi lo riceve ha in mano una CHIAVE (un topicId, un
 * contextId, un path), e tre domande diverse a cui rispondere con tre fonti
 * diverse:
 *
 *   1. GRAMMATICA — `parseTabRef`: la chiave e il tipo. Puro, condiviso col
 *      client e con l'agente, testato una volta sola (`shared/tab-link.test.ts`).
 *   2. PRESENZA — dove sta quella tab, e se è aperta. La verità è in `ui_state`,
 *      sparsa su PIÙ chiavi, e va letta sapendo che metà del contenuto descrive
 *      tab CHIUSE (vedi sotto).
 *   3. CONTENUTO — come si chiama davvero, e dove punta. La verità NON è nella
 *      pane: è in `topics.name`, `tasks.text`, nel roster dei terminali,
 *      nell'inventario dei browser vivi.
 *
 * ── SOLA LETTURA. Senza eccezioni ────────────────────────────────────────────
 * Questo modulo non scrive MAI su `ui_state`. Un PUT dal server prenderebbe un
 * `server_seq` più alto di quello di ogni client vivo e, essendo l'ordine delle
 * SCRITTURE e non della freschezza, riporterebbe indietro tutte le finestre di
 * tutti i dispositivi (è il guasto che il gate CAS `?base=` in routes/ui-state.ts
 * esiste per impedire). Risolvere un link è una domanda, non un comando: chi
 * vuole APRIRE la tab lo fa dal client, che è l'unico scrittore legittimo.
 *
 * ── Le trappole di `ui_state`, tutte già costate un bug ──────────────────────
 * • `pane-store-v2` NON è tutto. La maggioranza delle tab vive dentro le
 *   finestre di progetto, in una riga per progetto
 *   (`topics-project-panes-<djb2>`); leggere solo la chiave app-level le perde
 *   TUTTE. Ci sono poi le tab browser possedute da un task
 *   (`task-browser-tabs:<taskId>`, `task-browser-layout:<taskId>`).
 * • Dentro ogni blob, `closedStack` e `tombstones` descrivono tab CHIUSE — ma
 *   `closedStack` porta url e titolo, quindi letto ingenuamente sembra vivo.
 *   Le pane vive stanno solo in `panes` / `nonChatPanes` / `tabs`.
 * • Una pane presente in `panes` E in `tombstones` è VIVA: il tombstone è
 *   stantìo (riaperta dopo la chiusura, ritrattazione mai arrivata — vedi
 *   `openedAt` in state/pane/types.ts). Le vive si controllano per prime.
 * • L'hash djb2 a 32 bit delle chiavi di progetto ammette collisioni per scelta
 *   documentata (`shared/project-keys.ts`). Quindi: si cerca la pane per
 *   CONTENUTO in tutte le righe di progetto, e la chiave si usa solo per DARE
 *   UN NOME alla superficie — nome che si ricava invertendo l'hash sui path
 *   REALMENTE noti (progetti, worktree, topic). Se l'inversione è ambigua o
 *   vuota, la superficie esce come `project:#<hash>`: il `#` dice a chiare
 *   lettere «questo non è un path», e `pointers.projectPath` resta ASSENTE
 *   invece di essere sbagliato.
 *
 * ── Il titolo NON si legge dalla pane ────────────────────────────────────────
 * `pane.title` è stantìo per costruzione: è il nome al momento dell'apertura, e
 * nessuno lo riscrive quando il soggetto viene rinominato. Sul DB vivo c'è una
 * pane «New Chat» che è il topic «Bozza email Alessio Fulgione». Il titolo esce
 * quindi SOLO dalla fonte autorevole; se quella non risponde, esce l'etichetta
 * neutra di `describeTabTarget` — «non lo so» è una risposta, un titolo
 * sbagliato no.
 *
 * ── Ogni join ha un miss ATTESO ──────────────────────────────────────────────
 * `terminal_sessions` è VUOTA sul DB vivo mentre `ui_state` contiene ancora
 * decine di id `terminal:`. Un roster vuoto NON è autorevole: «sconosciuto» ≠
 * «non esiste». Per questo la presenza (il TAB è aperto) e il contenuto (la
 * sessione è viva) sono due assi separati: un miss di contenuto toglie il
 * titolo, non chiude la tab.
 *
 * ── Mirato su UN ref ─────────────────────────────────────────────────────────
 * Non esiste — e non deve esistere — un `list_all_panes`: riverserebbe nel
 * contesto del modello url, titoli e cwd di ogni finestra aperta. Si risolve il
 * ref che è stato chiesto, e basta.
 *
 * ── Due famiglie di soggetti, due criteri di esistenza ───────────────────────
 * `chat` e `task` sono SERVER-AUTORITATIVI: `topics` e `tasks` sono tabelle, e
 * se la chiave non c'è la chiave è inventata. Lì `unknown` vuol dire davvero
 * «non esiste».
 *
 * `project`, `file` e `diff` NON lo sono, e trattarli allo stesso modo è stato
 * un bug: l'app apre finestre di progetto senza registrare NIENTE sul server
 * (`handleProjectClick` fa `ensurePaneRegistered` + `recent-projects` su
 * localStorage, nessun POST), e alla chiusura `PURGE_ORPHAN_PANE` non lascia né
 * closedStack né tombstone. Una cartella aperta col picker e poi chiusa non
 * lascia dunque nessuna traccia: cercarla in `projects`/`worktrees`/`ui_state`
 * la dichiarava inesistente, e il permalink — che prima funzionava — smetteva
 * di funzionare. Per questa famiglia il criterio giusto è il DISCO: vedi
 * `projectDirOnDisk`.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  parseTabRef,
  describeTabTarget,
  type TabKind,
  type TabTarget,
} from "../../shared/tab-link";
import { projectPanesKey, PROJECT_PANES_PREFIX } from "../../shared/project-keys";
import { projectIdForPath } from "../services/tasks";

// ── Il contratto della risposta ──────────────────────────────────────────────

/**
 * Lo stato del TAB (non del soggetto):
 *   `open`      — la tab è presente fra le pane vive di una superficie.
 *   `closed`    — la tab non è aperta: sta in `closedStack`/`tombstones`, oppure
 *                 il soggetto esiste ma nessuna superficie lo mostra.
 *   `archived`  — il soggetto è archiviato (topic «Chiuso», task/progetto
 *                 archiviato): riaprirlo è possibile, ma non è dove eri.
 *   `unknown`   — non l'abbiamo trovato da nessuna parte E la fonte autorevole
 *                 non risponde (roster vuoto, tabella assente). NON vuol dire
 *                 «non esiste».
 */
export type TabState = "open" | "closed" | "archived" | "unknown";

/** Dove vive la tab. `project:#<hash>` quando il progetto non è più nel
 *  registro e l'hash non si può invertire su un path reale (vedi header). */
export type TabSurface = "app" | `project:${string}` | `task:${string}`;

/** Gli id già risolti, così chi chiama non deve riderivarli dalla chiave. Ogni
 *  campo è presente solo se lo SAPPIAMO: un campo assente è un «non lo so». */
export interface TabPointers {
  topicId?: string;
  sessionKey?: string;
  projectPath?: string;
  filePath?: string;
  contextId?: string;
  taskId?: string;
  cwd?: string;
}

/**
 * Il passo successivo: QUALE tool chiamare per vedere il contenuto.
 *
 * Convenzione di `tool`: un identificatore senza spazi è un tool dell'agente
 * (MCP o control-tool: `read_chat_messages`, `browser_status`, `get_task`, e i
 * tool nativi `Read`/`Bash`); una stringa che inizia con un verbo HTTP è una
 * rotta di questo stesso server, per i casi in cui nessun tool copre il
 * soggetto (il buffer di un terminale, i pannelli). Nessuno dei due è inventato:
 * sono nomi che esistono davvero in `server/mcp/topics-mcp-server.ts`,
 * `server/browser-tool-spec.ts` e nelle rotte.
 */
export interface TabNextStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface ResolvedTab {
  kind: TabKind;
  key: string;
  title: string;
  state: TabState;
  surface: TabSurface;
  pointers: TabPointers;
  next: TabNextStep;
}

export interface TabResolverDeps {
  db: Database;
  /**
   * I context browser headless (CDP/Playwright) — `browserService.listContexts`.
   * Assente ⇒ nessuna informazione, non «nessun browser vivo».
   */
  listBrowserContexts?: () => { id: string; url: string; title: string }[];
  /** Le pane native (WKWebView) registrate — `nativeDelegateRegistry.listDelegated`.
   *  Sono VIVE ma non espongono url/titolo senza un round-trip: qui servono solo
   *  a dire «esiste», e `next` manda l'agente a `browser_status`. */
  listDelegatedContextIds?: () => string[];
  /**
   * Il cwd di un topic secondo la regola UNICA (`server/utils.ts:resolveTopicCwd`:
   * worktree `ready` → altrimenti projectPath). Iniettato per non riscrivere qui
   * una seconda aritmetica che poi diverge; assente (test unitari) si ricade su
   * un equivalente in SQL.
   */
  resolveCwdForTopic?: (topicId: string) => string | null;
}

// ── Letture difensive ────────────────────────────────────────────────────────
//
// Ogni query è avvolta: una tabella che non c'è (DB sintetico, migration non
// ancora applicata) deve degradare in «non lo so», mai far esplodere la rotta.

function safeGet<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  try {
    return (db.query(sql).get(...(params as never[])) as T | null) ?? null;
  } catch {
    return null;
  }
}

function safeAll<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  try {
    return db.query(sql).all(...(params as never[])) as T[];
  } catch {
    return [];
  }
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readUiState(db: Database, key: string): Record<string, unknown> | null {
  const row = safeGet<{ value: string }>(db, "SELECT value FROM ui_state WHERE key = ?", key);
  return row ? parseJson(row.value) : null;
}

function readUiStateLike(db: Database, pattern: string): { key: string; blob: Record<string, unknown> }[] {
  const rows = safeAll<{ key: string; value: string }>(
    db,
    "SELECT key, value FROM ui_state WHERE key LIKE ?",
    pattern,
  );
  const out: { key: string; blob: Record<string, unknown> }[] = [];
  for (const row of rows) {
    const blob = parseJson(row.value);
    if (blob) out.push({ key: row.key, blob });
  }
  return out;
}

const APP_PANE_KEY = "pane-store-v2";
const TASK_TABS_PREFIX = "task-browser-tabs:";
const TASK_LAYOUT_PREFIX = "task-browser-layout:";

// ── Inversione dell'hash di progetto ─────────────────────────────────────────

/**
 * L'universo dei path che il server conosce DAVVERO: progetti registrati,
 * worktree, e i `project_path` dei topic (un topic può stare in una cartella
 * che nessuno ha mai registrato come progetto). È il dominio su cui si
 * INVERTONO gli hash — un hash che non ricade qui dentro non si nomina.
 */
function knownProjectPaths(db: Database): string[] {
  const paths = new Set<string>();
  for (const r of safeAll<{ p: string }>(db, "SELECT path AS p FROM projects")) {
    if (r.p) paths.add(r.p);
  }
  for (const r of safeAll<{ p: string }>(db, "SELECT abs_path AS p FROM worktrees")) {
    if (r.p) paths.add(r.p);
  }
  for (const r of safeAll<{ p: string }>(
    db,
    "SELECT DISTINCT project_path AS p FROM topics WHERE project_path IS NOT NULL AND project_path <> ''",
  )) {
    if (r.p) paths.add(r.p);
  }
  return [...paths];
}

/**
 * `topics-project-panes-<djb2>` → i path che generano QUELLA chiave.
 *
 * Restituisce una LISTA perché djb2 a 32 bit ammette collisioni: chi chiama
 * decide se sa disambiguare, e se non sa non inventa.
 */
function buildProjectKeyIndex(db: Database): Map<string, string[]> {
  const paths = knownProjectPaths(db);
  const index = new Map<string, string[]>();
  for (const p of paths) {
    const key = projectPanesKey(p);
    const list = index.get(key);
    if (list) list.push(p);
    else index.set(key, [p]);
  }
  return index;
}

/**
 * Il nome della superficie per una riga di progetto. `hint` è il path che il
 * link stesso porta (file/diff/browser?in=): se è fra i candidati vince, ed è
 * la disambiguazione di una collisione. Senza hint vale solo un candidato
 * UNICO; altrimenti `#<hash>` — vedi header.
 */
function projectSurface(
  uiKey: string,
  index: Map<string, string[]>,
  hint?: string,
): { surface: TabSurface; projectPath?: string } {
  const candidates = index.get(uiKey) ?? [];
  if (hint && candidates.includes(hint)) return { surface: `project:${hint}`, projectPath: hint };
  if (candidates.length === 1) return { surface: `project:${candidates[0]!}`, projectPath: candidates[0]! };
  const hash = uiKey.slice(PROJECT_PANES_PREFIX.length);
  return { surface: `project:#${hash}` };
}

// ── PRESENZA ─────────────────────────────────────────────────────────────────

type PanePredicate = (pane: Record<string, unknown>) => boolean;

interface Presence {
  state: "open" | "closed";
  surface: TabSurface;
  /** Lo snapshot trovato. Serve per i POINTER (filePath, projectPath, url);
   *  il titolo NON si prende mai da qui. */
  pane?: Record<string, unknown>;
  projectPath?: string;
  taskId?: string;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Cerca la pane, VIVE PRIME. L'ordine è il contratto:
 *   app vive → progetto vive → task vive → chiuse (closedStack/tombstones).
 * Una pane che sta sia fra le vive sia fra i tombstone è viva (tombstone
 * stantìo), ed è per questo che le chiuse si guardano per ultime.
 */
function findPresence(
  db: Database,
  index: Map<string, string[]>,
  match: PanePredicate,
  opts: {
    /** Un chat aperto in una finestra di progetto NON è una pane: è un id in
     *  `openChatTopicIds`. Passato solo per kind 'chat'. */
    projectChatTopicId?: string;
    /** Le tab browser possedute da un task stanno in `task-browser-tabs:<id>`. */
    taskBrowserContextId?: string;
    /** Id di pane da cercare fra i `paneIds` di `task-browser-layout:<id>`. */
    taskLayoutPaneIds?: string[];
    /** Il path di progetto che il link porta con sé (disambigua le collisioni). */
    projectHint?: string;
  } = {},
): Presence | null {
  // 1. App-level: `panes` è l'insieme delle VIVE.
  const app = readUiState(db, APP_PANE_KEY);
  const appPanes = asRecord(app?.panes);
  if (appPanes) {
    for (const pane of Object.values(appPanes)) {
      const rec = asRecord(pane);
      if (rec && match(rec)) return { state: "open", surface: "app", pane: rec };
    }
  }

  // 2. Finestre di progetto: una riga per progetto. Si cerca per CONTENUTO in
  //    tutte, e solo dopo si dà un nome alla chiave (collisioni djb2).
  const projectRows = readUiStateLike(db, `${PROJECT_PANES_PREFIX}%`);
  for (const { key, blob } of projectRows) {
    for (const pane of asRecordArray(blob.nonChatPanes)) {
      if (match(pane)) {
        const { surface, projectPath } = projectSurface(key, index, opts.projectHint);
        return { state: "open", surface, pane, projectPath };
      }
    }
    if (opts.projectChatTopicId && Array.isArray(blob.openChatTopicIds)) {
      if ((blob.openChatTopicIds as unknown[]).includes(opts.projectChatTopicId)) {
        const { surface, projectPath } = projectSurface(key, index, opts.projectHint);
        return { state: "open", surface, projectPath };
      }
    }
  }

  // 3. Tab possedute da un task: l'inventario delle tab browser del drawer, e i
  //    `paneIds` del suo layout (thread/media/browser del task-workspace).
  if (opts.taskBrowserContextId) {
    for (const { key, blob } of readUiStateLike(db, `${TASK_TABS_PREFIX}%`)) {
      for (const tab of asRecordArray(blob.tabs)) {
        if (tab.contextId === opts.taskBrowserContextId) {
          const taskId = key.slice(TASK_TABS_PREFIX.length);
          return { state: "open", surface: `task:${taskId}`, pane: tab, taskId };
        }
      }
    }
  }
  if (opts.taskLayoutPaneIds?.length) {
    const wanted = new Set(opts.taskLayoutPaneIds);
    for (const { key, blob } of readUiStateLike(db, `${TASK_LAYOUT_PREFIX}%`)) {
      for (const group of asRecordArray(blob.groups)) {
        const ids = Array.isArray(group.paneIds) ? (group.paneIds as unknown[]) : [];
        if (ids.some((id) => typeof id === "string" && wanted.has(id))) {
          const taskId = key.slice(TASK_LAYOUT_PREFIX.length);
          return { state: "open", surface: `task:${taskId}`, taskId };
        }
      }
    }
  }

  // 4. CHIUSE. `closedStack` porta url e titolo — letto ingenuamente sembra
  //    vivo, e non lo è. Il record dice anche DOVE stava (`level`/`projectPath`).
  if (app) {
    for (const rec of asRecordArray(app.closedStack)) {
      const pane = asRecord(rec.pane);
      if (!pane || !match(pane)) continue;
      const closedProject = typeof rec.projectPath === "string" ? rec.projectPath : undefined;
      return {
        state: "closed",
        surface: closedProject ? `project:${closedProject}` : "app",
        pane,
        projectPath: closedProject,
      };
    }
    const tombs = asRecord(app.tombstones);
    if (tombs) {
      for (const id of Object.keys(tombs)) {
        if (match({ id })) return { state: "closed", surface: "app" };
      }
    }
  }

  return null;
}

// ── CONTENUTO: le fonti autorevoli ───────────────────────────────────────────

interface TopicRow {
  id: string;
  name: string;
  archived: number;
  session_key: string;
  project_path: string | null;
  worktree_id: string | null;
}

function loadTopic(db: Database, topicId: string): TopicRow | null {
  return safeGet<TopicRow>(
    db,
    "SELECT id, name, archived, session_key, project_path, worktree_id FROM topics WHERE id = ?",
    topicId,
  );
}

/** Il cwd del topic. Preferisce la funzione iniettata (l'unica autorità);
 *  il fallback SQL ne rispecchia la precedenza: worktree `ready`, poi projectPath. */
function topicCwd(db: Database, topic: TopicRow, deps: TabResolverDeps): string | undefined {
  if (deps.resolveCwdForTopic) {
    const injected = deps.resolveCwdForTopic(topic.id);
    if (injected) return injected;
  }
  if (topic.worktree_id) {
    const wt = safeGet<{ abs_path: string; status: string }>(
      db,
      "SELECT abs_path, status FROM worktrees WHERE id = ?",
      topic.worktree_id,
    );
    if (wt && wt.status === "ready" && wt.abs_path) return wt.abs_path;
  }
  return topic.project_path || undefined;
}

interface TerminalRow {
  id: string;
  name: string;
  cwd: string;
  topic_id: string | null;
}

interface TaskRow {
  id: string;
  text: string;
  archived: number;
  project_id: string | null;
  assigned_topic_id: string | null;
}

/**
 * La cartella di un task. `tasks.project_id` NON è `projects.id`: è l'id di
 * BOARD, cioè `projectIdForPath(path)` = `<basename>-<djb2 a 6 cifre>`
 * (server/services/tasks.ts). Un join ingenuo su `projects.id` non trova mai
 * nulla — sul DB vivo il task del board DemoApp porta `demoapp-v1skoz`, che in
 * `projects` non esiste.
 *
 * Anche qui vale «verifica il path, non fidarti della chiave»: si RICALCOLA
 * l'id sui path realmente noti e si accetta solo la corrispondenza univoca.
 * Un id speciale (`_none`, `*`, gli unassigned) semplicemente non ricade su
 * nessun path, e la risposta resta senza `projectPath` invece che sbagliata.
 */
function taskProjectPath(db: Database, projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  // Alcune righe storiche portano direttamente un path assoluto.
  if (projectId.startsWith("/")) return projectId;
  const matches = knownProjectPaths(db).filter((p) => projectIdForPath(p) === projectId);
  if (matches.length === 1) return matches[0];
  // Forma legacy: l'id di board coincideva con `projects.id`.
  const row = safeGet<{ path: string }>(db, "SELECT path FROM projects WHERE id = ?", projectId);
  return row?.path || undefined;
}

// ── I passi successivi (`next`) ──────────────────────────────────────────────

const PANEL_NEXT: Record<string, TabNextStep> = {
  board: { tool: "list_tasks", args: {} },
  agents: { tool: "list_agents", args: {} },
  dashboard: { tool: "GET /api/dashboard/kpis", args: {} },
  activity: { tool: "GET /api/activity/recent", args: {} },
  cron: { tool: "GET /api/cron/jobs", args: {} },
};

const PANEL_TITLE: Record<string, string> = {
  board: "Board",
  agents: "Agents",
  dashboard: "Statistics",
  activity: "Activity",
  cron: "Cron",
};

/** posix basename senza tirarsi dentro `path` (i path qui sono sempre posix). */
function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

function absoluteFilePath(target: TabTarget): string {
  const file = target.key;
  if (file.startsWith("/")) return file;
  const base = (target.projectPath ?? "").replace(/\/+$/, "");
  return base ? `${base}/${file}` : file;
}

// ── Il DISCO come criterio di esistenza (solo per project/file/diff) ─────────

/**
 * Il perimetro della `stat`: quali stringhe hanno il diritto di diventare una
 * domanda al filesystem. PURA, perché è la parte che va fissata da un test —
 * l'esistenza cambia da macchina a macchina, questa regola no.
 *
 * Cosa passa: un path ASSOLUTO e GIÀ NORMALIZZATO. `resolve()` collassa `..`,
 * `.` e gli slash doppi, quindi «il path risolto è identico a quello ricevuto»
 * è la guardia di traversata — la stessa forma che usa `classifyStaticAsset`
 * (confronto sul path RISOLTO, non sulla stringa grezza), qui usata per
 * rifiutare invece che per contenere: un permalink non ha una radice dentro cui
 * stare, ha solo il diritto di non essere una scorciatoia verso altro.
 *
 * Cosa NON passa: relativi (non sono path di progetto), tutto ciò che contiene
 * `..` o un byte NUL, e le stringhe assurdamente lunghe. Un rifiuto qui non è
 * un errore: è «non lo so», che è già lo stato di default.
 */
export function isAddressableProjectPath(candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  const p = candidate.trim();
  if (!p || p.length > 4096) return false;
  if (!p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  // Un solo trailing slash è tollerato (le UI lo producono); il resto deve
  // essere già in forma canonica.
  const bare = p.length > 1 ? p.replace(/\/+$/, "") : p;
  return resolvePath(bare) === bare;
}

/**
 * `true` se quel path è una DIRECTORY esistente.
 *
 * ── Perimetro, perché una `stat` su un endpoint non è mai gratis ────────────
 * Questa è una lettura di SOLA ESISTENZA: non apre, non elenca, non legge un
 * byte, e la risposta non porta niente che non fosse già nella domanda (il
 * titolo è il basename del path che il chiamante ha scritto lui). L'unico bit
 * che esce è `closed` invece di `unknown`.
 *
 * È deliberatamente MENO di ciò che questa stessa origine già concede:
 * `GET /api/projects/icon` fa `existsSync` + `statSync` e risponde 404 PRIMA di
 * consultare la sua allowlist (server/routes/projects.ts) — cioè è già un
 * oracolo di esistenza per qualunque directory, e per giunta poi SERVE dei
 * byte. Qui non si serve niente. Il gate d'accesso è lo stesso per entrambe
 * (`server/lib/auth-gate.ts`: loopback fidato, un peer remoto deve presentare
 * il token di pairing), quindi il confine non si sposta.
 *
 * Perché non un'allowlist come quella delle icone: non funzionerebbe. Il caso
 * legittimo che va servito è ESATTAMENTE quello che nessuna allowlist contiene
 * — una cartella aperta col picker, mai registrata, e con la tab già chiusa
 * (vedi l'header). Un'allowlist qui non sarebbe una difesa, sarebbe il bug.
 */
export function projectDirOnDisk(candidate: string): boolean {
  if (!isAddressableProjectPath(candidate)) return false;
  try {
    return statSync(candidate.replace(/(.)\/+$/, "$1")).isDirectory();
  } catch {
    // Inesistente, permesso negato, symlink rotto: in tutti i casi da qui non
    // arriva nessuna conferma, ed è l'unica cosa che questa funzione promette.
    return false;
  }
}

/**
 * Il progetto `projectPath` esiste, per QUALCHE fonte? UNA funzione, perché
 * `project` e `file`/`diff` devono rispondere alla stessa domanda: il client
 * per un file chiede al server il ref del PROGETTO ospite, non quello del file
 * (`openFileTab` in client/src/lib/tabLink.ts), quindi due criteri diversi
 * vorrebbero dire che lo stesso link è vivo di qua e morto di là.
 *
 * Il DB per primo perché è gratis: un progetto registrato o un worktree
 * restano un soggetto noto anche se la cartella al momento non è montata (un
 * volume esterno, un worktree ancora da creare) — dire `unknown` lì
 * chiuderebbe un link legittimo. Il disco è il secondo criterio, e serve al
 * caso che il DB non può conoscere per costruzione.
 */
function projectSubjectExists(db: Database, projectPath: string): boolean {
  const known = safeGet<{ p: string }>(
    db,
    "SELECT path AS p FROM projects WHERE path = ? UNION ALL SELECT abs_path AS p FROM worktrees WHERE abs_path = ? LIMIT 1",
    projectPath,
    projectPath,
  );
  return !!known || projectDirOnDisk(projectPath);
}

// ── L'ingresso ───────────────────────────────────────────────────────────────

/** `null` se il ref non è un permalink (grammatica). Altrimenti sempre una
 *  risposta: «non lo so» è `state: 'unknown'`, non un errore. */
export function resolveTabRef(ref: string, deps: TabResolverDeps): ResolvedTab | null {
  const target = parseTabRef(ref);
  if (!target) return null;
  return resolveTabTarget(target, deps);
}

export function resolveTabTarget(target: TabTarget, deps: TabResolverDeps): ResolvedTab {
  const { db } = deps;
  const index = buildProjectKeyIndex(db);
  const fallbackTitle = describeTabTarget(target);

  switch (target.kind) {
    case "chat":
      return resolveChat(target, deps, index, fallbackTitle);
    case "terminal":
      return resolveTerminal(target, deps, index, fallbackTitle);
    case "browser":
      return resolveBrowser(target, deps, index, fallbackTitle);
    case "project":
      return resolveProject(target, deps, index, fallbackTitle);
    case "file":
    case "diff":
      return resolveFile(target, deps, index, fallbackTitle);
    case "panel":
      return resolvePanel(target, deps, index);
    case "task":
      return resolveTask(target, deps, fallbackTitle);
    default:
      return {
        kind: target.kind,
        key: target.key,
        title: fallbackTitle,
        state: "unknown",
        surface: "app",
        pointers: {},
        next: { tool: "GET /api/tabs/resolve", args: {} },
      };
  }
}

// ── chat ─────────────────────────────────────────────────────────────────────
//
// Il soggetto è il TOPIC. La stessa chat ha due id di pane — `<topicId>` nudo a
// livello App, `chat:<topicId>` dentro un progetto — e dentro una finestra di
// progetto non è nemmeno una pane, ma un id in `openChatTopicIds`. Tutte e tre
// le forme contano come «aperta».

function resolveChat(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
  fallbackTitle: string,
): ResolvedTab {
  const { db } = deps;
  const topicId = target.key;
  const topic = loadTopic(db, topicId);

  const paneIds = new Set([topicId, `chat:${topicId}`]);
  const presence = findPresence(
    db,
    index,
    (pane) =>
      (typeof pane.id === "string" && paneIds.has(pane.id)) ||
      (pane.type === "chat" && pane.topicId === topicId),
    { projectChatTopicId: topicId },
  );

  const pointers: TabPointers = { topicId };
  if (topic) {
    pointers.sessionKey = topic.session_key;
    if (topic.project_path) pointers.projectPath = topic.project_path;
    const cwd = topicCwd(db, topic, deps);
    if (cwd) pointers.cwd = cwd;
  } else if (presence?.projectPath) {
    pointers.projectPath = presence.projectPath;
  }

  return {
    kind: "chat",
    key: topicId,
    // `topics.name` è l'unica autorità: la pane dice ancora «New Chat» molto
    // dopo che il topic è stato rinominato.
    title: topic ? topic.name : fallbackTitle,
    state: resolveState(topic ? topic.archived === 1 : null, presence, !!topic),
    surface: presence?.surface ?? "app",
    pointers,
    next: { tool: "read_chat_messages", args: { topic_id: topicId } },
  };
}

// ── terminal ─────────────────────────────────────────────────────────────────

function resolveTerminal(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
  fallbackTitle: string,
): ResolvedTab {
  const { db } = deps;
  const sessionId = target.key;
  const paneId = `terminal:${sessionId}`;
  const presence = findPresence(
    db,
    index,
    (pane) =>
      pane.id === paneId ||
      (pane.type === "terminal" && pane.terminalSessionId === sessionId),
  );

  // Miss ATTESO: `terminal_sessions` è vuota sul DB vivo mentre `ui_state`
  // contiene ancora id `terminal:`. Il miss toglie titolo e cwd; NON dice che
  // la tab è chiusa, e non dice che la sessione non esiste.
  const row = safeGet<TerminalRow>(
    db,
    "SELECT id, name, cwd, topic_id FROM terminal_sessions WHERE id = ?",
    sessionId,
  );

  const pointers: TabPointers = {};
  if (row) {
    if (row.cwd) pointers.cwd = row.cwd;
    if (row.topic_id) {
      pointers.topicId = row.topic_id;
      const topic = loadTopic(db, row.topic_id);
      if (topic) pointers.sessionKey = topic.session_key;
    }
  }
  if (presence?.projectPath) pointers.projectPath = presence.projectPath;

  return {
    kind: "terminal",
    key: sessionId,
    title: row ? row.name : fallbackTitle,
    state: resolveState(null, presence, !!row),
    surface: presence?.surface ?? "app",
    pointers,
    next: {
      tool: "GET /api/terminal/sessions/:id/buffer",
      args: { id: sessionId },
    },
  };
}

// ── browser ──────────────────────────────────────────────────────────────────

function resolveBrowser(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
  fallbackTitle: string,
): ResolvedTab {
  const { db } = deps;
  const contextId = target.key;
  const paneId = `browser:${contextId}`;
  const presence = findPresence(
    db,
    index,
    (pane) => pane.id === paneId,
    {
      taskBrowserContextId: contextId,
      taskLayoutPaneIds: [paneId],
      projectHint: target.projectPath,
    },
  );

  // Inventario VIVO: i context headless (che espongono url/titolo) uniti alle
  // pane native registrate (vive, ma senza metadati senza un round-trip — per
  // quelli `next` manda a `browser_status`).
  const contexts = deps.listBrowserContexts?.() ?? [];
  const liveRow = contexts.find((c) => c.id === contextId) ?? null;
  const delegated = deps.listDelegatedContextIds?.().includes(contextId) ?? false;
  const live = !!liveRow || delegated;

  // Le tab browser di un task hanno un inventario proprio, con url e titolo
  // aggiornati dal drawer: è una fonte, non lo snapshot di una pane.
  const taskTab = presence?.taskId ? presence.pane : undefined;

  const pointers: TabPointers = { contextId };
  if (target.projectPath) pointers.projectPath = target.projectPath;
  else if (presence?.projectPath) pointers.projectPath = presence.projectPath;
  const taskId = target.taskId ?? presence?.taskId;
  if (taskId) pointers.taskId = taskId;

  const title =
    (liveRow?.title && liveRow.title.trim()) ||
    (typeof taskTab?.title === "string" && taskTab.title.trim()) ||
    (liveRow?.url && liveRow.url.trim()) ||
    fallbackTitle;

  return {
    kind: "browser",
    key: contextId,
    title,
    // Il context vivo è una fonte di presenza a sé: una pane nativa può essere
    // montata senza che nessuno snapshot l'abbia ancora persistita.
    state: presence ? presence.state : live ? "open" : "unknown",
    surface: presence?.surface ?? (taskId ? `task:${taskId}` : target.projectPath ? `project:${target.projectPath}` : "app"),
    pointers,
    next: live
      ? { tool: "browser_read_screen", args: { contextId } }
      : { tool: "browser_status", args: { contextId } },
  };
}

// ── project ──────────────────────────────────────────────────────────────────

function resolveProject(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
  fallbackTitle: string,
): ResolvedTab {
  const { db } = deps;
  const projectPath = target.key;
  // `createPaneId('project', path)` encoda il path con encodeURIComponent —
  // accettiamo entrambe le forme, perché una pane vecchia può avere l'altra.
  const paneIds = new Set([`project:${encodeURIComponent(projectPath)}`, `project:${projectPath}`]);
  const presence = findPresence(
    db,
    index,
    (pane) =>
      (typeof pane.id === "string" && paneIds.has(pane.id)) ||
      (pane.type === "project" && pane.projectPath === projectPath),
    { projectHint: projectPath },
  );

  const project = safeGet<{ name: string; archived: number }>(
    db,
    "SELECT name, archived FROM projects WHERE path = ?",
    projectPath,
  );
  const worktree = project
    ? null
    : safeGet<{ name: string }>(db, "SELECT name FROM worktrees WHERE abs_path = ?", projectPath);

  // Il DB è la fonte del NOME, non dell'esistenza: se le tabelle non lo
  // conoscono si chiede al disco (vedi `projectSubjectExists`). `project` e
  // `worktree` sono già stati letti qui sopra per il titolo, quindi il ramo
  // gratuito si sfrutta senza rifare la query.
  const subjectFound = !!(project || worktree) || projectDirOnDisk(projectPath);

  return {
    kind: "project",
    key: projectPath,
    title: project?.name ?? worktree?.name ?? baseName(projectPath) ?? fallbackTitle,
    state: resolveState(project ? project.archived === 1 : null, presence, subjectFound),
    surface: presence?.surface ?? "app",
    pointers: { projectPath, cwd: projectPath },
    // «Il cwd»: la cosa utile di una finestra di progetto è la cartella in cui
    // lavorare. `Bash` è il tool nativo che la consuma.
    next: { tool: "Bash", args: { cwd: projectPath } },
  };
}

// ── file / diff ──────────────────────────────────────────────────────────────
//
// Le pane `file` nascono `file:<uuid>` CASUALE a ogni apertura (paneConfig.ts:
// `createPaneId`), quindi il loro id non è indirizzabile: si indirizza il
// CONTENUTO (projectPath + filePath), che è esattamente ciò che la grammatica
// mette nel link. La vista diff è la stessa pane con `diff: true` e id
// deterministico `diff:<filePath relativo>`.

function resolveFile(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
  fallbackTitle: string,
): ResolvedTab {
  const { db } = deps;
  const wantDiff = target.kind === "diff";
  const absolute = absoluteFilePath(target);
  const relative = target.key.startsWith("/") && target.projectPath
    ? target.key.slice(target.projectPath.replace(/\/+$/, "").length + 1)
    : target.key;
  const diffPaneId = `diff:${relative}`;

  const presence = findPresence(
    db,
    index,
    (pane) => {
      if (pane.type !== "file") return false;
      const isDiff = pane.diff === true;
      if (isDiff !== wantDiff) return false;
      if (wantDiff && pane.id === diffPaneId) return true;
      const stored = typeof pane.filePath === "string" ? pane.filePath : null;
      if (!stored) return false;
      return stored === absolute || stored === target.key || stored === relative;
    },
    { projectHint: target.projectPath },
  );

  const pointers: TabPointers = { filePath: absolute };
  if (target.projectPath) {
    pointers.projectPath = target.projectPath;
    pointers.cwd = target.projectPath;
  }

  // Il soggetto di un file è il PROGETTO che lo ospita: è la finestra di
  // progetto che il client deve aprire per arrivarci (la pane del file non è
  // nemmeno indirizzabile — id sorteggiato a ogni apertura). Quindi la domanda
  // di esistenza è la stessa di `resolveProject`, e si fa sulla CARTELLA: se
  // quella non c'è sul disco, il link non porta da nessuna parte e va detto.
  // Il FILE in sé continua a non essere statato: aperto o no, è il passo
  // successivo (`Read`) a dire se c'è — e un file può nascere un attimo dopo
  // dentro un progetto che esiste già.
  const hostMissing = !!target.projectPath && !projectSubjectExists(db, target.projectPath);

  return {
    kind: target.kind,
    key: target.key,
    // Il nome del file È il titolo, e la fonte è il path — non lo snapshot.
    title: baseName(target.key) || fallbackTitle,
    state: presence ? presence.state : hostMissing ? "unknown" : "closed",
    surface:
      presence?.surface ?? (target.projectPath ? `project:${target.projectPath}` : "app"),
    pointers,
    next: { tool: "Read", args: { file_path: absolute } },
  };
}

// ── panel ────────────────────────────────────────────────────────────────────

function resolvePanel(
  target: TabTarget,
  deps: TabResolverDeps,
  index: Map<string, string[]>,
): ResolvedTab {
  const { db } = deps;
  const panel = target.key;
  const paneId = `__${panel}__`;
  const presence = findPresence(db, index, (pane) => pane.id === paneId);

  return {
    kind: "panel",
    key: panel,
    title: PANEL_TITLE[panel] ?? panel,
    // Un pannello è un singleton dell'app: o è aperto, o non lo è. Non esiste
    // uno stato «non lo so» — la sua esistenza non dipende da nessuna fonte.
    state: presence?.state ?? "closed",
    surface: presence?.surface ?? "app",
    pointers: {},
    next: PANEL_NEXT[panel] ?? { tool: "list_tasks", args: {} },
  };
}

// ── task ─────────────────────────────────────────────────────────────────────

function resolveTask(target: TabTarget, deps: TabResolverDeps, fallbackTitle: string): ResolvedTab {
  const { db } = deps;
  const taskId = target.key;
  const task = safeGet<TaskRow>(
    db,
    "SELECT id, text, archived, project_id, assigned_topic_id FROM tasks WHERE id = ?",
    taskId,
  );

  // Un task non è una pane: si apre nel DRAWER della board. La sua «presenza»
  // è il workspace che gli appartiene (`task-browser-layout:<id>`), se c'è.
  const hasWorkspace = !!safeGet<{ key: string }>(
    db,
    "SELECT key FROM ui_state WHERE key = ?",
    `${TASK_LAYOUT_PREFIX}${taskId}`,
  );

  const pointers: TabPointers = { taskId };
  const projectPath = taskProjectPath(db, task?.project_id ?? null);
  if (projectPath) {
    pointers.projectPath = projectPath;
    pointers.cwd = projectPath;
  }
  // Un task dispatchato lavora nel WORKTREE del suo topic, non nel repo: è là
  // che stanno i suoi commit, ed è quello il cwd utile a chi lo riprende.
  if (task?.assigned_topic_id) {
    const topic = loadTopic(db, task.assigned_topic_id);
    if (topic) {
      pointers.topicId = topic.id;
      pointers.sessionKey = topic.session_key;
      const cwd = topicCwd(db, topic, deps);
      if (cwd) pointers.cwd = cwd;
    }
  }

  return {
    kind: "task",
    key: taskId,
    title: task ? task.text : fallbackTitle,
    state: !task ? "unknown" : task.archived === 1 ? "archived" : hasWorkspace ? "open" : "closed",
    surface: `task:${taskId}`,
    pointers,
    next: { tool: "get_task", args: { task_id: taskId } },
  };
}

// ── La regola di stato, in un posto solo ─────────────────────────────────────

/**
 * `archived` (il soggetto è archiviato) batte tutto: una tab aperta su un topic
 * archiviato resta un posto in cui non sei più. Poi vale la presenza. Poi:
 * il soggetto esiste ma nessuna superficie lo mostra ⇒ la tab è CHIUSA; il
 * soggetto non risponde ⇒ `unknown`, che NON vuol dire «non esiste».
 */
function resolveState(
  archived: boolean | null,
  presence: Presence | null,
  subjectFound: boolean,
): TabState {
  if (archived === true) return "archived";
  if (presence) return presence.state;
  return subjectFound ? "closed" : "unknown";
}
