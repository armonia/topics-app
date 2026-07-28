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

  return async function e2eRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
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
      const body = (await _req.json().catch(() => null)) as { topicId?: string } | null;
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

    return null;
  };
}
