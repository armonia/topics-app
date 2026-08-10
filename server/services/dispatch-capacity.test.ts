import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { effectiveDispatchCap, readGlobalCap } from "./dispatch-capacity";

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
    db.run("UPDATE board_settings SET max_agents = 0 WHERE project_id = '*'");
    expect(readGlobalCap(db).max).toBe(1);
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
