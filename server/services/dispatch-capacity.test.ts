import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import {
  computeDispatchCapacity,
  effectiveDispatchCap,
  fleetSlotBudget,
  readGlobalCap,
  structuralDispatchCapacity,
} from "./dispatch-capacity";

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

describe("fleetSlotBudget — il freno vivo è un credito, non una divisione", () => {
  // 12 core = il Mac su cui il difetto è stato misurato: quota 6 core-unità.
  const su12 = (ourCoreUnits: number, running: number) => fleetSlotBudget({ cores: 12, ourCoreUnits, running });

  test("la quota è metà macchina, e a flotta ferma è tutta libera", () => {
    const b = su12(0, 0);
    expect(b.budgetCores).toBe(6);
    expect(b.freeCores).toBe(6);
    expect(b.slots).toBe(6);
  });

  test("IL DIFETTO CHE CHIUDE: un agente che costa una core-unità non abbassa il tetto", () => {
    // È l'invariante per cui il freno smette di misurare sé stesso. Col vecchio
    // conto (`cores - load1`) ogni agente che partiva alzava il load di due o
    // tre punti e chiudeva la porta al successivo, quindi la flotta si
    // stabilizzava a UN agente qualunque fosse la coda. Qui l'agente che parte
    // alza `running` di 1 e consuma 1 di budget: la somma non si muove.
    expect(su12(0, 0).slots).toBe(6);
    expect(su12(1, 1).slots).toBe(6);
    expect(su12(2, 2).slots).toBe(6);
    expect(su12(3, 3).slots).toBe(6);
  });

  test("il carico ALTRUI non entra nel conto: la sonda misura solo noi", () => {
    // La macchina può essere satura: se non è carico nostro, gli slot non
    // cambiano. È tutto il punto del cambio (12/08: load 13 su 12 core, la
    // nostra flotta a 0,75 core, il tetto sceso a 1 con cinque card in coda).
    expect(su12(0.75, 0).slots).toBe(su12(0.75, 0).slots);
    expect(su12(0.75, 0).slots).toBeGreaterThanOrEqual(5);
  });

  test("agenti che compilano: il tetto scende sotto lo strutturale", () => {
    // Due agenti a 2,5 core l'uno: 5 di quota spesi, ne resta 1, quindi un
    // posto solo in più. Questo è il freno che morde.
    expect(su12(5, 2).slots).toBe(3);
    // Tre a 2 core l'uno: quota esaurita, nessun posto nuovo.
    expect(su12(6, 3).slots).toBe(3);
  });

  test("un agente da solo non può chiudere la porta al secondo", () => {
    // Il primo si mette a compilare e si mangia l'intera quota. Senza pavimento
    // il conto darebbe «uno», cioè lui: la flotta si congelerebbe sul primo che
    // è partito, con la coda ferma dietro.
    expect(su12(12, 1).slots).toBe(2);
    expect(su12(6, 1).slots).toBe(2);
    // E nemmeno la flotta a zero agenti resta senza posti.
    expect(su12(99, 0).slots).toBe(2);
  });

  test("una misura assurda non sfonda in negativo", () => {
    expect(su12(-5, 0).freeCores).toBe(6);
    expect(su12(1e6, -3).slots).toBe(2);
  });
});

describe("computeDispatchCapacity — quale sonda comanda", () => {
  const cores = Math.max(1, os.cpus().length);

  test("macchina satura ma carico NON nostro: il tetto resta quello strutturale", () => {
    // La sonda della flotta dice «noi teniamo un decimo di core». Qualunque
    // cosa stia facendo il resto della macchina, il tetto non si ritira.
    const cap = computeDispatchCapacity(0, () => ({ coreUnits: 0.1, cores }));
    expect(cap.recommended).toBe(structuralDispatchCapacity());
    expect(cap.oursCores).toBe(0.1);
    expect(cap.reason).toContain("di quota");
  });

  test("carico NOSTRO oltre la quota: il tetto scende e la riga dice da cosa", () => {
    const cap = computeDispatchCapacity(1, () => ({ coreUnits: cores, cores }));
    expect(cap.recommended).toBeLessThanOrEqual(2);
    expect(cap.recommended).toBeLessThanOrEqual(structuralDispatchCapacity());
    expect(cap.reason).toContain("ridotto a");
    expect(cap.reason).toContain("di quota");
  });

  test("senza sonda (Windows, cache fredda) resta il conto storico sul load", () => {
    const cap = computeDispatchCapacity(0, () => null);
    expect(cap.oursCores).toBeNull();
    expect(cap.recommended).toBeGreaterThanOrEqual(1);
    expect(cap.reason).not.toContain("di quota");
  });

  test("una sonda che esplode vale «non lo so», non un tick caduto", () => {
    const cap = computeDispatchCapacity(0, () => { throw new Error("ps morto"); });
    expect(cap.oursCores).toBeNull();
    expect(cap.recommended).toBeGreaterThanOrEqual(1);
  });

  test("`running` non gonfia mai il tetto oltre lo strutturale", () => {
    const cap = computeDispatchCapacity(99, () => ({ coreUnits: 0, cores }));
    expect(cap.recommended).toBe(structuralDispatchCapacity());
  });
});
