import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import {
  computeJobQuota,
  jobQuotaEnv,
  readDispatchBinding,
  resolveJobQuotaEnv,
} from "./agent-job-quota";

// Il sottoinsieme di schema che la quota tocca: la riga del topic, la legatura
// del task e quella dei tentativi di fan-out, più le impostazioni della board da
// cui esce il tetto. Fedele alle migration 001/026/065/090 per le colonne in
// gioco — se la quota inizia a leggerne un'altra, va aggiunta anche qui.
function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, assigned_topic_id TEXT REFERENCES topics(id), dispatch_weight TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idx INTEGER NOT NULL, topic_id TEXT
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER
  )`);
  return db;
}

function topic(db: Database, id: string, sessionKey: string) {
  db.prepare("INSERT INTO topics (id, session_key) VALUES (?, ?)").run(id, sessionKey);
}

describe("computeJobQuota — la fetta di macchina di un agente", () => {
  test("la fetta è i core divisi per il tetto: quattro agenti su dodici core → tre job a testa", () => {
    expect(computeJobQuota({ cores: 12, cap: 4, weight: "light" })).toBe(3);
    // 4 × 3 = 12: la somma delle quote torna alla macchina, che è il punto.
    expect(computeJobQuota({ cores: 12, cap: 4, weight: "light" }) * 4).toBe(12);
  });

  test("peso mai classificato (NULL) = light: senza risposta si prende il recinto stretto", () => {
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null })).toBe(
      computeJobQuota({ cores: 12, cap: 4, weight: "light" }),
    );
  });

  test("il peso può solo ALLARGARE: heavy prende la macchina meno un core", () => {
    const light = computeJobQuota({ cores: 12, cap: 4, weight: "light" });
    const heavy = computeJobQuota({ cores: 12, cap: 4, weight: "heavy" });
    expect(heavy).toBe(11);
    expect(heavy).toBeGreaterThan(light);
  });

  test("un core resta SEMPRE all'umano, anche con tetto 1 o peso heavy", () => {
    expect(computeJobQuota({ cores: 12, cap: 1, weight: "light" })).toBe(11);
    expect(computeJobQuota({ cores: 12, cap: 1, weight: "heavy" })).toBe(11);
    expect(computeJobQuota({ cores: 8, cap: 1, weight: "light" })).toBe(7);
  });

  test("mai zero job: macchina piccola o tetto assurdo restano a 1", () => {
    expect(computeJobQuota({ cores: 2, cap: 8, weight: "light" })).toBe(1);
    expect(computeJobQuota({ cores: 1, cap: 4, weight: "heavy" })).toBe(1);
    expect(computeJobQuota({ cores: 12, cap: 0, weight: "light" })).toBe(11); // cap 0 → 1 → caso «da solo»
    expect(computeJobQuota({ cores: 0, cap: 0, weight: null })).toBe(1);
    expect(computeJobQuota({ cores: NaN, cap: NaN, weight: null })).toBe(1);
  });

  test("la quota non supera mai i core della macchina", () => {
    for (const cores of [1, 2, 4, 8, 12, 16]) {
      for (const cap of [1, 2, 3, 4, 8]) {
        for (const weight of ["light", "heavy", null] as const) {
          const q = computeJobQuota({ cores, cap, weight });
          expect(q).toBeGreaterThanOrEqual(1);
          expect(q).toBeLessThanOrEqual(cores);
        }
      }
    }
  });
});

describe("jobQuotaEnv — le due variabili che portano la quota nella toolchain", () => {
  test("cargo e make dicono lo stesso numero", () => {
    expect(jobQuotaEnv(3)).toEqual({ CARGO_BUILD_JOBS: "3", MAKEFLAGS: "-j3" });
  });
  test("un numero storto non produce mai `-j0` o `-jNaN`", () => {
    expect(jobQuotaEnv(0)).toEqual({ CARGO_BUILD_JOBS: "1", MAKEFLAGS: "-j1" });
    expect(jobQuotaEnv(-4)).toEqual({ CARGO_BUILD_JOBS: "1", MAKEFLAGS: "-j1" });
    expect(jobQuotaEnv(NaN)).toEqual({ CARGO_BUILD_JOBS: "1", MAKEFLAGS: "-j1" });
    expect(jobQuotaEnv(2.7)).toEqual({ CARGO_BUILD_JOBS: "2", MAKEFLAGS: "-j2" });
  });
});

describe("readDispatchBinding — chi è un agente dispatchato", () => {
  test("topic legato a un task (assigned_topic_id): dispatchato, peso mai chiesto", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:aaa");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id, dispatch_weight) VALUES (?,?,NULL)").run("k1", "t1");
    expect(readDispatchBinding(db, "topic:aaa")).toEqual({ dispatched: true, weight: null });
  });

  test("il peso del task arriva fino allo spawn", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:aaa");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id, dispatch_weight) VALUES (?,?,'heavy')").run("k1", "t1");
    expect(readDispatchBinding(db, "topic:aaa")).toEqual({ dispatched: true, weight: "heavy" });
  });

  test("un valore storto in colonna degrada a «mai classificato», non a un errore", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:aaa");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id, dispatch_weight) VALUES (?,?,'gigantesco')").run("k1", "t1");
    expect(readDispatchBinding(db, "topic:aaa")).toEqual({ dispatched: true, weight: null });
  });

  test("i tentativi 2..N di un fan-out sono dispatchati anche senza assigned_topic_id", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:uno");
    topic(db, "t2", "topic:due");
    // Solo il tentativo 1 tiene il deep-link del task (migration 065).
    db.prepare("INSERT INTO tasks (id, assigned_topic_id, dispatch_weight) VALUES (?,?,'heavy')").run("k1", "t1");
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id) VALUES (?,?,?,?)").run("a1", "k1", 1, "t1");
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id) VALUES (?,?,?,?)").run("a2", "k1", 2, "t2");
    // Il secondo tentativo è l'agente che senza questa lettura resterebbe fuori
    // dal recinto — proprio mentre compila lo stesso progetto del primo.
    expect(readDispatchBinding(db, "topic:due")).toEqual({ dispatched: true, weight: "heavy" });
  });

  test("una chat umana non è dispatchata: nessun recinto", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:umana");
    expect(readDispatchBinding(db, "topic:umana")).toEqual({ dispatched: false, weight: null });
    expect(readDispatchBinding(db, "topic:inesistente")).toEqual({ dispatched: false, weight: null });
    expect(readDispatchBinding(db, "")).toEqual({ dispatched: false, weight: null });
  });

  test("colonna del peso assente (DB non ancora migrato): resta dispatchato, senza allargamento", () => {
    // Il guasto vero: sulla copia del DB vivo dell'11/08 la 090 non era ancora
    // stata applicata, e una lettura sola faceva uscire OGNI agente come «non
    // dispatchato» — zero recinto proprio sulla macchina che lo chiedeva.
    const db = new Database(":memory:");
    db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
    db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_topic_id TEXT)`); // niente dispatch_weight
    topic(db, "t1", "topic:aaa");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    expect(readDispatchBinding(db, "topic:aaa")).toEqual({ dispatched: true, weight: null });
  });

  test("schema parziale o DB rotto: nessun recinto, nessuna eccezione", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT)`);
    // Niente `tasks`, niente `task_attempts`: la lettura non deve travolgere lo spawn.
    expect(readDispatchBinding(db, "topic:aaa")).toEqual({ dispatched: false, weight: null });
  });
});

describe("resolveJobQuotaEnv — cosa finisce davvero nell'ambiente del figlio", () => {
  test("chat umana: null, cioè l'ambiente resta quello di prima", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:umana");
    expect(resolveJobQuotaEnv(db, "topic:umana")).toBeNull();
  });

  test("agente dispatchato: le due variabili, coerenti fra loro", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:agente");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)").run();
    const env = resolveJobQuotaEnv(db, "topic:agente")!;
    expect(env).not.toBeNull();
    const atteso = computeJobQuota({ cores: os.cpus().length, cap: 4, weight: null });
    expect(env.CARGO_BUILD_JOBS).toBe(String(atteso));
    expect(env.MAKEFLAGS).toBe(`-j${atteso}`);
  });

  test("alzare il tetto stringe la quota: la somma resta la macchina", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:agente");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 2, 0)").run();
    const stretto = Number(resolveJobQuotaEnv(db, "topic:agente")!.CARGO_BUILD_JOBS);
    db.prepare("UPDATE board_settings SET max_agents = 6 WHERE project_id = '*'").run();
    const strettissimo = Number(resolveJobQuotaEnv(db, "topic:agente")!.CARGO_BUILD_JOBS);
    expect(strettissimo).toBeLessThanOrEqual(stretto);
  });

  test("impostazioni illeggibili: si recinta lo stesso, sul default della board", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:agente");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    db.run("DROP TABLE board_settings");
    const env = resolveJobQuotaEnv(db, "topic:agente");
    expect(env).not.toBeNull();
    expect(Number(env!.CARGO_BUILD_JOBS)).toBeGreaterThanOrEqual(1);
  });
});
