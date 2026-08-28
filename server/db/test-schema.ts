import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Pezzi di schema che PIÙ harness di test devono creare a mano.
 *
 * Gli harness della board costruiscono un DB in memoria con una DDL scritta a
 * mano — una copia per file, una decina di copie in tutto. Finché ogni tabella
 * la toccava un test solo, la duplicazione costava poco. `task_labels`
 * (migration 100) no: `rowToTask` la legge per OGNI riga, quindi la sua assenza
 * non fa fallire il test delle etichette — fa fallire ogni test che legga un
 * task, in ogni harness, con un `no such table` a 500. La prima volta sono state
 * 194 asserzioni rosse in dieci file.
 *
 * Quindi questa tabella si dichiara QUI, una volta, e gli harness la importano.
 * La copia canonica resta la migration: questa deve restarle identica, e il test
 * accanto (`test-schema.test.ts`) lo verifica leggendo il file `.sql`.
 */

/**
 * `tasks` — la CREATE TABLE della 001 PIÙ ogni `ALTER TABLE tasks ADD COLUMN`
 * arrivato dopo, nell'ordine in cui le migration si applicano.
 *
 * Perché una sola stringa e non quattordici. La DDL di `tasks` era ricopiata a
 * mano in quattordici harness, e il guasto non si vedeva dove nasceva: il ramo
 * che aggiunge la colonna è verde da solo (aggiorna gli harness che conosce), il
 * ramo che aggiunge un harness nuovo è verde da solo (quando è nato la colonna
 * non c'era). Rosso solo alla FUSIONE, addosso a chi landa. Tre volte nella
 * notte del 12/08: `preview_retired_at` due volte, `wait_streak` una.
 *
 * L'ordine delle colonne è quello di applicazione, non alfabetico: è l'ordine
 * che ha il database vero, e un `INSERT ... VALUES` posizionale scritto contro
 * la produzione deve funzionare anche qui.
 *
 * Le FK sono verbatim, agent_profiles compresa. Con `PRAGMA foreign_keys = ON`
 * SQLite esige che la tabella-genitore ESISTA per qualsiasi DML sulla figlia,
 * anche inserendo NULL: chi accende le FK esegue anche `TASKS_FK_STUBS_DDL`.
 */
export const TASKS_DDL = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  text TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 4),
  kanban_order INTEGER NOT NULL DEFAULT 0,
  assigned_to TEXT,
  fingerprint TEXT,
  due_date TEXT,
  chat_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  in_progress_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  assigned_topic_id TEXT REFERENCES topics(id),
  claude_task_id TEXT,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  dispatch_state TEXT,
  dispatch_error TEXT,
  parent_task_id TEXT REFERENCES tasks(id),
  output_url TEXT,
  plan_first INTEGER NOT NULL DEFAULT 0,
  agent_ms INTEGER NOT NULL DEFAULT 0,
  agent_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  blocked_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
  priority_auto INTEGER NOT NULL DEFAULT 1,
  agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  preview_image TEXT,
  dispatch_deferred_until TEXT,
  delivery_branch TEXT,
  delivery_commit TEXT,
  landing_state TEXT,
  landing_checked_at TEXT,
  checks_state TEXT,
  checks_at TEXT,
  checks_commit TEXT,
  checks_json TEXT,
  delivered_by TEXT,
  delivered_reason TEXT,
  dispatch_weight TEXT,
  created_by_topic_id TEXT,
  plan_comment_id TEXT,
  done_actor TEXT,
  reopened_at TEXT,
  reopened_by TEXT,
  reopened_actor TEXT,
  landing_witnessed INTEGER NOT NULL DEFAULT 0,
  wait_streak INTEGER NOT NULL DEFAULT 0,
  wait_reason TEXT,
  wait_since TEXT,
  preview_retired_at TEXT,
  preview_retired_reason TEXT,
  interrupt_claimed_at TEXT,
  -- L'entita' della consegna (migration 20260816174500): NULL = non misurato,
  -- che non e' zero. Sta nello stub perche' recordDelivery la scrive sempre,
  -- quindi senza queste colonne ogni test che consegna esplode su
  -- "no such column" invece di dire cosa non va.
  -- IN FONDO, non accanto alle altre colonne delivery_*: l'ordine di questo DDL
  -- deve essere quello di APPLICAZIONE delle migration (lo verifica
  -- test-schema.test.ts), e queste tre sono le ultime arrivate. Raggrupparle per
  -- affinita' di nome le metteva a meta' tabella, cioe' in un ordine che la
  -- produzione non ha.
  -- (Niente backtick qui dentro: questo DDL vive in un template literal, e un
  -- backtick in un commento SQL apre un'interpolazione JS. Costato un giro.)
  delivery_files_changed INTEGER,
  delivery_insertions INTEGER,
  delivery_deletions INTEGER,
  -- 20260816214500: da quando la card aspetta una risposta umana.
  review_at TEXT,
  -- 20260818164410: esito sonda server-side sull'output_url (live/dead/unknown).
  url_probe_status TEXT CHECK (url_probe_status IN ('live', 'dead', 'unknown')) DEFAULT NULL,
  url_probe_checked_at TEXT DEFAULT NULL,
  -- 20260818234959: il turno tagliato da un riavvio, scritto sulla card invece
  -- che dedotto al boot dopo. La terza colonna e' il dedupe della nota che
  -- avvisa quando nessun recupero passera' mai di li'.
  interrupted_at TEXT DEFAULT NULL,
  interrupted_by TEXT DEFAULT NULL,
  interrupted_notified_at TEXT DEFAULT NULL,
  -- 20260819122701: la rivendicazione del SOLLECITO in chat (una interruzione,
  -- un sollecito). La regola sta in server/services/nudge-gate.ts; qui c'e' solo
  -- cosa il task ricorda: quando, quale testo, quante riprese.
  nudge_claimed_at TEXT,
  nudge_fingerprint TEXT,
  nudge_repeats INTEGER NOT NULL DEFAULT 0,
  -- 20260823210000: paths the retirement REJECTED, as a JSON array. Needed
  -- because the retired image stays attached to the comment the card took it
  -- from, and with no memory the startup sweep fished it straight back.
  preview_rejected TEXT,
  -- 20260827041049: where a card stands relative to the deploy PROPOSED at
  -- approve (board setting deployCommand). deploy_command_at_propose is a
  -- snapshot of the command at proposal time, not a live read of the setting:
  -- a later edit to the board's command must not change what a running deploy
  -- executes.
  deploy_state TEXT,
  deploy_command_at_propose TEXT,
  -- 20260828094441: what the agent has SPENT on this card, in USD cents. It
  -- rises with a MAX floor (raiseAgentUsage) and is not derivable from the
  -- tokens: the same million tokens is worth 12 to 49 USD depending on the model
  -- and on the cache.
  agent_cost_cents INTEGER NOT NULL DEFAULT 0
)`;

/**
 * `agent_spend` — the DATED ledger of agent spend (migration 20260828094441).
 *
 * It lives here and not in one harness because `raiseAgentUsage` writes into it
 * at every booking: without the table it is not the spend test that fails, it is
 * every test that runs a turn. The cumulative column on the card answers "what
 * did this card cost"; these rows answer "how much was spent in the last 24
 * hours", which a cumulative number cannot give.
 */
export const AGENT_SPEND_DDL = `CREATE TABLE IF NOT EXISTS agent_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  cents INTEGER NOT NULL,
  unpriced_cost_tokens INTEGER NOT NULL DEFAULT 0
)`;

/**
 * `terminal_sessions` — la 008 più le colonne aggiunte dopo (028
 * `parent_session_key`, 029 `status`, 066 `name_source`), ridotta a ciò che il
 * codice dei task le chiede.
 *
 * NON è più una tabella «di terminale» soltanto: il censimento degli agenti
 * (`agent-census.ts`) la legge dentro il CLAIM, perché le sessioni figlie di un
 * coordinatore contano nel tetto di concorrenza. Da lì in poi un harness della
 * board senza questa tabella non fa fallire un test di sub-agenti: fa fallire
 * ogni `claim` con un `no such table`, cioè cento asserzioni in una decina di
 * file. È lo stesso guasto di `task_labels`, e per la stessa ragione la
 * dichiarazione sta qui invece che ricopiata in ogni harness.
 */
export const TERMINAL_SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT,
  type TEXT NOT NULL DEFAULT 'shell',
  topic_id TEXT,
  cols INTEGER NOT NULL DEFAULT 120,
  rows INTEGER NOT NULL DEFAULT 30,
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  parent_session_key TEXT,
  name_source TEXT NOT NULL DEFAULT 'default'
)`;

/**
 * Le tabelle-genitore citate dalle FK di `TASKS_DDL`, ridotte alla chiave, PIÙ
 * `terminal_sessions` — che non è una FK ma una lettura del claim, e la sua
 * assenza si manifesta esattamente come quella di un genitore mancante.
 *
 * Serve SOLO agli harness che accendono `PRAGMA foreign_keys = ON`: lì un
 * genitore assente non è un vincolo che non si applica, è un `no such table:
 * main.agent_profiles` su OGNI insert, anche con la colonna a NULL. È
 * `IF NOT EXISTS`, quindi si esegue dopo la `topics` vera dell'harness senza
 * sovrascriverla (e senza obbligare chi non ce l'ha a inventarsela).
 */
/**
 * `app_settings` — le preferenze di MACCHINA, una riga sola.
 *
 * Sta fra gli stub e non fra le tabelle vere perche' qui serve solo che esista:
 * dal 2026-08-16 ci vive `auto_dispatch`, l'interruttore globale che prima
 * stava sulla riga riservata '*' di `board_settings` (migration
 * 20260816112635). `readGlobalDispatch` la interroga a ogni lettura delle
 * impostazioni di board, quindi senza questa riga non falliva un test: ne
 * fallivano centocinquanta, tutti con «no such table».
 *
 * La riga viene anche INSERITA: una tabella vuota fa leggere «spento» invece
 * dello stato vero, ed e' una differenza che si nota solo in un test su cento.
 */
export const APP_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_dispatch INTEGER,
  profile_publish_cost INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO app_settings (id, auto_dispatch) VALUES (1, 0);`;

export const TASKS_FK_STUBS_DDL = `CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY);
${APP_SETTINGS_DDL}
${TERMINAL_SESSIONS_DDL};
${AGENT_SPEND_DDL}`;

/** `task_labels` — identica alla 097, meno i commenti. */
export const TASK_LABELS_DDL = `CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'human' CHECK(source IN ('derived', 'human', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, label)
)`;


/**
 * LE MIGRATION ARRIVATE DOPO, senza doverle rincorrere a mano.
 *
 * Diversi harness costruiscono lo schema applicando un ELENCO di file di
 * migration che si ferma a una certa data (le rotte dell'identita' si fermano
 * alla 084). Ogni colonna aggiunta dopo a una di quelle tabelle diventa
 * invisibile li' dentro: la rotta la seleziona, SQLite non la conosce, la query
 * esplode e il `catch` della rotta risponde con un `null`. A schermo non si vede
 * un errore: si vede sparire il dato.
 *
 * Misurato il 18/08/2026: `20260818151850-org-logo-url.sql` aggiunge
 * `orgs.logo_url`, `/api/auth/me` comincia a leggerlo, e QUATTRO casi in due
 * file diventano rossi dicendo `null is not an object` — cioe' nominando il
 * sintomo e non la causa. Aggiungere il nome all'elenco a mano vorrebbe dire
 * ripagare lo stesso pomeriggio alla prossima colonna.
 *
 * Quindi non si elencano: si CERCANO. Solo le `ALTER TABLE` sulle tabelle che
 * l'harness usa davvero — nient'altro entra, cosi' una migration che dipende da
 * tabelle li' assenti non puo' rompere il banco.
 */
export function alterMigrationsAfter(dopo: string, tabelle: string[], radice: string): string[] {
  const dir = join(radice, "server", "db", "migrations");
  const soloAlter = new RegExp(`ALTER\\s+TABLE\\s+(${tabelle.join("|")})\\b`, "i");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f > dopo)
    .sort()
    .filter((f) => soloAlter.test(readFileSync(join(dir, f), "utf8")));
}
