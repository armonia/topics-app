import { test, expect, describe, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  applyJobQuota,
  computeJobQuota,
  countLiveDispatchedAgents,
  installQuotaShims,
  jobQuotaEnv,
  liveDispatchedSessions,
  quotaChannelDir,
  quotaShimScript,
  readDispatchBinding,
  readLiveQuota,
  refreshLiveJobQuotas,
  resolveJobQuotaEnv,
  writeLiveQuota,
} from "./agent-job-quota";
import { structuralDispatchCapacity } from "./dispatch-capacity";

// Il sottoinsieme di schema che la quota tocca: la riga del topic, la legatura
// del task e quella dei tentativi di fan-out, più le impostazioni della board da
// cui esce il tetto. Fedele alle migration 001/026/065/090 per le colonne in
// gioco — se la quota inizia a leggerne un'altra, va aggiunta anche qui.
//
// SENZA le colonne di VITA (`status`, `dispatch_state`, `archived`, `state` sui
// tentativi), e apposta: questo è l'host degradato, quello su cui il roster non
// si sa contare. I test che lo usano pinzano il RIPIEGO — il divisore torna a
// essere il tetto di concorrenza, cioè il comportamento di prima del canale
// vivo. Per il caso normale c'è `dbVivo()`.
//
// Ecco perché questo file NON importa `TASKS_DDL` (server/db/test-schema.ts)
// come gli altri harness: lì la tabella è quella completa, e con la tabella
// completa metà di questi test misurerebbe un DB che non è quello che dicono di
// misurare. Il sottoinsieme è la premessa, non una dimenticanza.
function dbFresco(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, assigned_topic_id TEXT REFERENCES topics(id), dispatch_weight TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idx INTEGER NOT NULL, topic_id TEXT
  )`);
  // migration 20260816112635: l'interruttore GLOBALE dell'auto-dispatch vive in
  // `app_settings`, non piu' sulla riga '*' di `board_settings`.
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)`);
  db.run(`INSERT OR IGNORE INTO app_settings (id, auto_dispatch) VALUES (1, 0)`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER
  )`);
  return db;
}

/** Lo schema con le colonne che dicono «questo agente è VIVO adesso». */
function dbVivo(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, assigned_topic_id TEXT REFERENCES topics(id), dispatch_weight TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress', dispatch_state TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idx INTEGER NOT NULL, topic_id TEXT,
    state TEXT NOT NULL DEFAULT 'running'
  )`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER
  )`);
  db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)").run();
  return db;
}

function topic(db: Database, id: string, sessionKey: string) {
  db.prepare("INSERT INTO topics (id, session_key) VALUES (?, ?)").run(id, sessionKey);
}

/** Un agente vivo: la sua chat, la sua card, il suo chip di dispatch. */
function agenteVivo(db: Database, n: number, opts: { weight?: string | null; state?: string } = {}) {
  topic(db, `t${n}`, `topic:${n}`);
  db.prepare(
    "INSERT INTO tasks (id, assigned_topic_id, dispatch_weight, status, dispatch_state, archived) VALUES (?,?,?,?,?,0)",
  ).run(`k${n}`, `t${n}`, opts.weight ?? null, "in_progress", opts.state ?? "working");
}

const CORES = Math.max(1, os.cpus().length);
const SOLO = Math.max(1, CORES - 1);

// Il canale vivo scrive su disco: ogni test che lo tocca lo fa in una cartella
// sua, mai in `~/.topics`.
const radiciTemporanee: string[] = [];
function radiceTemporanea(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "job-quota-"));
  radiciTemporanee.push(dir);
  process.env.TOPICS_JOB_QUOTA_DIR = dir;
  return dir;
}
afterEach(() => {
  delete process.env.TOPICS_JOB_QUOTA_DIR;
  for (const d of radiciTemporanee.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

describe("computeJobQuota — il divisore è chi c'è DAVVERO, non chi ci starebbe", () => {
  test("un agente solo si riprende la macchina, anche con un tetto di quattro", () => {
    // Il prezzo del recinto (misurato da `scripts/measure-job-quota.sh`) è
    // giustificato dai compagni. Senza compagni è solo prezzo.
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null, peers: 1 })).toBe(11);
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null, peers: 1 })).toBeGreaterThan(
      computeJobQuota({ cores: 12, cap: 4, weight: null, peers: 4 }),
    );
  });

  test("più agenti vivi del tetto (tetto abbassato a caldo): vince il conteggio, cioè il verso stretto", () => {
    expect(computeJobQuota({ cores: 12, cap: 2, weight: null, peers: 6 })).toBe(2);
    expect(computeJobQuota({ cores: 12, cap: 2, weight: null, peers: 6 })).toBeLessThan(
      computeJobQuota({ cores: 12, cap: 2, weight: null }),
    );
  });

  test("IL VERSO: la fetta non si allarga MAI quando arriva un altro agente", () => {
    // È l'invariante che separa questo divisore dalla raccomandazione viva del
    // dispatcher, che SCENDE sotto carico e quindi allargava la fetta proprio
    // quando la macchina si riempiva. Qui il numero SALE con l'affollamento.
    for (const cores of [1, 2, 4, 8, 12, 16, 32]) {
      for (const cap of [1, 2, 3, 4, 8]) {
        let precedente = Infinity;
        for (let peers = 1; peers <= 12; peers++) {
          const q = computeJobQuota({ cores, cap, weight: null, peers });
          expect(q).toBeLessThanOrEqual(precedente);
          expect(q).toBeGreaterThanOrEqual(1);
          precedente = q;
        }
      }
    }
  });

  test("la somma delle fette resta la macchina (finché i core bastano)", () => {
    for (const peers of [1, 2, 3, 4, 6, 12]) {
      const q = computeJobQuota({ cores: 12, cap: 3, weight: null, peers });
      expect(q * peers).toBeLessThanOrEqual(Math.max(12, peers));
    }
  });

  test("conteggio assente o assurdo: si torna al tetto, che è il numero di prima", () => {
    const colTetto = computeJobQuota({ cores: 12, cap: 4, weight: null });
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null, peers: null })).toBe(colTetto);
    // Zero agenti vivi mentre uno chiede la sua quota è una lettura che si
    // contraddice: non si consegna la macchina a chi non risulta esistere.
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null, peers: 0 })).toBe(colTetto);
    expect(computeJobQuota({ cores: 12, cap: 4, weight: null, peers: -3 })).toBe(colTetto);
  });

  test("un pesante resta solo comunque: il conteggio non lo tocca", () => {
    expect(computeJobQuota({ cores: 12, cap: 4, weight: "heavy", peers: 8 })).toBe(11);
  });
});

describe("countLiveDispatchedAgents — quanti stanno compilando adesso", () => {
  test("una card viva = un agente", () => {
    const db = dbVivo();
    agenteVivo(db, 1);
    agenteVivo(db, 2, { state: "starting" });
    expect(countLiveDispatchedAgents(db)).toBe(2);
  });

  test("chi non ha un turno vivo non conta: review, archiviati, chip spento", () => {
    const db = dbVivo();
    agenteVivo(db, 1);
    topic(db, "t2", "topic:2");
    db.prepare(
      "INSERT INTO tasks (id, assigned_topic_id, status, dispatch_state, archived) VALUES ('k2','t2','review','working',0)",
    ).run();
    topic(db, "t3", "topic:3");
    db.prepare(
      "INSERT INTO tasks (id, assigned_topic_id, status, dispatch_state, archived) VALUES ('k3','t3','in_progress','working',1)",
    ).run();
    topic(db, "t4", "topic:4");
    // Trascinato a mano in In Progress dall'umano: nessun chip, nessun agente.
    db.prepare(
      "INSERT INTO tasks (id, assigned_topic_id, status, dispatch_state, archived) VALUES ('k4','t4','in_progress',NULL,0)",
    ).run();
    expect(countLiveDispatchedAgents(db)).toBe(1);
  });

  test("UN FAN-OUT SONO N AGENTI, non una card: N processi che compilano lo stesso progetto", () => {
    const db = dbVivo();
    agenteVivo(db, 1);
    topic(db, "t2", "topic:2");
    topic(db, "t3", "topic:3");
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a1','k1',1,'t1','running')").run();
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a2','k1',2,'t2','running')").run();
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a3','k1',3,'t3','running')").run();
    // Contando le righe di `tasks` sarebbe 1, e i tre agenti si sarebbero presi
    // un terzo di macchina a testa credendosi soli.
    expect(countLiveDispatchedAgents(db)).toBe(3);
  });

  test("i tentativi finiti non contano più: il fan-out consegnato libera la macchina", () => {
    const db = dbVivo();
    agenteVivo(db, 1);
    topic(db, "t2", "topic:2");
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a1','k1',1,'t1','running')").run();
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a2','k1',2,'t2','delivered')").run();
    expect(countLiveDispatchedAgents(db)).toBe(1);
  });

  test("schema senza le colonne di vita: `null`, e il chiamante torna al tetto", () => {
    expect(countLiveDispatchedAgents(dbFresco())).toBeNull();
    expect(countLiveDispatchedAgents(new Database(":memory:"))).toBeNull();
  });
});

describe("liveDispatchedSessions — a chi va riscritto il numero", () => {
  test("card e tentativi, senza doppioni", () => {
    const db = dbVivo();
    agenteVivo(db, 1);
    topic(db, "t2", "topic:2");
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a1','k1',1,'t1','running')").run();
    db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, state) VALUES ('a2','k1',2,'t2','running')").run();
    const chiavi = liveDispatchedSessions(db).map((s) => s.sessionKey).sort();
    expect(chiavi).toEqual(["topic:1", "topic:2"]);
  });

  test("il peso viaggia con la sessione: un heavy resta largo anche alla rilettura", () => {
    const db = dbVivo();
    agenteVivo(db, 1, { weight: "heavy" });
    expect(liveDispatchedSessions(db)).toEqual([{ sessionKey: "topic:1", weight: "heavy" }]);
  });

  test("schema parziale: lista vuota, non un'eccezione a metà giro del dispatcher", () => {
    expect(liveDispatchedSessions(new Database(":memory:"))).toEqual([]);
  });
});

describe("refreshLiveJobQuotas — LA RILETTURA A METÀ SESSIONE", () => {
  test("gli agenti se ne vanno e il recinto si apre, senza che nessuno respawni", () => {
    radiceTemporanea();
    const db = dbVivo();
    for (const n of [1, 2, 3, 4]) agenteVivo(db, n);

    expect(refreshLiveJobQuotas(db)).toBe(4);
    const inQuattro = readLiveQuota("topic:1")!;
    expect(inQuattro).toBe(computeJobQuota({ cores: CORES, cap: 4, weight: null, peers: 4 }));

    // Tre finiscono. Nessuno respawna: cambia solo il file.
    db.prepare("UPDATE tasks SET status='review', dispatch_state=NULL WHERE id IN ('k2','k3','k4')").run();
    expect(refreshLiveJobQuotas(db)).toBe(1);
    const daSolo = readLiveQuota("topic:1")!;

    expect(daSolo).toBe(SOLO);
    if (CORES > 2) expect(daSolo).toBeGreaterThan(inQuattro);
  });

  test("e si richiude quando arrivano: il numero segue il roster in tutte e due le direzioni", () => {
    radiceTemporanea();
    const db = dbVivo();
    agenteVivo(db, 1);
    refreshLiveJobQuotas(db);
    const daSolo = readLiveQuota("topic:1")!;
    for (const n of [2, 3, 4, 5, 6]) agenteVivo(db, n);
    refreshLiveJobQuotas(db);
    const inSei = readLiveQuota("topic:1")!;
    expect(inSei).toBeLessThanOrEqual(daSolo);
    expect(inSei).toBe(computeJobQuota({ cores: CORES, cap: 4, weight: null, peers: 6 }));
  });

  test("un conteggio solo per giro: le fette dello stesso istante sono coerenti", () => {
    radiceTemporanea();
    const db = dbVivo();
    for (const n of [1, 2, 3]) agenteVivo(db, n);
    refreshLiveJobQuotas(db);
    expect(readLiveQuota("topic:1")).toBe(readLiveQuota("topic:2"));
    expect(readLiveQuota("topic:2")).toBe(readLiveQuota("topic:3"));
  });

  test("nessun agente vivo: nessun file toccato", () => {
    radiceTemporanea();
    expect(refreshLiveJobQuotas(dbVivo())).toBe(0);
  });
});

describe("gli shim — dove il numero entra davvero nella toolchain", () => {
  test("IL COMPORTAMENTO: lo stesso processo, lo stesso ambiente, due numeri diversi", () => {
    // La prova che questa è una rilettura e non un secondo congelamento: lo
    // shim gira DUE volte con lo stesso ambiente (quello congelato allo spawn,
    // `-j2`), e in mezzo cambia solo il file. Se leggesse l'ambiente direbbe 2
    // tutte e due le volte.
    const radice = radiceTemporanea();
    const finto = join(radice, "finto");
    mkdirSync(finto, { recursive: true });
    writeFileSync(join(finto, "cargo"), "#!/bin/sh\necho \"$CARGO_BUILD_JOBS $MAKEFLAGS\"\n", { mode: 0o755 });

    writeLiveQuota("topic:1", 7);
    const shim = installQuotaShims("topic:1", finto)!;
    expect(shim.installed).toContain("cargo");

    const ambienteCongelato = { ...process.env, ...jobQuotaEnv(2) };
    const esegui = () =>
      execFileSync(join(quotaChannelDir("topic:1"), "bin", "cargo"), ["build"], {
        env: ambienteCongelato,
        encoding: "utf8",
      }).trim();

    expect(esegui()).toBe("7 -j7");
    writeLiveQuota("topic:1", 3);
    expect(esegui()).toBe("3 -j3");
  });

  test("file assente o corrotto: si esegue lo stesso, con l'ambiente congelato", () => {
    const radice = radiceTemporanea();
    const finto = join(radice, "finto");
    mkdirSync(finto, { recursive: true });
    writeFileSync(join(finto, "cargo"), "#!/bin/sh\necho \"${CARGO_BUILD_JOBS:-vuoto}\"\n", { mode: 0o755 });
    installQuotaShims("topic:1", finto);
    const bin = join(quotaChannelDir("topic:1"), "bin", "cargo");
    const conAmbiente = { ...process.env, ...jobQuotaEnv(5) };

    // Nessun file: il recinto è quello di prima, non «nessun recinto».
    expect(execFileSync(bin, [], { env: conAmbiente, encoding: "utf8" }).trim()).toBe("5");
    writeFileSync(join(quotaChannelDir("topic:1"), "jobs"), "");
    expect(execFileSync(bin, [], { env: conAmbiente, encoding: "utf8" }).trim()).toBe("5");
    writeFileSync(join(quotaChannelDir("topic:1"), "jobs"), "tantissimi\n");
    expect(execFileSync(bin, [], { env: conAmbiente, encoding: "utf8" }).trim()).toBe("5");
  });

  test("gli argomenti non si toccano: un `-j` scritto a mano continua a vincere", () => {
    // Lo shim passa per l'ambiente, non per argv: nessun sottocomando da
    // riconoscere, nessun `cargo +nightly` da rompere.
    const script = quotaShimScript("/tmp/jobs", "/usr/bin/cargo");
    expect(script).toContain('exec \'/usr/bin/cargo\' "$@"');
    expect(script).not.toContain("-j$j ");
    expect(script).toContain('CARGO_BUILD_JOBS="$j" MAKEFLAGS="-j$j"');
  });

  test("LA TRAPPOLA DEL PATH: la cartella del binario vero finisce in CODA", () => {
    // `~/.cargo/env` si rimette in testa al PATH se non si trova già dentro, e
    // lo fa DOPO di noi (la CLI fotografa il PATH facendo girare il profilo).
    // Misurato: `.cargo/bin` in 12 e lo shim in 13, cioè shim scavalcato.
    // Tenendo quella cartella in coda, la guardia di idempotenza la trova già
    // presente e non la ripropone.
    const radice = radiceTemporanea();
    const finto = join(radice, "finto-cargo-bin");
    mkdirSync(finto, { recursive: true });
    writeFileSync(join(finto, "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const shim = installQuotaShims("topic:1", `/usr/bin${delimiter}/bin`)!;
    const pezzi = shim.path.split(delimiter);
    expect(pezzi[0]).toBe(join(quotaChannelDir("topic:1"), "bin"));

    const conCargo = installQuotaShims("topic:2", `${finto}${delimiter}/usr/bin`)!;
    const suoi = conCargo.path.split(delimiter);
    expect(suoi[0]).toBe(join(quotaChannelDir("topic:2"), "bin"));
    expect(suoi).toContain(finto);
    expect(suoi.filter((p) => p === finto)).toHaveLength(1);
  });

  test("la toolchain si cerca anche fuori dal PATH del server, che è un daemon", () => {
    // Il PATH di `bun run server.ts` sotto launchd non è quello di una shell di
    // login: misurato su questo host, non contiene `~/.cargo/bin`. Cercando solo
    // lì, `cargo` — l'unico comando per cui il recinto esiste — restava senza
    // shim, e la cartella vera non finiva in coda al PATH del figlio (che è la
    // mossa che tiene lo shim davanti a `~/.cargo/env`).
    const radice = radiceTemporanea();
    const vuota = join(radice, "vuota");
    mkdirSync(vuota, { recursive: true });
    const shim = installQuotaShims("topic:1", vuota);
    if (!shim) return; // host senza né cargo né make: niente da recintare
    for (const nome of shim.installed) {
      const script = readFileSync(join(quotaChannelDir("topic:1"), "bin", nome), "utf8");
      const reale = script.match(/exec '([^']+)' "\$@"/)![1]!;
      expect(existsSync(reale)).toBe(true);
      expect(shim.path.split(delimiter)).toContain(reale.slice(0, reale.lastIndexOf("/")));
    }
  });
});

describe("applyJobQuota — cosa lascia sull'ambiente di uno spawn", () => {
  test("agente dispatchato: variabili congelate, numero sul disco, shim in testa", () => {
    radiceTemporanea();
    const db = dbVivo();
    agenteVivo(db, 1);
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp" };
    const jobs = applyJobQuota(db, "topic:1", env)!;

    expect(jobs).toBe(computeJobQuota({ cores: CORES, cap: 4, weight: null, peers: 1 }));
    expect(env.CARGO_BUILD_JOBS).toBe(String(jobs));
    expect(env.MAKEFLAGS).toBe(`-j${jobs}`);
    expect(readLiveQuota("topic:1")).toBe(jobs);
    expect(env.PATH.split(delimiter)[0]).toBe(join(quotaChannelDir("topic:1"), "bin"));
  });

  test("chat umana: l'ambiente resta byte per byte quello di prima, e niente su disco", () => {
    radiceTemporanea();
    const db = dbVivo();
    topic(db, "t9", "topic:umana");
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp" };
    expect(applyJobQuota(db, "topic:umana", env)).toBeNull();
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/tmp" });
    expect(existsSync(quotaChannelDir("topic:umana"))).toBe(false);
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

  test("tetto in AUTO: il recinto NON dipende dal carico della macchina", () => {
    // Il guasto vero, misurato l'11/08 su questo host. Il divisore era la
    // raccomandazione viva (`computeDispatchCapacity`), che si tira indietro
    // quando la macchina è carica: con `auto` — il default di un'installazione
    // nuova — e load 45 usciva tetto 1, cioè «sono solo», cioè `-j11`. Nessun
    // recinto proprio nel momento in cui serviva.
    const db = dbFresco();
    topic(db, "t1", "topic:agente");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 3, 1)").run();

    const jobs = Number(resolveJobQuotaEnv(db, "topic:agente")!.CARGO_BUILD_JOBS);
    const cores = Math.max(1, os.cpus().length);
    // In `auto` il tetto strutturale non vale mai 1 (il pavimento di byCores è
    // 2), quindi la fetta non può mai essere quella del caso «da solo».
    expect(jobs).toBe(computeJobQuota({ cores, cap: structuralDispatchCapacity(), weight: null }));
    if (cores > 2) expect(jobs).toBeLessThan(cores - 1);
    // E deve valere ADESSO, sotto QUESTO carico, qualunque esso sia: se il
    // divisore tornasse a guardare il load, questa asserzione cadrebbe su una
    // macchina occupata e passerebbe su una a riposo.
    expect(structuralDispatchCapacity()).toBeGreaterThanOrEqual(2);
  });

  test("tetto FISSO a 1: quello è l'umano che dice «uno alla volta», e la fetta è intera", () => {
    const db = dbFresco();
    topic(db, "t1", "topic:agente");
    db.prepare("INSERT INTO tasks (id, assigned_topic_id) VALUES (?,?)").run("k1", "t1");
    db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 1, 0)").run();
    const jobs = Number(resolveJobQuotaEnv(db, "topic:agente")!.CARGO_BUILD_JOBS);
    expect(jobs).toBe(Math.max(1, Math.max(1, os.cpus().length) - 1));
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
