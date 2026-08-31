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
 *   POST /api/test/tasks/:id/bind-topic   lega un task alla topic dell'agente
 *                                         (+ `dispatchState` opzionale),
 *                              come il dispatcher — così si può testare la
 *                              superficie dei task dispatchati senza agente.
 *   POST /api/test/tasks/:id/landing      semina la fotografia di consegna
 *                              (branch + commit) e il verdetto dell'audit, che
 *                              nel mondo vero richiedono un repo git e la
 *                              passata periodica — così la superficie «chiuso
 *                              ma non su main» si testa senza aspettarla.
 *   POST /api/test/tasks/:id/dispatch-gate  mette una card in uno dei modi in
 *                              cui il dispatcher la tiene ferma (tentativi
 *                              esauriti, finestra d'attesa aperta). Ci si arriva
 *                              solo con un agente vero che fallisce o che
 *                              dichiara un'attesa: senza questo verbo il chip
 *                              che dice PERCHÉ una card è ferma sarebbe
 *                              testabile solo su metà dei suoi rami.
 *   POST /api/test/tasks/:id/dispatch-state  mette il chip di dispatch come il
 *                              dispatcher (l'unico che lo scrive) — così una
 *                              card «in corso, agente al lavoro» si può vedere
 *                              senza far girare un agente vero.
 *   POST /api/test/tasks/:id/attempts     semina i tentativi di un fan-out già
 *                              chiuso, come il dispatcher a fine giro — così il
 *                              pannello "Tentativi" e la scelta del vincitore si
 *                              testano senza far girare N agenti veri.
 *   POST /api/test/orgs/:id/members       puts a SECOND person in an
 *                              organisation. The public API cannot get there:
 *                              `POST /api/auth/orgs/:id/members` asks the
 *                              licence for a seat and `POSTI_GRATUITI` is 1, so
 *                              on a token-less installation the second member
 *                              is precisely what the product refuses. But
 *                              "shared with somebody" is a real state, and
 *                              without this verb the only testable branch would
 *                              be the one-person organisation, i.e. the branch
 *                              where nothing is shared at all.
 *   POST /api/test/background-shell       registra/aggiorna una shell lasciata
 *                              in background, come fa `routes/chat.ts` leggendo
 *                              il risultato di una `Bash`. Senza un agente vero
 *                              non c'è modo di popolare quel registro, e senza
 *                              popolarlo non si può guardare la card della chat
 *                              aggiornarsi.
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
import { noteBackgroundShellOutput, registerBackgroundShell } from "./processes";
import { shellProcessKey } from "../../shared/background-shell-registry";
import { setSessionCliPid } from "../providers/session-pids";
import { setRouteFault } from "../lib/route-fault";
import { envDataDir } from "../lib/data-dir";
import { holdDispatchReconcile, releaseDispatchHold } from "../lib/e2e-dispatch-hold";

/** Attivo solo dove `start-test-server.sh` lo dichiara. */
export function e2eRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TOPICS_E2E === "1";
}

/** Where the snapshot lives between one restart and the next. */
export function baselinePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(envDataDir(env) || "/tmp/topics-test-data", "e2e-baseline.json");
}

export function createE2eRouter(ctx: AppContext): RouteHandler {
  const { db, json } = ctx;
  /** Hot copy: avoids re-reading and re-parsing the JSON for every spec file. */
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

    // POST /api/test/route-fault — arms or disarms the latency fault, hot.
    //
    // It serves the self-proof of `check:route-latency`: without it the fault can only be armed
    // from the environment at boot, so the healthy measurement and the faulty one come from two
    // DIFFERENT processes and the difference proves nothing about the gate. From here they come
    // from the same one.
    // Body: {"delayMs": 40, "pathPrefix": "/api/topics"} to arm, {} or null to disarm.
    if (method === "POST" && pathname === "/api/test/route-fault") {
      const body = (await req.json().catch(() => null)) as { delayMs?: unknown; pathPrefix?: unknown } | null;
      const delayMs = Number(body?.delayMs);
      if (!body || !Number.isFinite(delayMs) || delayMs <= 0) {
        setRouteFault(null);
        console.log("[e2e] route-fault: disarmato");
        return json({ ok: true, armed: null });
      }
      const fault = {
        delayMs,
        pathPrefix: typeof body.pathPrefix === "string" && body.pathPrefix ? body.pathPrefix : "/api/topics",
      };
      setRouteFault(fault);
      console.log(`[e2e] route-fault: armato ${fault.delayMs}ms su ${fault.pathPrefix}`);
      return json({ ok: true, armed: fault });
    }

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
      // THE HERMETIC BOUNDARY ALSO RELEASES THE BRAKE. A hold expires on its
      // own, but a spec that dies mid-hold would leave it armed on the next
      // file: here, where the files separate, it is dropped regardless.
      releaseDispatchHold();
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

    // POST /api/test/orgs/:id/members {name} — the second person in the group.
    //
    // Writes the SAME two rows the real route would (`people` + `org_members`
    // with role `member`) and skips the one thing that blocks it here: the seat
    // count. Not a shortcut around behaviour — it is the licence token a test
    // server does not have, and minting a signed one just to populate a table
    // would be a second implementation of the licence inside the suite.
    {
      const m = pathname.match(/^\/api\/test\/orgs\/([^/]+)\/members$/);
      if (m && method === "POST") {
        const orgId = decodeURIComponent(m[1]!);
        const body = (await req.json().catch(() => null)) as { name?: string } | null;
        const nome = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
        if (!nome) return json({ error: "name required" }, 400);
        const viva = db.query("SELECT 1 FROM orgs WHERE id = ? AND revoked_at IS NULL").get(orgId);
        if (!viva) return json({ error: "unknown_org" }, 404);
        const now = Date.now();
        const personId = crypto.randomUUID().replace(/-/g, "");
        db.query(
          "INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',1,?)",
        ).run(personId, nome, now, now);
        db.query(
          "INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,'member',?,1,?)",
        ).run(orgId, personId, now, now);
        return json({ ok: true, personId });
      }
    }

    // POST /api/test/background-shell — muove il registro delle shell come lo
    // muoverebbe un turno vero.
    //
    // Una shell in background nasce SOLO dentro un turno dell'agente: la
    // registra `routes/chat.ts` leggendo il risultato della `Bash`, e le
    // attacca output a ogni `BashOutput` successivo. Senza un agente vero non
    // c'è modo di arrivarci dalle API pubbliche — e senza arrivarci non si può
    // guardare la card della chat crescere, che è tutto il punto.
    //
    // Chiama le STESSE funzioni del registro (`routes/processes.ts`), non una
    // copia: quello che il test vede è il registro vero, letto dalla route vera.
    if (method === "POST" && pathname === "/api/test/background-shell") {
      const body = (await req.json().catch(() => null)) as {
        sessionKey?: string; shellId?: string; command?: string; cwd?: string; topicId?: string | null;
        output?: string; status?: "running" | "completed" | "failed" | "killed"; exitCode?: number;
      } | null;
      if (!body?.sessionKey || !body?.shellId) {
        return json({ error: "sessionKey and shellId required" }, 400);
      }
      // `command` presente ⇒ è l'avvio; assente ⇒ è un aggiornamento su una
      // shell già registrata (output nuovo e/o esito).
      if (body.command) {
        // Il CLI padre. Senza, lo sweep chiude la shell al primo giro (4s) —
        // e ha ragione: «nessun CLI vivo ⇒ la shell è morta con lui» è la
        // regola vera del registro, non un dettaglio da aggirare. Qui si
        // dichiara un padre vivo (il server stesso) invece di disarmare lo
        // sweep, così il test cammina sulla strada di produzione.
        setSessionCliPid(body.sessionKey, process.pid);
        registerBackgroundShell({
          sessionKey: body.sessionKey,
          topicId: body.topicId ?? null,
          shellId: body.shellId,
          command: body.command,
          cwd: body.cwd || process.cwd(),
          ownerPid: null,
        });
      }
      if (body.output != null || body.status || body.exitCode != null) {
        noteBackgroundShellOutput(body.sessionKey, body.shellId, {
          ...(body.output != null ? { output: body.output } : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(body.exitCode != null ? { exitCode: body.exitCode } : {}),
        });
      }
      return json({ ok: true, processId: shellProcessKey(body.sessionKey, body.shellId) });
    }

    // POST /api/test/dispatch-hold {ms} — holds the periodic reconcile.
    //
    // The necessary twin of `bind-topic`: that verb stages a task with an agent
    // inside a turn WITHOUT a live turn behind it, and reconcile recovers
    // exactly that shape after two 10s sweeps. A spec working on that card is
    // therefore racing a server timer, and losing the race does not LOOK like a
    // race: the card changes column, its DOM node is REPLACED, and the gesture
    // in flight dies with it. See `lib/e2e-dispatch-hold.ts`.
    if (method === "POST" && pathname === "/api/test/dispatch-hold") {
      const body = (await req.json().catch(() => null)) as { ms?: number } | null;
      const until = holdDispatchReconcile(typeof body?.ms === "number" ? body.ms : 0);
      return json({ ok: true, until });
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
      const body = (await req.json().catch(() => null)) as { topicId?: string; dispatchState?: string | null } | null;
      if (!body?.topicId) return json({ error: "topicId required" }, 400);
      try {
        const svc = createTaskService(db);
        const taskId = decodeURIComponent(bind[1]);
        let task = svc.bindTopic({ taskId, topicId: body.topicId });
        // `dispatchState` opzionale, per la stessa ragione del topic qui sopra:
        // quella colonna la scrive SOLO il dispatcher, e senza di essa un test
        // non può mettere in scena un task con l'agente dentro un turno — che è
        // il presupposto di tutto ciò che si legge dalla catena dei padri.
        // Passa dal servizio vero (`setDispatchState`), non da una UPDATE a mano.
        if (body.dispatchState !== undefined) {
          task = svc.setDispatchState({ taskId, state: body.dispatchState });
        }
        return json({ ok: true, task });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/dispatch-gate {attempts?, deferMinutes?} —
    // porta un task in uno dei modi in cui il dispatcher lo tiene fermo.
    //
    // Stessa ragione di `bind-topic`: sono stati che nessuna API pubblica sa
    // costruire. Il budget dei tentativi lo consuma solo un agente vero che
    // fallisce N turni; la finestra d'attesa la scrive solo `wait_for_condition`
    // dalla sessione di un agente dispacciato. Senza questi due, il chip che
    // dice PERCHÉ una card è ferma resta testabile su due rami su sei.
    //
    // `deferMinutes` passa dal servizio vero (`deferForWait`), che scrive anche
    // la nota e il chip. I tentativi no: il verbo vero (`bumpDispatchAttempt`)
    // vuole un claim vivo, cioè esattamente l'agente che qui non c'è — quindi
    // la colonna si scrive a mano, ed è l'unico punto in cui questo file lo fa.
    const gate = /^\/api\/test\/tasks\/([^/]+)\/dispatch-gate$/.exec(pathname);
    if (method === "POST" && gate) {
      const body = (await req.json().catch(() => null)) as { attempts?: number; deferMinutes?: number; deferReason?: string } | null;
      const taskId = decodeURIComponent(gate[1]);
      try {
        const svc = createTaskService(db);
        if (typeof body?.attempts === "number") {
          db.prepare("UPDATE tasks SET dispatch_attempts = ? WHERE id = ?").run(body.attempts, taskId);
        }
        if (typeof body?.deferMinutes === "number") {
          svc.deferForWait({
            taskId,
            reason: body.deferReason ?? "attesa dichiarata da un test",
            minutes: body.deferMinutes,
          });
        }
        const task = svc.get(taskId)?.task ?? null;
        if (!task) return json({ error: "task_not_found" }, 404);
        return json({ ok: true, task });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/dispatch-state {state, error?} — mette il
    // chip di dispatch come lo metterebbe il dispatcher.
    //
    // Stessa ragione di `bind-topic`: `dispatch_state` lo scrive SOLO il
    // dispatcher lanciando un agente vero, e da fuori non c'è nessuna API che lo
    // tocchi (la PATCH del task non lo accetta, di proposito). Senza, una card
    // «in corso» — con l'agente al lavoro, che è lo stato in cui l'umano vuole
    // poter dire «fermati» — non è raggiungibile da nessun test end-to-end.
    // Passa dal servizio vero (`setDispatchState`), nessuna seconda copia.
    // POST /api/test/tasks/:id/delivery — la consegna, come la scriverebbe una
    // consegna vera.
    //
    // Stessa ragione di `dispatch-state`: il diffstat (`delivery_files_changed`
    // e i due versi) lo scrive SOLO `recordDelivery`, chiamato dall'edge verso
    // review dopo aver letto GIT nel worktree dell'agente. La PATCH del task
    // non lo accetta, di proposito — sono numeri MISURATI, non dichiarati.
    //
    // Senza questa porta, una card «con una consegna dentro» non e'
    // raggiungibile da nessun test: e' esattamente cio' che ha lasciato i due
    // casi sull'elenco dei file modificati a `test.skip`. Uno skip non prova
    // niente, e la strada per toglierlo e' questa — non allentare le
    // asserzioni finche' passano.
    //
    // Passa dal servizio VERO (`recordDelivery`), nessuna seconda copia della
    // regola: quello che il test vede e' cio' che scriverebbe una consegna.
    const delivery = /^\/api\/test\/tasks\/([^/]+)\/delivery$/.exec(pathname);
    if (method === "POST" && delivery) {
      const body = (await req.json().catch(() => null)) as {
        branch?: string | null; commit?: string | null;
        filesChanged?: number; insertions?: number; deletions?: number;
      } | null;
      try {
        const svc = createTaskService(db);
        svc.recordDelivery({
          taskId: decodeURIComponent(delivery[1]),
          branch: body?.branch ?? null,
          commit: body?.commit ?? null,
          // `stat` assente ⇒ NULL, cioe' «non misurato»: la stessa distinzione
          // del servizio vero, che non e' lo zero.
          stat: typeof body?.filesChanged === "number"
            ? {
                filesChanged: body.filesChanged,
                insertions: body.insertions ?? 0,
                deletions: body.deletions ?? 0,
              }
            : null,
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    const dispatchState = /^\/api\/test\/tasks\/([^/]+)\/dispatch-state$/.exec(pathname);
    if (method === "POST" && dispatchState) {
      const body = (await req.json().catch(() => null)) as { state?: string | null; error?: string | null } | null;
      try {
        const task = createTaskService(db).setDispatchState({
          taskId: decodeURIComponent(dispatchState[1]),
          state: body?.state ?? null,
          error: body?.error ?? null,
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
        | {
            branch?: string | null; commit?: string | null; state?: string | null;
            /** L'entita' della consegna, per le spec che misurano il chip. */
            filesChanged?: number; insertions?: number; deletions?: number;
          }
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
        svc.recordDelivery({
          taskId, branch: body?.branch ?? null, commit: body?.commit ?? null,
          // Assente ⇒ null, come in produzione: una spec che non chiede la
          // misura deve vedere una card senza chip, non una con degli zeri.
          stat: body?.filesChanged === undefined ? null : {
            filesChanged: body.filesChanged,
            insertions: body.insertions ?? 0,
            deletions: body.deletions ?? 0,
          },
        });
        if (state) svc.recordLandingState({ taskId, state, checkedAt: new Date().toISOString() });
        return json({ ok: true, task: svc.get(taskId)?.task ?? null });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/review-at {at} — l'istante d'INGRESSO in
    // review, spostato indietro nel tempo.
    //
    // Il chip dell'attesa tace sotto l'ora, quindi una card appena creata non
    // lo mostra: una spec che volesse vederlo dovrebbe aspettare un'ora vera.
    // Questa porta sposta l'orologio del dato, non quello della macchina.
    const seedReviewAt = pathname.match(/^\/api\/test\/tasks\/([^/]+)\/review-at$/);
    if (method === "POST" && seedReviewAt) {
      const body = (await req.json().catch(() => null)) as { at?: string } | null;
      const at = typeof body?.at === "string" ? body.at : null;
      if (!at || !Number.isFinite(Date.parse(at))) return json({ error: "at must be an ISO date" }, 400);
      try {
        db.prepare("UPDATE tasks SET review_at = ? WHERE id = ?").run(at, decodeURIComponent(seedReviewAt[1]!));
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/checks {state} — l'ESITO DEI CONTROLLI.
    //
    // Stessa ragione delle altre porte di test: farli girare per davvero
    // vorrebbe dire un repo, dei comandi e dei secondi, quando la spec misura
    // solo se la card DICE l'esito. Il verdetto vero ha la sua strada in
    // `POST /tasks/:id/checks` di tasks.ts, che questa non tocca.
    const seedChecks = pathname.match(/^\/api\/test\/tasks\/([^/]+)\/checks$/);
    if (method === "POST" && seedChecks) {
      const body = (await req.json().catch(() => null)) as { state?: string } | null;
      const state = body?.state ?? null;
      if (state !== "running" && state !== "pass" && state !== "fail") {
        return json({ error: "state must be running | pass | fail" }, 400);
      }
      try {
        const svc = createTaskService(db);
        const t = svc.recordChecks({
          taskId: decodeURIComponent(seedChecks[1]!), state,
          commit: null, runs: null,
        });
        return json({ ok: true, task: t });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // POST /api/test/tasks/:taskId/system-delivery {cause?, reason?} — la card
    // che arriva in review SENZA che nessuno l'abbia consegnata.
    //
    // Stessa ragione di `bind-topic` e `landing`: `delivered_by = 'system'` lo
    // scrive solo il dispatcher, e solo dopo aver bruciato i tentativi di un
    // agente vero o essersi preso un rifiuto dal modello. Senza questo verbo la
    // superficie che il 13/08 ha fatto approvare una card vuota (5472e584 aveva
    // consegnato, c0849d9d no, e sulla board erano identiche) non è
    // raggiungibile da nessun test end-to-end. Passa dal servizio VERO, quindi
    // la spec vede quello che vedrebbe dopo un turno finito male: la nota di
    // sistema nel thread, il chip, e le scelte che ne derivano.
    const seedSystemDelivery = /^\/api\/test\/tasks\/([^/]+)\/system-delivery$/.exec(pathname);
    if (method === "POST" && seedSystemDelivery) {
      const body = (await req.json().catch(() => null)) as
        | { cause?: string | null; reason?: string | null }
        | null;
      const cause = body?.cause ?? "retries_exhausted";
      if (cause !== "retries_exhausted" && cause !== "model_refused" && cause !== "fanout") {
        return json({ error: "cause must be retries_exhausted | model_refused | fanout" }, 400);
      }
      const taskId = decodeURIComponent(seedSystemDelivery[1]);
      try {
        const svc = createTaskService(db);
        const task = svc.deliverToReviewBySystem({ taskId, reason: body?.reason ?? "", cause });
        return json({ ok: true, task });
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
