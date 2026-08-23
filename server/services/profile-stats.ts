/**
 * Le statistiche del profilo: quanto lavoro è passato di qui davvero.
 *
 * ── LA REGOLA CHE DECIDE OGNI QUERY DI QUESTO FILE ──────────────────────────
 * Si legge SOLO da tabelle che qualcuno scrive. Sembra ovvio, e invece è il
 * guasto che il cruscotto ha già avuto una volta: metà dei suoi numeri venivano
 * da `usage_records` (unico INSERT in `server/db/seed.ts`, che nessuno chiama),
 * `agent_sessions` (zero INSERT in tutto il server) e `heartbeats` (rotta
 * irraggiungibile). Erano zeri strutturali, e uno zero è la bugia peggiore che
 * un pannello possa dire — «0 sessioni» si legge «non hai lavorato», non «non
 * lo so». La storia per esteso sta in cima a `server/routes/dashboard.ts`.
 *
 * Le fonti vive, misurate sul DB di sviluppo (11/08: 14.697 messaggi, 1.272
 * task, 737 topic, 8 progetti):
 *   • `topics`   — le sessioni: quante sono, quante ancora aperte;
 *   • `messages` — i turni di chat, i loro token e il loro costo;
 *   • `tasks`    — il lavoro della board: token dell'agente, rilettura di
 *                  cache, millisecondi di esecuzione, esito;
 *   • `projects` — su quante case hai lavorato.
 *
 * ── IL COSTO SI DICHIARA IN DUE PEZZI, NON SI SOMMA ─────────────────────────
 * Stessa disciplina del cruscotto: una riga scritta prima dello scorporo della
 * cache ha un `cost_cents` gonfiato fino a ~10× di un fattore non
 * ricostruibile, perché i token riletti furono tariffati come input fresco.
 * Quelle righe non si sommano e non si nascondono: si CONTANO a parte
 * (`uncertainRows`), e il profilo porta quel numero accanto al totale. Un dato
 * mancante dichiarato è informazione; sommato di nascosto è una bugia.
 *
 * ── I TOKEN SI SOMMANO, E LA CACHE È GIÀ DENTRO ─────────────────────────────
 * Il consumo vero di un turno agentico è per la maggior parte rilettura di
 * contesto (~60% misurato). Un totale che la esclude descrive un'altra app.
 * Ma per i MESSAGGI non va aggiunta: `usage_prompt_tokens` la CONTIENE già —
 * `readResultUsage` e `readAssistantCallUsage` (`providers/claude/events.ts`)
 * costruiscono l'input come `input_tokens + cache_creation + cache_read`, ed è
 * il contratto scritto anche in `lib/cacheBreakdown.ts` (`prompt = fresco +
 * read + creation`). Sommarla di nuovo la conta due volte: misurato sul DB di
 * produzione, 18,03 miliardi mostrati contro 9,89 veri, cioè 1,82×.
 * Verificato che il contratto vale su ogni riga: `usage_prompt_tokens >=
 * cache_read_tokens` su 1.061 righe su 1.061.
 *
 * Per i TASK invece la somma ci vuole, e non è una svista: `tasks.agent_tokens`
 * nasce da `billableTokens`, che è «input+output+cacheWrite» e la rilettura la
 * ESCLUDE per costruzione (`services/dispatch-usage.ts`). Due tabelle, due
 * convenzioni, e la differenza è nel modulo che le riempie.
 */

import type { Database } from "bun:sqlite";
// La FORMA sta in `shared/types.ts` perché attraversa il filo: il pannello del
// profilo la legge dalla stessa dichiarazione, invece di tenerne una copia
// destinata a divergere (`tests/unit/no-type-mirrors.test.ts`). Qui si
// ri-esporta, così ogni import storico di questo modulo resta valido.
import type { ProfileStats } from "../../shared/types";
export type { ProfileStats };

const VUOTO: ProfileStats = {
  sessions: { total: 0, open: 0 },
  messages: { total: 0, assistant: 0 },
  tokens: { total: 0, chat: 0, agents: 0 },
  cost: { measuredUsd: 0, uncertainRows: 0 },
  tasks: { total: 0, done: 0, inProgress: 0 },
  projects: 0,
  agentHours: 0,
  activity: { firstSeen: null, activeDays: 0, streakDays: 0, last30: [] },
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Una riga sola, con `?? 0` su ogni colonna: una tabella che non esiste
 *  ancora (DB più vecchio della migration che la porta) non deve buttare giù
 *  l'intera scheda del profilo. */
function scalar(db: Database, sql: string, ...args: unknown[]): number {
  try {
    const row = db.query(sql).get(...(args as never[])) as { v?: unknown } | null;
    return num(row?.v);
  } catch {
    return 0;
  }
}

/** `YYYY-MM-DD` in UTC, la stessa unità in cui SQLite scrive `date(...)`. */
function giorno(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * La serie consecutiva di giorni attivi che arriva fino a ieri o a oggi.
 *
 * Pura, e presa in ingresso l'insieme dei giorni: il calcolo di una striscia
 * ha esattamente un caso interessante — il confine — ed è l'unico che si
 * sbaglia. Il DB non serve a provarlo.
 */
export function streak(giorniAttivi: Set<string>, oggiMs: number): number {
  const GIORNO_MS = 86_400_000;
  // Se oggi non c'è ancora niente si parte da ieri: la giornata in corso non è
  // una giornata mancata finché non è finita.
  let cursore = giorniAttivi.has(giorno(oggiMs)) ? oggiMs : oggiMs - GIORNO_MS;
  let n = 0;
  while (giorniAttivi.has(giorno(cursore))) {
    n++;
    cursore -= GIORNO_MS;
  }
  return n;
}

/**
 * Le statistiche, adesso.
 *
 * Nessuna cache: sono nove query su tabelle indicizzate, il pannello le chiede
 * quando lo apri, e una cache sbagliata su un numero che deve dire «questo sei
 * tu oggi» è un modo elaborato di mostrare ieri.
 */
export function computeProfileStats(db: Database, now: number = Date.now()): ProfileStats {
  try {
    const sessionsTotal = scalar(db, "SELECT COUNT(*) AS v FROM topics");
    const sessionsOpen = scalar(db, "SELECT COUNT(*) AS v FROM topics WHERE archived = 0");
    const messagesTotal = scalar(db, "SELECT COUNT(*) AS v FROM messages");
    const messagesAssistant = scalar(db, "SELECT COUNT(*) AS v FROM messages WHERE role = 'assistant'");

    const tokensChat = scalar(
      db,
      `SELECT COALESCE(SUM(
           COALESCE(usage_prompt_tokens, 0) + COALESCE(usage_completion_tokens, 0)
       ), 0) AS v FROM messages`,
    );
    const tokensAgents = scalar(
      db,
      "SELECT COALESCE(SUM(agent_tokens + agent_cache_read_tokens), 0) AS v FROM tasks",
    );

    // Il gate di ATTENDIBILITÀ è `cache_read_tokens IS NOT NULL`, non un
    // dettaglio tecnico: vedi l'intestazione.
    const measuredCents = scalar(
      db,
      "SELECT COALESCE(SUM(cost_cents), 0) AS v FROM messages WHERE cache_read_tokens IS NOT NULL",
    );
    const uncertainRows = scalar(
      db,
      "SELECT COUNT(*) AS v FROM messages WHERE cost_cents > 0 AND cache_read_tokens IS NULL",
    );

    const tasksTotal = scalar(db, "SELECT COUNT(*) AS v FROM tasks");
    const tasksDone = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE status = 'done'");
    const tasksInProgress = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE status = 'in_progress'");
    const projects = scalar(db, "SELECT COUNT(*) AS v FROM projects WHERE archived = 0");
    const agentMs = scalar(db, "SELECT COALESCE(SUM(agent_ms), 0) AS v FROM tasks");

    let firstSeen: string | null = null;
    try {
      const r = db.query("SELECT MIN(timestamp) AS v FROM messages").get() as { v?: string | null } | null;
      firstSeen = r?.v ?? null;
    } catch { /* schema più vecchio: nessuna data d'inizio */ }

    // I giorni attivi, e la serie: una lettura sola per entrambi.
    let giorni: Array<{ date: string; tokens: number }> = [];
    try {
      giorni = db.query(
        `SELECT date(timestamp) AS date,
                SUM(COALESCE(usage_prompt_tokens, 0) + COALESCE(usage_completion_tokens, 0)) AS tokens
           FROM messages
          WHERE timestamp IS NOT NULL
          GROUP BY date(timestamp)`,
      ).all() as Array<{ date: string; tokens: number }>;
    } catch { /* niente messaggi: nessuna serie */ }

    const perGiorno = new Map(giorni.map((g) => [g.date, num(g.tokens)]));
    // I giorni della board contano come attività anche se quel giorno non hai
    // scritto un messaggio: un agente che ha lavorato tutta la notte è lavoro.
    try {
      const t = db.query(
        `SELECT date(completed_at) AS date,
                SUM(agent_tokens + agent_cache_read_tokens) AS tokens
           FROM tasks WHERE completed_at IS NOT NULL GROUP BY date(completed_at)`,
      ).all() as Array<{ date: string; tokens: number }>;
      for (const r of t) {
        if (!r.date) continue;
        perGiorno.set(r.date, (perGiorno.get(r.date) ?? 0) + num(r.tokens));
      }
    } catch { /* schema senza le colonne 040/048 */ }

    const GIORNO_MS = 86_400_000;
    const last30: ProfileStats["activity"]["last30"] = [];
    for (let i = 29; i >= 0; i--) {
      const d = giorno(now - i * GIORNO_MS);
      last30.push({ date: d, tokens: perGiorno.get(d) ?? 0 });
    }

    return {
      sessions: { total: sessionsTotal, open: sessionsOpen },
      messages: { total: messagesTotal, assistant: messagesAssistant },
      tokens: { total: tokensChat + tokensAgents, chat: tokensChat, agents: tokensAgents },
      cost: { measuredUsd: Math.round(measuredCents) / 100, uncertainRows },
      tasks: { total: tasksTotal, done: tasksDone, inProgress: tasksInProgress },
      projects,
      agentHours: Math.round((agentMs / 3_600_000) * 10) / 10,
      activity: {
        firstSeen,
        activeDays: perGiorno.size,
        streakDays: streak(new Set(perGiorno.keys()), now),
        last30,
      },
    };
  } catch {
    // Il DB non è pronto (test molto precoci, boot a metà): il profilo si
    // disegna a zero invece di rispondere 500. Non è un numero inventato — è
    // la forma vuota, e la scheda lo mostra come «ancora niente».
    return { ...VUOTO, activity: { ...VUOTO.activity, last30: [] } };
  }
}

// ── Lo stato ADESSO, per la presence ───────────────────────────────────────

/**
 * Quante sessioni sono aperte e quante stanno lavorando in questo momento.
 *
 * È il numero che il daemon sostituito provava a indovinare con `ps` e un
 * campionamento di CPU. Qui non si indovina: `liveTurns` è il conto delle
 * sessioni che stanno producendo adesso — i turni che il server sta
 * TRASMETTENDO (`ctx.activeStreams`, una voce per sessione) più gli agenti che
 * macinano in una tab terminale (`countBusyAgentTerminals`, che il chiamante
 * somma) — e i task al lavoro sono quelli che la board ha dispatchato e non ha
 * ancora chiuso.
 */
export function computePresenceCounts(
  db: Database,
  liveTurns: number,
  externalSessions = 0,
  externalWorking = 0,
): {
  openSessions: number;
  workingSessions: number;
  activeTasks: number;
  focusProject: string | null;
  externalSessions: number;
  externalWorking: number;
} {
  const openSessions = scalar(db, "SELECT COUNT(*) AS v FROM topics WHERE archived = 0");
  const activeTasks = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE dispatch_state = 'working'");

  // Il progetto in primo piano: quello del task che la board sta eseguendo da
  // più tempo. Se la board è ferma, quello del topic aggiornato più di recente
  // — «dove sei adesso» è una domanda che ha una risposta anche senza agenti.
  let focusProject: string | null = null;
  try {
    const r = db.query(
      `SELECT p.name AS v
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.dispatch_state = 'working'
        ORDER BY t.in_progress_at ASC LIMIT 1`,
    ).get() as { v?: string } | null;
    focusProject = r?.v ?? null;
    if (!focusProject) {
      const s = db.query(
        `SELECT p.name AS v
           FROM topics tp JOIN projects p ON p.path = tp.project_path
          WHERE tp.archived = 0 AND tp.project_path IS NOT NULL
          ORDER BY tp.updated_at DESC LIMIT 1`,
      ).get() as { v?: string } | null;
      focusProject = s?.v ?? null;
    }
  } catch { /* schema ridotto: nessun progetto in primo piano */ }

  return {
    openSessions,
    // Le sessioni Claude aperte FUORI da Topics (un terminale, un altro
    // harness): il censimento le conosce gia' e le tiene in cache, ma finora
    // nessuna delle due superfici le nominava. Restano un numero A PARTE e non
    // si sommano a `openSessions`: quello conta topic, cioe' contenitori, e
    // questo conta processi. Sommarli darebbe un totale che non e' ne' l'uno
    // ne' l'altro.
    externalSessions,
    // Di quelle, quante macinano adesso: senza questo numero una sessione
    // esterna al lavoro sembra ferma quanto una idle.
    externalWorking,
    // Un turno vivo È una sessione al lavoro; i task della board hanno il loro
    // turno dentro `activeStreams`, quindi NON si risommano qui — sarebbe
    // contarli due volte, che è il modo in cui un contatore diventa vanteria.
    workingSessions: Math.max(0, liveTurns),
    activeTasks,
    focusProject,
  };
}
