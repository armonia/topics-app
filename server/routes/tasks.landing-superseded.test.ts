/**
 * UNA CARD CHIUSA APPOSTA SENZA LANDARE PUO' DIRLO.  @covers LAND-05
 *
 * Spezzato da `tasks.landing.test.ts` il 17/09, quando quel file aveva sfondato
 * `check:bloat` a 1.076 righe: qui sta il gesto `superseded` e le due porte che
 * NON devono scriverlo.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

/**
 * CHIUSA APPOSTA SENZA LANDARE — un debito che nessuno intende pagare.
 *
 * Un `approve` che non atterra lascia la card `unlanded` con un commit vero, e
 * da fuori quello e' identico a una dimenticanza: chip «non su main» sulla card
 * e contatore rosso in cima alla board, per sempre. Misurato il 18/08/2026: tre
 * card chiuse deliberatamente — due il cui ramo portava il doppione di un
 * cancello gia' su main, una in cui fra due rimedi allo stesso guasto era stato
 * scelto l'altro — tutte e tre contate come debito. Il rumore su un contatore
 * lo rende inguardabile, e allora smette di servire anche per i debiti veri.
 *
 * `superseded` non si DEDUCE: dal repo, un ramo fuori da main e' fuori da main,
 * scartato o dimenticato che sia. Lo dice chi rivede, una volta.
 */
describe("una card chiusa senza landare puo' dirlo", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    const broadcasts: unknown[] = [];
    router = createTasksRouter(makeCtx(db, broadcasts), undefined, {});
  });

  /** Una card in review con una consegna vera: e' il caso in cui il chip si accende. */
  async function deliveredCard(): Promise<string> {
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "feature" }))!.json();
    db.prepare(
      "UPDATE tasks SET status = 'review', delivery_branch = 'topics/scartato', delivery_commit = 'abc12345' WHERE id = ?",
    ).run(t.id);
    db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('c1', ?, 'claude', 'consegna', 'comment', ?)")
      .run(t.id, new Date().toISOString());
    return t.id;
  }

  const stateLanding = (id: string) =>
    (db.prepare("SELECT landing_state FROM tasks WHERE id = ?").get(id) as { landing_state: string | null }).landing_state;

  test("con `superseded` la card si chiude e lo dichiara", async () => {
    const id = await deliveredCard();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true, superseded: true,
    });
    expect(r?.status).toBe(200);
    expect(stateLanding(id)).toBe("superseded");
  });

  test("senza il gesto NON si inventa niente: resta un debito da guardare", async () => {
    // Il caso che tiene onesto quello sopra. Se `approve` marcasse da solo, ogni
    // card chiusa senza landare sparirebbe dal contatore — cioe' il difetto
    // opposto, e molto peggiore: il lavoro dimenticato non lo direbbe piu'
    // nessuno.
    const id = await deliveredCard();
    const r = await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "approve", force: true,
    });
    expect(r?.status).toBe(200);
    expect(stateLanding(id)).not.toBe("superseded");
  });

  test("un rifiuto non lo scrive nemmeno se glielo chiedi", async () => {
    // `superseded` parla di una card CHIUSA. Su un rifiuto la card torna a
    // lavorare, e un timbro «non atterrera' mai» sopra un lavoro che riparte
    // sarebbe una bugia con la forma di una decisione.
    const id = await deliveredCard();
    await call(router, "POST", `/api/boards/pX/tasks/${id}/review`, {
      decision: "reject", comment: "rifai", superseded: true,
    });
    expect(stateLanding(id)).not.toBe("superseded");
  });
});
