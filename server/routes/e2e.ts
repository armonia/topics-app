/**
 * Superficie di TEST per la suite E2E — montata SOLO su un server di test.
 *
 * Il problema che risolve sta in `server/services/db-snapshot.ts`: un solo
 * server serve ~50 file di spec in serie sullo stesso SQLite, quindi ogni file
 * parte da quello che i precedenti hanno lasciato. Qui ci sono i due verbi che
 * rendono ermetico quel confine:
 *
 *   POST /api/test/checkpoint  fotografa il DB "appena seminato" (lo chiama il
 *                              globalSetup, una volta per run);
 *   POST /api/test/reset       lo rimette esattamente com'era (lo chiama ogni
 *                              file di spec, prima del proprio `beforeAll`).
 *
 * Più un verbo di SETUP, per lo stesso motivo (arrivare a uno stato che le API
 * pubbliche non sanno costruire):
 *
 *   POST /api/test/tasks/:id/bind-topic   lega un task alla topic dell'agente,
 *                              come il dispatcher — così si può testare la
 *                              superficie dei task dispatchati senza agente.
 *   POST /api/test/tasks/:id/landing      semina la fotografia di consegna
 *                              (branch + commit) e il verdetto dell'audit, che
 *                              nel mondo vero richiedono un repo git e la
 *                              passata periodica — così la superficie «chiuso
 *                              ma non su main» si testa senza aspettarla.
 *   POST /api/test/tasks/:id/attempts     semina i tentativi di un fan-out già
 *                              chiuso, come il dispatcher a fine giro — così il
 *                              pannello "Tentativi" e la scelta del vincitore si
 *                              testano senza far girare N agenti veri.
 *   POST /api/test/terminal/park-idle     fa girare SUBITO lo sweep che
 *                              parcheggia le sessioni ferme. In produzione è un
 *                              timer al minuto con una soglia di mezz'ora:
 *                              aspettarla in un test significherebbe un test da
 *                              trenta minuti. Qui la si passa (0 = «tutte quelle
 *                              che i gate lasciano passare»), e si osserva
 *                              l'effetto vero — non una simulazione dello sweep,
 *                              che è la stessa funzione del server.
 *
 * **Gate.** Tutto risponde `null` — cioè 404 — se `TOPICS_E2E` non vale "1".
 * Non è cosmesi: `reset` cancella ogni riga di ogni tabella. Sul server vero
 * questa route non deve esistere, e il 404 lo dimostra al primo colpo invece di
 * lasciarla lì disarmata. La variabile la mette solo
 * `scripts/start-test-server.sh`.
 *
 * **Perché la fotografia va anche su disco.** Una spec riavvia il server a metà
 * run (`terminal-session-resume`): un checkpoint tenuto solo in RAM morirebbe
 * lì, e da quel punto in poi metà suite tornerebbe non ermetica in silenzio —
 * il modo peggiore. Su file sotto `DATA_DIR` sopravvive al riavvio, e la
 * `DATA_DIR` di test è già per-shard.
 *
 * **Cosa NON ripristina:** lo stato in RAM del processo (contesti browser vivi,
 * PTY, broker). Quello lo chiude il chiamante con gli endpoint veri
 * (`DELETE /api/browsers/:id`, `DELETE /api/terminal/sessions/:id`) — vedi
 * `tests/e2e/fixtures/hermetic.ts`. Duplicare qui quelle logiche vorrebbe dire
 * mantenerne due copie, e la copia di test sarebbe quella che invecchia.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { restoreDb, snapshotDb, type DbSnapshot } from "../services/db-snapshot";
import { createTaskService } from "../services/tasks";
import { createTaskAttemptStore } from "../services/task-attempts";
import { parkIdleClaudeSessions } from "./terminal";

/** Attivo solo dove `start-test-server.sh` lo dichiara. */
export function e2eRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TOPICS_E2E === "1";
}

/** Dove vive la fotografia fra un riavvio e l'altro. */
export function baselinePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DATA_DIR || "/tmp/topics-test-data", "e2e-baseline.json");
}

export function createE2eRouter(ctx: AppContext): RouteHandler {
  const { db, json } = ctx;
  /** Copia calda: evita di rileggere e riparsare il JSON a ogni file di spec. */
  let cached: DbSnapshot | null = null;

  function loadBaseline(): DbSnapshot | null {
    if (cached) return cached;
    const path = baselinePath();
    if (!existsSync(path)) return null;
    try {
      cached = JSON.parse(readFileSync(path, "utf8")) as DbSnapshot;
      return cached;
    } catch {
      return null;
    }
  }

  return async function e2eRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (!e2eRoutesEnabled()) return null;

    // POST /api/test/checkpoint — fotografa lo stato corrente come baseline.
    if (method === "POST" && pathname === "/api/test/checkpoint") {
      const snap = snapshotDb(db);
      const path = baselinePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(snap));
      cached = snap;
      const rows = snap.tables.reduce((n, t) => n + t.rows.length, 0);
      console.log(`[e2e] checkpoint: ${snap.tables.length} tabelle, ${rows} righe → ${path}`);
      return json({ ok: true, tables: snap.tables.length, rows, path });
    }

    // POST /api/test/reset — riporta il DB alla baseline.
    if (method === "POST" && pathname === "/api/test/reset") {
      const snap = loadBaseline();
      if (!snap) {
        // Meglio un errore esplicito che un reset silenziosamente saltato: chi
        // chiama deve poter fallire QUI, non quaranta test più avanti.
        return json({ error: "no_checkpoint", path: baselinePath() }, 409);
      }

      // I `server_seq` di `ui_state` sono un contatore monotòno su cui il client
      // fa LWW: rimettendo i valori della baseline tornerebbero INDIETRO, e una
      // scheda che ne ha già visti di più alti scarterebbe l'hydrate del reset
      // restando col workspace del file precedente. Li ritraslo sopra il massimo
      // corrente, dentro la stessa transazione: dopo il reset ogni riga è più
      // "nuova" di qualunque cosa chiunque abbia visto, ordine relativo intatto.
      // Il massimo si legge DENTRO la transazione (`beforeDelete`), non prima:
      // fuori, una PUT concorrente potrebbe infilarsi fra la lettura e il BEGIN
      // e il reset uscirebbe con un seq non più superiore a quello visto.
      let maxSeq = 0;
      const result = restoreDb(db, snap, {
        beforeDelete: (d) => {
          maxSeq = (d.query("SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state")
            .get() as { maxSeq: number }).maxSeq;
        },
        afterInsert: (d) => { d.run("UPDATE ui_state SET server_seq = server_seq + ?", [maxSeq]); },
      });
      return json({ ok: true, ...result, takenAt: snap.takenAt });
    }

    // POST /api/test/terminal/park-idle {thresholdMs?} — lo sweep di parcheggio,
    // subito.
    //
    // In produzione è un timer al minuto con una soglia di mezz'ora, e acceso
    // solo da `TOPICS_TERMINAL_IDLE_PARK_MS`: aspettare quella soglia in un test
    // vorrebbe dire un test da trenta minuti, e riprodurre lo sweep nel test
    // vorrebbe dire testare la copia. Qui si chiama la STESSA funzione del
    // server con una soglia scelta dal chiamante — `0` significa «tutte quelle
    // che i gate lasciano passare», e i gate restano quelli veri
    // (`lib/terminal-idle-park.ts`).
    if (method === "POST" && pathname === "/api/test/terminal/park-idle") {
      let thresholdMs = 0;
      try {
        const body = (await req.json().catch(() => null)) as { thresholdMs?: number } | null;
        if (body && typeof body.thresholdMs === "number" && body.thresholdMs >= 0) {
          thresholdMs = body.thresholdMs;
        }
      } catch { /* corpo assente: soglia 0 */ }
      const result = parkIdleClaudeSessions(thresholdMs);
      // `skipped` con il motivo: senza, un test che non vede il parcheggio non
      // sa distinguere «il gate ha fatto il suo lavoro» da «lo sweep e' rotto».
      return json({ ok: true, ...result });
    }

    // POST /api/test/tasks/:taskId/bind-topic {topicId} — lega un task alla
    // topic dell'agente, come farebbe il dispatcher.
    //
    // Serve a testare la SUPERFICIE dei task dispatchati (il diff del worktree,
    // i commenti che tornano all'agente) senza far partire un agente vero: la
    // catena che il server percorre è task → `assigned_topic_id` → topic →
    // `worktreeId` → worktree, e il primo anello si può creare solo
    // dispatchando. Tutto il resto è già raggiungibile via API pubbliche
    // (`POST /api/worktrees`, `POST /api/topics {worktreeId}`), quindi manca
    // questo e basta. Chiama il servizio vero — nessuna seconda copia della
    // logica che possa invecchiare.
    const bind = /^\/api\/test\/tasks\/([^/]+)\/bind-topic$/.exec(pathname);
    if (method === "POST" && bind) {
      const body = (await req.json().catch(() => null)) as { topicId?: string } | null;
      if (!body?.topicId) return json({ error: "topicId required" }, 400);
      try {
        const task = createTaskService(db).bindTopic({
          taskId: decodeURIComponent(bind[1]),
          topicId: body.topicId,
        });
        return json({ ok: true, task });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/landing {branch?, commit?, state?} — semina la
    // FOTOGRAFIA DI CONSEGNA e il verdetto dell'audit di landing.
    //
    // Stessa ragione di `bind-topic`: queste due colonne le scrive solo il
    // dispatcher (alla consegna) e l'audit periodico (che interroga un repo git
    // vero, con un commit vero, e ci mette il suo giro). Nessuna API pubblica ci
    // arriva, quindi senza questo verbo la superficie «done ma non su main» non
    // è raggiungibile da nessun test end-to-end — ed è esattamente quella che
    // per otto giorni ha lasciato credere finito un lavoro che non c'era.
    // Passa dal servizio vero: nessuna seconda copia dello schema da tenere
    // allineata.
    const seedLanding = /^\/api\/test\/tasks\/([^/]+)\/landing$/.exec(pathname);
    if (method === "POST" && seedLanding) {
      const body = (await req.json().catch(() => null)) as
        | { branch?: string | null; commit?: string | null; state?: string | null }
        | null;
      const taskId = decodeURIComponent(seedLanding[1]);
      const state = body?.state ?? null;
      if (state !== null && state !== "landed" && state !== "unlanded" && state !== "unverifiable") {
        return json({ error: "state must be landed | unlanded | unverifiable | null" }, 400);
      }
      try {
        const svc = createTaskService(db);
        // Ordine obbligato: `recordDelivery` azzera per contratto il verdetto
        // precedente (una consegna nuova invalida un vecchio "landed"), quindi
        // lo stato va scritto DOPO — altrimenti si semina un `landing_state`
        // nullo e la spec misura il caso sbagliato.
        svc.recordDelivery({ taskId, branch: body?.branch ?? null, commit: body?.commit ?? null });
        if (state) svc.recordLandingState({ taskId, state, checkedAt: new Date().toISOString() });
        return json({ ok: true, task: svc.get(taskId)?.task ?? null });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/attempts {attempts:[…]} — semina i tentativi
    // di un fan-out. Stessa ragione di `bind-topic`: queste righe le scrive solo
    // il dispatcher lanciando N agenti veri, e senza di esse il pannello
    // "Tentativi" (e la scelta del vincitore, che è il verbo interessante) non
    // sarebbe raggiungibile da nessun test end-to-end. Passa dallo store vero —
    // nessuna seconda copia dello schema che possa invecchiare.
    const seedAttempts = /^\/api\/test\/tasks\/([^/]+)\/attempts$/.exec(pathname);
    if (method === "POST" && seedAttempts) {
      const body = (await req.json().catch(() => null)) as { attempts?: SeedAttempt[] } | null;
      if (!Array.isArray(body?.attempts) || body.attempts.length === 0) {
        return json({ error: "attempts required" }, 400);
      }
      const taskId = decodeURIComponent(seedAttempts[1]);
      try {
        const store = createTaskAttemptStore(db);
        store.clear(taskId);
        for (const [i, a] of body.attempts.entries()) {
          const row = store.create({ taskId, idx: a.idx ?? i + 1, model: a.model ?? null });
          store.bind(row.id, { topicId: a.topicId ?? null, worktreeId: a.worktreeId ?? null, branch: a.branch ?? null });
          // `running` = tentativo ancora vivo: si semina NON chiamando finish().
          if (a.state && a.state !== "running") {
            store.finish(row.id, {
              state: a.state === "failed" ? "failed" : "delivered",
              commit: a.commit ?? null,
              filesChanged: a.filesChanged ?? null,
              insertions: a.insertions ?? null,
              deletions: a.deletions ?? null,
              summary: a.summary ?? null,
              error: a.error ?? null,
            });
          }
        }
        return json({ ok: true, attempts: store.list(taskId) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    return null;
  };
}

/** Il tentativo come lo semina una spec: tutto opzionale tranne l'esito. */
interface SeedAttempt {
  idx?: number;
  topicId?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  model?: string | null;
  state?: "running" | "delivered" | "failed";
  commit?: string | null;
  filesChanged?: number | null;
  insertions?: number | null;
  deletions?: number | null;
  summary?: string | null;
  error?: string | null;
}
