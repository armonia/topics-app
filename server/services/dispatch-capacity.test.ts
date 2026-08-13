import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import { DISPATCH_DISK_FLOOR_GB, computeDispatchCapacity, dispatchResourceBlock, effectiveDispatchCap, fleetCapacityLimit, freeDiskGB, readGlobalCap, sizingDispatchCap, structuralDispatchCapacity } from "./dispatch-capacity";
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

describe("fleetCapacityLimit — il freno vivo misura la NOSTRA flotta", () => {
  // I numeri sono quelli misurati sulla macchina che si era fermata a un agente:
  // 12 core, load average 13, e gli agenti che tenevano 0,75 core in tutto.
  const CORE = 12;
  /** Quanti agenti NUOVI passano: è la domanda che il dispatcher pone davvero. */
  const nuovi = (fleetCores: number, running: number) =>
    fleetCapacityLimit({ cores: CORE, fleetCores, running }) - running;

  test("carico ALTRUI: la flotta usa 0,75 core su 12 e il freno NON morde", () => {
    // Era il caso rotto: load 13 su 12 core dava «tetto 1» e cinque card in coda
    // dietro a un agente solo. Il carico era di WindowServer, Dia, Beeper.
    // Il limite deve stare SOPRA il tetto strutturale (su 12 core è 4): sopra il
    // strutturale vuol dire «non è questo il vincolo».
    expect(fleetCapacityLimit({ cores: CORE, fleetCores: 0.75, running: 1 })).toBeGreaterThan(4);
    expect(nuovi(0.75, 1)).toBe(5);
  });

  test("un core-unità a slot: a flotta ferma la quota è metà macchina, non tutta", () => {
    expect(nuovi(0, 0)).toBe(CORE / 2);
  });

  test("carico NOSTRO: tre agenti che si mangiano la quota e la porta si chiude", () => {
    // Tre agenti a 2 core l'uno saturano i 6 di quota: nessuno slot nuovo, e il
    // tetto scende SOTTO il strutturale 4. È qui che il freno deve mordere.
    expect(nuovi(6, 3)).toBe(0);
    expect(fleetCapacityLimit({ cores: CORE, fleetCores: 6, running: 3 })).toBe(3);
    expect(fleetCapacityLimit({ cores: CORE, fleetCores: 6, running: 3 })).toBeLessThan(4);
  });

  test("PAVIMENTO: un agente solo non chiude la porta al secondo, qualunque cosa faccia", () => {
    // Il difetto vecchio in una riga: il primo agente alzava il carico e il freno
    // leggeva SE STESSO. Anche a 8 core-unit divorati da uno, il secondo passa.
    expect(fleetCapacityLimit({ cores: CORE, fleetCores: 8, running: 1 })).toBe(2);
    expect(nuovi(8, 1)).toBe(1);
  });

  test("NON è autoavverante: agenti leggeri che partono lasciano la porta aperta", () => {
    // Il costo di uno slot nuovo è fisso, quindi ogni agente leggero che parte
    // consuma poco e lascia slot liberi: la coda non si stabilizza a uno.
    expect(nuovi(0.4, 1)).toBeGreaterThanOrEqual(5);
    expect(nuovi(0.8, 2)).toBeGreaterThanOrEqual(5);
    expect(nuovi(1.2, 3)).toBeGreaterThanOrEqual(4);
  });

  test("su una macchina minuscola la quota non scende sotto un core", () => {
    // Un core solo: metà core sarebbe zero slot per sempre, cioè una coda ferma.
    expect(fleetCapacityLimit({ cores: 1, fleetCores: 0, running: 0 })).toBe(2);
  });
});

describe("computeDispatchCapacity — la sonda della flotta, non il load average", () => {
  const cores = Math.max(1, os.cpus().length);
  const strutturale = structuralDispatchCapacity();
  const sonda = (coreUnits: number) => () => ({ coreUnits, cores });

  test("flotta quasi ferma: la raccomandazione resta il tetto strutturale, comunque sia carica la macchina", () => {
    // LA REGRESSIONE. Prima bastava un load alto (le app dell'umano, un'altra
    // suite in corso su questo stesso host) per scendere a 1. Ora il load della
    // macchina non entra più nel conto: se la flotta non consuma, non si frena.
    expect(computeDispatchCapacity(1, sonda(0.75)).recommended).toBe(strutturale);
  });

  test("flotta che ha saturato la quota: la raccomandazione scende al pavimento", () => {
    const c = computeDispatchCapacity(2, sonda(cores));
    expect(c.recommended).toBe(Math.min(strutturale, 2));
    expect(c.reason).toContain("quota");
  });

  test("senza sonda (Windows, cache fredda) resta il conto storico sul load average", () => {
    // «Non misurato» non è «zero»: il conto vecchio è impreciso ma è un numero,
    // e la sonda arriva al giro dopo. Quel che non deve succedere è una board
    // ferma perché un numero manca.
    const c = computeDispatchCapacity(0, () => null);
    expect(c.recommended).toBeGreaterThanOrEqual(1);
    expect(c.recommended).toBeLessThanOrEqual(strutturale);
    expect(c.reason).not.toContain("quota");
  });

  test("una sonda che esplode vale «non lo so», non fa cadere il tick", () => {
    expect(() => computeDispatchCapacity(1, () => { throw new Error("ps morto"); })).not.toThrow();
  });

  test("`running` entra nel conto: gli slot liberi si sommano a chi già gira", () => {
    // Senza, «la flotta tiene 3 core» non dice se sono tre agenti leggeri o uno
    // che compila, e il tetto direbbe a tre agenti vivi che ce ne stanno tre in
    // tutto: cioè si fermerebbe con mezza macchina libera.
    const fermo = computeDispatchCapacity(0, sonda(cores / 2 - 1)).recommended;
    const conTre = computeDispatchCapacity(3, sonda(cores / 2 - 1)).recommended;
    expect(conTre).toBeGreaterThanOrEqual(fermo);
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

/**
 * IL PAVIMENTO. Esiste perché il tetto ora si può togliere: senza, «nessun
 * limite» significa che la coda si ferma quando il disco è pieno, e un disco
 * pieno non rallenta — fa fallire le scritture SQLite del server.
 *
 * Il verso di ogni caso è lo stesso: **non sapere non è un motivo per bloccare**.
 * Una guardia che si chiude su una lettura fallita fermerebbe la board per un
 * path sbagliato, cioè causerebbe un guasto peggiore di quello che previene.
 */
describe("il pavimento sulle risorse", () => {
  test("con spazio non blocca", () => {
    expect(dispatchResourceBlock("/")).toBeNull();
  });

  test("un path che non si legge NON blocca: non sapere non è sapere di no", () => {
    expect(dispatchResourceBlock("/percorso/che/non/esiste/davvero")).toBeNull();
    expect(freeDiskGB("/percorso/che/non/esiste/davvero")).toBeNull();
  });

  test("misura GB veri, non blocchi", () => {
    const gb = freeDiskGB("/");
    expect(gb).not.toBeNull();
    // Un errore di unità qui (blocchi al posto di byte) darebbe un numero enorme
    // e il pavimento non morderebbe mai — il modo silenzioso in cui una guardia
    // diventa decorazione.
    expect(gb!).toBeLessThan(100_000);
    expect(gb!).toBeGreaterThan(0);
  });

  test("sotto il pavimento BLOCCA, e la frase porta il numero", () => {
    // Misura iniettata: il caso che conta è il disco quasi pieno, e aspettarlo
    // sul serio vorrebbe dire non provarlo mai.
    const msg = dispatchResourceBlock("/qualunque", () => 3.5);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("3.5 GB liberi");
    expect(msg!).toContain(String(DISPATCH_DISK_FLOOR_GB));
    // Una coda senza il perché è la coda invisibile: la frase deve dire anche
    // che non si è perso niente, o chi legge pensa che la card sia morta.
    expect(msg!).toContain("Riprendo");
  });

  test("un solo GB sopra il pavimento non blocca: la soglia è una soglia", () => {
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB + 1)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB - 0.1)).not.toBeNull();
  });
});
