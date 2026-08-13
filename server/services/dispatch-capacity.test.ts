import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { computeDispatchCapacity, effectiveDispatchCap, readGlobalCap, sizingDispatchCap, structuralDispatchCapacity } from "./dispatch-capacity";
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF, clampGlobalCap, isGlobalCapOff } from "../../shared/board";

function dbConImpostazioni(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER)`);
  return db;
}

describe("readGlobalCap — il tetto globale come sta scritto", () => {
  test("nessuna riga: auto, con 3 come numero di riserva", () => {
    expect(readGlobalCap(dbConImpostazioni())).toEqual({ auto: true, max: 3 });
  });

  test("colonna mai impostata (NULL) = auto, non «spento»", () => {
    const db = dbConImpostazioni();
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 5, NULL)");
    expect(readGlobalCap(db)).toEqual({ auto: true, max: 5 });
  });

  test("un numero scelto a mano spegne l'auto e viene letto", () => {
    const db = dbConImpostazioni();
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 6, 0)");
    expect(readGlobalCap(db)).toEqual({ auto: false, max: 6 });
  });

  test("il numero resta nella banda 1..20 comunque sia scritto in tabella", () => {
    const db = dbConImpostazioni();
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 999, 0)");
    expect(readGlobalCap(db).max).toBe(20);
    db.run("UPDATE board_settings SET max_agents = -5 WHERE project_id = '*'");
    expect(readGlobalCap(db).max).toBe(1);
  });

  test("lo ZERO e' l'eccezione alla banda: e' «nessun tetto», non «tetto a uno»", () => {
    // Prima questo test pretendeva `1`, ed era giusto finché lo zero non voleva
    // dire niente. Ora lo vuole dire: e' il sentinella di «nessun limite»
    // (`GLOBAL_CAP_OFF`), e stringerlo a 1 lo trasformerebbe nel tetto piu'
    // stretto esistente — l'impostazione opposta a quella salvata.
    const db = dbConImpostazioni();
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 0, 0)");
    expect(readGlobalCap(db)).toEqual({ auto: false, max: 0 });
    expect(effectiveDispatchCap(readGlobalCap(db), 4)).toBe(Infinity);
  });

  test("legge la riga riservata '*', non quella di una board", () => {
    const db = dbConImpostazioni();
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('progetto-x', 12, 0)");
    expect(readGlobalCap(db)).toEqual({ auto: true, max: 3 });
  });
});

describe("effectiveDispatchCap — quanti agenti insieme, adesso", () => {
  test("in auto vince la raccomandazione viva della macchina", () => {
    expect(effectiveDispatchCap({ auto: true, max: 8 }, 3)).toBe(3);
  });

  test("senza sonda si ricade sul numero fisso, anche in auto", () => {
    expect(effectiveDispatchCap({ auto: true, max: 8 }, null)).toBe(8);
  });

  test("con un numero scelto a mano la sonda non conta", () => {
    expect(effectiveDispatchCap({ auto: false, max: 2 }, 7)).toBe(2);
  });

  test("mai sotto 1: un tetto di zero non è prudenza, è una board ferma", () => {
    expect(effectiveDispatchCap({ auto: true, max: 0 }, 0)).toBe(1);
    expect(effectiveDispatchCap({ auto: false, max: -3 }, null)).toBe(1);
  });
});

describe("structuralDispatchCapacity — quanti ne regge in REGIME, non adesso", () => {
  test("non guarda il carico: due letture di fila danno lo stesso numero", () => {
    // La raccomandazione viva può cambiare fra due chiamate (il load si muove);
    // questa no, ed è il motivo per cui la quota di core divide per questa.
    expect(structuralDispatchCapacity()).toBe(structuralDispatchCapacity());
  });

  test("non vale mai 1: il caso «da solo» non si raggiunge per sbaglio in auto", () => {
    // Il pavimento di `byCores` è 2. Serve a `agent-job-quota`: un tetto di 1
    // significa «sono solo sulla macchina» e vale la fetta intera — deve poterlo
    // dire solo un umano che sceglie 1 a mano, mai il dimensionamento automatico.
    expect(structuralDispatchCapacity()).toBeGreaterThanOrEqual(2);
  });

  test("la raccomandazione viva non la supera mai: è il tetto meno ciò che il carico si è già preso", () => {
    // A riposo il carico non morde e le due letture coincidono; sotto carico la
    // viva scende SOTTO la strutturale. Mai il contrario: la strutturale è il
    // tetto, la viva è il tetto meno quello che il carico si è già preso.
    expect(computeDispatchCapacity().recommended).toBeLessThanOrEqual(structuralDispatchCapacity());
  });
});

/**
 * NESSUN TETTO, e le DUE domande che quel «nessuno» separa.
 *
 * `effectiveDispatchCap` risponde a «ne ammetto un altro?»: senza tetto la
 * risposta è sì, sempre, e Infinity è la forma giusta. `sizingDispatchCap`
 * risponde a «quanta macchina tocca a ciascuno?», ed è il DIVISORE della quota
 * di core: lì Infinity darebbe una fetta di zero, e lo zero grezzo passato per
 * `Math.max(1, 0)` darebbe la macchina INTERA a ognuno — la stessa inversione
 * già misurata una volta con la raccomandazione viva (`-j11` a testa con load
 * 45). Le due funzioni esistono separate per questo, e questi test sono l'unica
 * cosa che impedisce di riunirle per distrazione.
 */
describe("il tetto disattivato", () => {
  const off = { auto: false, max: GLOBAL_CAP_OFF };

  test("ammette senza limite", () => {
    expect(effectiveDispatchCap(off, 4)).toBe(Infinity);
  });

  test("ma NON dimensiona senza limite: il divisore resta un numero", () => {
    const n = sizingDispatchCap(off, structuralDispatchCapacity());
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test("e nemmeno 1, che darebbe a ognuno la macchina intera", () => {
    // 1 vuol dire «sono solo qui»: è la fetta piena. Senza tetto è la risposta
    // piu' sbagliata possibile, perché senza tetto gli altri sono tanti.
    expect(sizingDispatchCap(off, structuralDispatchCapacity())).not.toBe(1);
  });

  test("un tetto fisso continua a dimensionare su se stesso", () => {
    expect(sizingDispatchCap({ auto: false, max: 5 }, 3)).toBe(5);
  });

  test("lo zero sopravvive al giro attraverso il clamp", () => {
    // Il clamp storico era 1..20: avrebbe riletto «nessun tetto» come «tetto a
    // uno», cioè l'impostazione opposta a quella chiesta.
    expect(clampGlobalCap(0)).toBe(0);
    expect(clampGlobalCap(-3)).toBe(GLOBAL_CAP_MIN);
    expect(clampGlobalCap(99)).toBe(GLOBAL_CAP_MAX);
  });

  test("isGlobalCapOff non confonde «nessun tetto» con «deciderlo tu»", () => {
    expect(isGlobalCapOff(off)).toBe(true);
    expect(isGlobalCapOff({ auto: true, max: 0 })).toBe(false);
    expect(isGlobalCapOff({ auto: false, max: 1 })).toBe(false);
  });
});
