/**
 * The concurrency cap the dispatcher claims against: the global switch row,
 * the effective cap right now, and the structural capacity of the machine.
 * @covers KANBAN-07
 */
import { test, expect, describe } from "bun:test";
import os from "os";
import { Database } from "bun:sqlite";
import { DISPATCH_DISK_FLOOR_GB, DISPATCH_MEM_FLOOR_GB, DISPATCH_MEM_FLOOR_NATIVE_GB, GB_PER_AGENT_CLI, GB_PER_AGENT_NATIVE, availableMemGB, computeDispatchCapacity, dispatchResourceBlock, effectiveDispatchCap, fleetSlotBudget, freeDiskGB, memoryTooTight, readGlobalCap, sizingDispatchCap, structuralDispatchCapacity, compressorGB, swapoutPages } from "./dispatch-capacity";
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF, clampGlobalCap, isGlobalCapOff } from "../../shared/board";
import type { FleetLoadReading } from "../lib/fleet-usage";

/** A fleet reading with only the two fields the count cap looks at written by
 *  hand: the budget terms default to "nothing else of ours, nobody else busy",
 *  which is what these cases were always assuming. */
const fleetReading = (p: { coreUnits: number; cores: number }): FleetLoadReading =>
  ({ ...p, scriptsCoreUnits: 0, otherCoreUnits: 0, memGB: 0 });

function dbConImpostazioni(): Database {
  const db = new Database(":memory:");
  // migration 20260816112635: l'interruttore GLOBALE dell'auto-dispatch vive in
  // `app_settings`, non piu' sulla riga '*' di `board_settings`.
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)`);
  db.run(`INSERT OR IGNORE INTO app_settings (id, auto_dispatch) VALUES (1, 0)`);
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

describe("effectiveDispatchCap — quanti agenti insieme, now", () => {
  test("in auto vince la raccomandazione viva della macchina", () => {
    expect(effectiveDispatchCap({ auto: true, max: 8 }, 3)).toBe(3);
  });

  test("senza sonda si ricade sul numero fisso, anche in auto", () => {
    expect(effectiveDispatchCap({ auto: true, max: 8 }, null)).toBe(8);
  });

  test("con un numero scelto a mano la sonda non conta", () => {
    expect(effectiveDispatchCap({ auto: false, max: 2 }, 7)).toBe(2);
  });

  test("mai underCeiling 1: un tetto di zero non è prudenza, è una board ferma", () => {
    expect(effectiveDispatchCap({ auto: true, max: 0 }, 0)).toBe(1);
    expect(effectiveDispatchCap({ auto: false, max: -3 }, null)).toBe(1);
  });
});

describe("structuralDispatchCapacity — quanti ne regge in REGIME, non now", () => {
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
    // A riposo il carico non morde e le due letture coincidono; underCeiling carico la
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
  /**
   * Memoria fissata, e non e' pigrizia: questi casi giudicano il DISCO, e
   * `dispatchResourceBlock` legge di sua iniziativa anche la RAM della macchina
   * che esegue la suite. Lasciandola vera, il verde di «con spazio non blocca»
   * dipenderebbe da quanti Chrome sono aperti mentre gira il test — misurato il
   * 2026-08-16: 12,09 GB disponibili contro un pavimento di 12, cioe' a un
   * decimo dal rosso. E' lo stesso difetto gia' pagato in tasks.test.ts, dove
   * un test misurava il TMPDIR di chi lo lanciava.
   */
  const wideMemory = () => DISPATCH_MEM_FLOOR_GB + 8;

  test("con spazio non blocca", () => {
    expect(dispatchResourceBlock("/", freeDiskGB, wideMemory)).toBeNull();
  });

  test("un path che non si legge NON blocca: non sapere non è sapere di no", () => {
    expect(dispatchResourceBlock("/percorso/che/non/esiste/davvero", freeDiskGB, wideMemory)).toBeNull();
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

  test("underCeiling il pavimento BLOCCA, e la frase porta il numero", () => {
    // Misura iniettata: il caso che conta è il disco quasi pieno, e aspettarlo
    // sul serio vorrebbe dire non provarlo mai.
    const msg = dispatchResourceBlock("/qualunque", () => 3.5, wideMemory);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("3.5 GB liberi");
    expect(msg!).toContain(String(DISPATCH_DISK_FLOOR_GB));
    // Una coda senza il perché è la coda invisibile: la frase deve dire anche
    // che non si è perso niente, o chi legge pensa che la card sia morta.
    expect(msg!).toContain("Riprendo");
  });

  test("un solo GB sopra il pavimento non blocca: la soglia è una soglia", () => {
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB + 1, wideMemory)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB, wideMemory)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB - 0.1, wideMemory)).not.toBeNull();
  });
});

/**
 * IL PAVIMENTO SULLA MEMORIA.
 *
 * Provato nei DUE versi di proposito: un pavimento che scatta sempre non è una
 * guardia, è il dispatch spento, e sarebbe verde in un test che controlla solo
 * «blocca quando la RAM è finita». Il caso che tiene onesto questo file è
 * l'altro — con memoria in abbondanza NON deve mordere.
 *
 * La sonda è iniettata ovunque: leggerla dalla macchina vera renderebbe
 * l'asserzione dipendente da cosa gira mentre la suite passa, che è esattamente
 * il difetto già pagato altrove in questo repo.
 */
describe("il pavimento sulla memoria", () => {
  // Disco largo: qui si giudica solo la RAM, e con un disco pieno la prima
  // frase vincerebbe sempre nascondendo la seconda.
  const wideDisk = () => 999;

  test("con memoria in abbondanza NON blocca", () => {
    expect(dispatchResourceBlock("/qualunque", wideDisk, () => DISPATCH_MEM_FLOOR_GB + 8)).toBeNull();
  });

  test("underCeiling il pavimento BLOCCA, e la frase porta il numero", () => {
    const msg = dispatchResourceBlock("/qualunque", wideDisk, () => 2.1);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("2.1 GB disponibili");
    expect(msg!).toContain(String(DISPATCH_MEM_FLOOR_GB));
    expect(msg!).toContain("Riprendo");
  });

  test("la soglia è una soglia, e il verso è «underCeiling blocca»", () => {
    expect(memoryTooTight(DISPATCH_MEM_FLOOR_GB + 0.1)).toBe(false);
    expect(memoryTooTight(DISPATCH_MEM_FLOOR_GB)).toBe(false);
    expect(memoryTooTight(DISPATCH_MEM_FLOOR_GB - 0.1)).toBe(true);
  });

  test("non sapere non è sapere di no: sonda muta = via libera", () => {
    // Stessa regola del disco. Su Linux e Windows la sonda non c'è affatto, e
    // un `null` trattato come «zero GB» spegnerebbe il dispatch su ogni host
    // che non sia un Mac.
    expect(memoryTooTight(null)).toBe(false);
    expect(memoryTooTight(Number.NaN)).toBe(false);
    expect(dispatchResourceBlock("/qualunque", wideDisk, () => null)).toBeNull();
  });

  test("una sonda che throws non ferma la coda", () => {
    expect(
      dispatchResourceBlock("/qualunque", wideDisk, () => { throw new Error("vm_stat non c'è"); }),
    ).toBeNull();
  });

  test("il disco vince sulla memoria: una frase sola per card", () => {
    // Entrambi underCeiling: due frasi insieme sono rumore, e il disco va per primo
    // perché un disco pieno ROMPE (scritture SQLite) mentre la RAM degrada.
    const msg = dispatchResourceBlock("/qualunque", () => 1, () => 1);
    expect(msg!).toContain("Disco quasi pieno");
    expect(msg!).not.toContain("Memoria quasi finita");
  });

  /** A synthetic `vm_stat` with four equal entries, so the arithmetic reads at
   *  a glance: the four that count are 65536 pages, the others are not. */
  const finto = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                65536.",
    "Pages active:                             700000.",
    "Pages inactive:                           400000.",
    "Pages speculative:                         65536.",
    "Pages throttled:                               0.",
    "Pages purgeable:                           65536.",
    "File-backed pages:                         65536.",
    "Anonymous pages:                          800000.",
    "Pages occupied by compressor:             100000.",
  ].join("\n");

  test("il pavimento resta coerente col numero nuovo: la sera NO, la macchina sana SI'", () => {
    // ITEM 3 DELLA CARD, e il verso che non si vede: cambiando il significato
    // di `availableMemGB` senza ritoccare `DISPATCH_MEM_FLOOR_GB` si poteva
    // rendere il cancello molto piu' severo SENZA cambiare un numero - una
    // politica nuova entrata di soppiatto, col silenzio come sintomo. Qui i due
    // campioni veri passano dal pavimento VERO, non da una soglia di comodo.
    const thatNight = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                 4877.",
      "Pages inactive:                           586288.",
      "Pages speculative:                           876.",
      "Pages purgeable:                            5000.",
      "File-backed pages:                        100000.",
      "Pages occupied by compressor:            1712833.",
    ].join("\n");
    const healthy = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               49689.",
      "Pages inactive:                          695839.",
      "Pages speculative:                        36974.",
      "Pages purgeable:                          26839.",
      "File-backed pages:                       705344.",
      "Pages occupied by compressor:            316162.",
    ].join("\n");

    const gate = (vm: string) => dispatchResourceBlock(
      "/qualunque", () => 500, () => availableMemGB(() => vm), true,
    );

    expect(gate(thatNight)).not.toBeNull();   // the night of 2026-09-10: refuse
    expect(gate(healthy)).toBeNull();         // healthy machine: admit

    // E il margine sul verso «sano» si dichiara, perche' e' sottile: se un
    // domani scendesse sotto il pavimento, il cancello smetterebbe di
    // dispacciare su una macchina in salute e questo test lo direbbe subito.
    expect(availableMemGB(() => healthy)!).toBeGreaterThan(DISPATCH_MEM_FLOOR_GB);
  });

  test("la somma e' cio' che si ottiene SENZA far lavorare il disco", () => {
    // free 65536 + speculative 65536 + purgeable 65536 + file-backed 65536
    // = 4 x 65536 x 16384 / 1e9 = 4,295 GB. A unit error (pages counted as
    // bytes) would give 0,0002 and the floor would bite ALWAYS.
    const gb = availableMemGB(() => finto);
    expect(gb).not.toBeNull();
    expect(gb!).toBeCloseTo(4.295, 2);
  });

  test("le pagine ATTIVE non contano: sono in uso, non disponibili", () => {
    // The sample's `Pages active` line is 700000 pages, i.e. 11,5 GB: if it
    // entered the total the floor would never bite on a full machine, which is
    // precisely the case it exists for.
    expect(availableMemGB(() => finto)!).toBeLessThan(5);
  });

  test("le INATTIVE non contano piu', ed e' il difetto del 10/09", () => {
    // THE SAMPLE IS THE REAL NIGHT, rebuilt from the measured figures: free
    // 4.877, inactive 586.288, compressor 1.712.833 pages (26 GB of 32),
    // 258.707 swapouts. `Pages speculative` is calibrated so that the OLD sum
    // (free+speculative+inactive) reproduces the 9,7 GB it reported that night;
    // purgeable and file-backed were not recorded, so here they are DELIBERATELY
    // generous - 100.000 pages of cache, 1,6 GB - and the verdict has to hold
    // anyway. With 26 GB in the compressor the real cache was far less than
    // that: the test is harsher on itself than the machine was.
    const thatNight = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                 4877.",
      "Pages active:                             900000.",
      "Pages inactive:                           586288.",
      "Pages speculative:                           876.",
      "Pages purgeable:                            5000.",
      "File-backed pages:                        100000.",
      "Anonymous pages:                         1400000.",
      "Pages occupied by compressor:            1712833.",
    ].join("\n");

    const old = (4877 + 876 + 586288) * 16384 / 1e9;
    expect(old).toBeCloseTo(9.7, 1); // the number that admitted, for the record

    const now = availableMemGB(() => thatNight);
    expect(now).not.toBeNull();
    expect(now!).toBeLessThan(2);
    // And the floor bites: the verdict that never arrived that night.
    expect(memoryTooTight(now, DISPATCH_MEM_FLOOR_GB)).toBe(true);
    expect(memoryTooTight(old, DISPATCH_MEM_FLOOR_GB)).toBe(true);
  });

  test("su una macchina SANA la somma nuova non e' piu' stretta della old", () => {
    // The symmetric risk, and the more insidious one: a correct probe that
    // reports "exhausted" on a healthy Mac switches dispatch off forever, and
    // nobody notices because the symptom is silence. This sample is the REAL
    // `vm_stat` of this machine once the work was done.
    const healthy = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               49689.",
      "Pages active:                            714234.",
      "Pages inactive:                          695839.",
      "Pages speculative:                        36974.",
      "Pages purgeable:                          26839.",
      "File-backed pages:                       705344.",
      "Anonymous pages:                         741703.",
      "Pages occupied by compressor:            316162.",
    ].join("\n");
    const old = (49689 + 36974 + 695839) * 16384 / 1e9;
    const now = availableMemGB(() => healthy)!;
    expect(old).toBeCloseTo(12.8, 1);
    expect(now).toBeCloseTo(13.4, 1);
    // The two agree within half a gigabyte: where the inactive pages REALLY are
    // cache, the new sum says the same thing. It discriminates where that
    // matters and stays quiet where it does not.
    expect(Math.abs(now - old)).toBeLessThan(1);
  });

  test("un output illeggibile vale «non lo so», non una sottostima", () => {
    // A missing entry would make the total lower than the truth, i.e. a floor
    // that bites when it must not: worse than not knowing.
    expect(availableMemGB(() => "roba che non e' vm_stat")).toBeNull();
    expect(availableMemGB(() => "Pages free: 100.\nPages inactive: 50.")).toBeNull(); // manca page size
    expect(availableMemGB(() => null)).toBeNull();
    // "File-backed pages" has the words the other way round: read with the
    // `Pages <name>` pattern it would yield NaN, hence `null`, hence a gate that
    // stops measuring without saying so. The sample above contains it and is
    // NOT null: this line is what proves the right pattern is in use.
    const withoutFileBacked = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                65536.",
      "Pages speculative:                         65536.",
      "Pages purgeable:                           65536.",
    ].join("\n");
    expect(availableMemGB(() => withoutFileBacked)).toBeNull();
  });

  test("le DUE righe del compressore non sono la stessa cosa, e il codice legge quella fisica", () => {
    // THE DEFECT THIS TEST PINS. `vm_stat` exposes `Pages stored in compressor`
    // (logical compressed pages) and `Pages occupied by compressor` (physical
    // RAM held): on the night of 2026-09-10 they stood at 2,8:1. The first
    // draft of this work took 1.712.833 - the `stored` line - called it
    // `occupied` and set a one-third ceiling on top of it. With the line the
    // code actually reads, the share that night was 0,291, BELOW the ceiling:
    // the guard would not have fired on the night it was written for.
    //
    // The arithmetic settles which line is which, with nobody to take on trust:
    // 1.712.833 pages are 28,1 GB, and with 9,6 GB inactive and 0,08 free that
    // is 37,7 GB on a 34,36 GB machine. They do not fit.
    const thatNight = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages stored in compressor:              1712833.",
      "Pages occupied by compressor:             610054.",
      "Swapouts:                                 258707.",
    ].join("\n");
    const physical = compressorGB(() => thatNight)!;
    expect(physical).toBeCloseTo(10.0, 1);          // occupied, not stored
    expect(physical / 34.36).toBeCloseTo(0.291, 2); // the real share that night
    expect(1712833 * 16384 / 1e9).toBeCloseTo(28.1, 1); // stored: 2,8x, would not fit

    const healthy = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
      + "Pages occupied by compressor:             314558.\n"
      + "Swapouts:                                 258707.";
    expect(compressorGB(() => healthy)!).toBeCloseTo(5.15, 1);

    // The CUMULATIVE swapouts are identical in the two samples, and it is the
    // most eloquent fact of the night: since the crisis ended the machine has
    // not swapped a single page. A counter, not a rate: the difference between
    // two readings is the rate, and a reading with no previous base is not
    // zero, it is "I do not know" - the same rule as `makeInstantCpu`.
    expect(swapoutPages(() => thatNight)).toBe(258707);
    expect(swapoutPages(() => healthy)).toBe(258707);
    expect(swapoutPages(() => "niente")).toBeNull();
    expect(swapoutPages(() => null)).toBeNull();
  });

  test("nessun tetto sul compressore: il cancello ha UN solo segnale sulla memoria", () => {
    // The direction that stops an untunable guard from creeping back in. With
    // memory to spare the gate admits WHATEVER the compressor is doing: if
    // somebody later put a threshold back without a measurement under load to
    // justify it, this test would say so.
    expect(dispatchResourceBlock("/qualunque", () => 500, () => 20, true)).toBeNull();
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
    // Il caso del 12/08, numeri veri: load 13 su 12 core, ma la NOSTRA flotta a
    // 0,75 core. Il vecchio conto dava 1 slot. Qui la quota è quasi intatta,
    // perché il load della macchina non è un ingresso di questa funzione: gli
    // unici due sono quanto teniamo NOI e quanti siamo.
    expect(su12(0.75, 0).slots).toBe(5);
    expect(su12(0.75, 0).freeCores).toBeCloseTo(5.25, 5);
  });

  test("agenti che compilano: il tetto scende underCeiling lo strutturale", () => {
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
  // I core li chiediamo AL MODULO, non a `os.cpus()`.
  //
  // Non è pignoleria: con `os.cpus().length` questo blocco è caduto una volta
  // nella suite intera e mai da solo, perché underCeiling carico quella lettura sa
  // tornare vuota (vedi `server/lib/machine-cores.ts`). Un test che chiede la
  // stessa cosa da una porta diversa può rispondersi «un core» mentre il codice
  // underCeiling misura ne vede dodici, e allora il rosso non parla del codice: parla
  // di quanto era occupata la macchina che lo eseguiva.
  const cores = computeDispatchCapacity(0, () => null).cores;

  test("macchina satura ma carico NON nostro: il tetto resta quello strutturale", () => {
    // La sonda della flotta dice «noi teniamo un decimo di core». Qualunque
    // cosa stia facendo il resto della macchina, il tetto non si ritira.
    const cap = computeDispatchCapacity(0, () => fleetReading({ coreUnits: 0.1, cores }));
    expect(cap.recommended).toBe(structuralDispatchCapacity());
    expect(cap.oursCores).toBe(0.1);
    expect(cap.reason).toContain("di quota");
  });

  test("carico NOSTRO overCeiling la quota: il tetto scende e la riga dice da cosa", () => {
    const strutturale = structuralDispatchCapacity();
    // La flotta si mangia quattro volte la sua quota: il residuo va a zero e
    // resta solo il pavimento, che è 2 e non 1 apposta.
    const cap = computeDispatchCapacity(1, () => fleetReading({ coreUnits: cores * 4, cores }));
    expect(cap.recommended).toBe(Math.min(strutturale, 2));
    expect(cap.reason).toContain("di quota");
    // «Ridotto» si può dire solo se c'era qualcosa da ridurre. Su una macchina
    // così piccola che il tetto strutturale è già il pavimento (due o meno) il
    // freno non ha spazio per mordere, e la riga giustamente non lo dice.
    if (strutturale > 2) expect(cap.reason).toContain("ridotto a");
  });

  test("senza sonda (Windows, cache fredda) resta il conto storico sul load", () => {
    const cap = computeDispatchCapacity(0, () => null);
    expect(cap.oursCores).toBeNull();
    expect(cap.recommended).toBeGreaterThanOrEqual(1);
    expect(cap.reason).not.toContain("di quota");
  });

  test("una sonda che throws vale «non lo so», non un tick caduto", () => {
    const cap = computeDispatchCapacity(0, () => { throw new Error("ps morto"); });
    expect(cap.oursCores).toBeNull();
    expect(cap.recommended).toBeGreaterThanOrEqual(1);
  });

  test("`running` non gonfia mai il tetto overCeiling lo strutturale", () => {
    const cap = computeDispatchCapacity(99, () => fleetReading({ coreUnits: 0, cores }));
    expect(cap.recommended).toBe(structuralDispatchCapacity());
  });
});

/**
 * IL PAVIMENTO DEVE SAPERE COSA COSTA UN AGENTE.
 *
 * Tutta la taratura a 12 GB misura una CLI: 240 MB fermi, 320-420 al lavoro,
 * cinque agenti veri più il margine per chi sta usando il Mac. Col runtime
 * nativo un agente costa 2,3 MB — dieci ne costano meno di UNO con la CLI — e
 * tenere lo stesso margine ferma la coda su una macchina che sta benissimo.
 *
 * Non è teoria: il 2026-08-16 il dispatch era blocked con 8,7 GB liberi
 * mentre gli agenti che doveva lanciare ne avrebbero chiesti venti di megabyte.
 */
describe("il pavimento della memoria segue il runtime", () => {
  const disco = () => 500; // disco largo: qui si guarda solo la RAM
  const ram = (gb: number) => () => gb;

  test("con le CLI: 8,7 GB non bastano, ed è giusto", () => {
    const r = dispatchResourceBlock("/tmp", disco, ram(8.7), true);
    expect(r).toBeTruthy();
    expect(r).toContain("pavimento di 12 GB");
    expect(r).toContain("240 MB");
  });

  test("il cancello scatta a SEI e non a una soglia derivata", () => {
    // Written because it was got wrong twice in one night, in both directions:
    // once reading the CLI constant (12) instead of the native one, once
    // inventing a "margin minus seat price" threshold at 7,50 that exists
    // nowhere. There is no derived threshold: `byMem` divides TOTAL memory, not
    // available, so the only rule on available memory is this one.
    const disk = () => 500;
    const open = (gb: number) => dispatchResourceBlock("/tmp", disk, () => gb, false) === null;
    expect(open(7.39)).toBe(true);   // worst healthy peak measured under load
    expect(open(6.01)).toBe(true);
    expect(open(5.99)).toBe(false);
  });

  test("il pavimento nativo deve stare SOPRA il prezzo di un posto", () => {
    // THE LESSON OF 2026-09-10, as an invariant instead of a number. The floor
    // governs the NEXT admission, so it has to leave room for the card it is
    // about to let in. With the old pair (floor 2, seat 0,25) it did not: the
    // gate opened at 2 GB for a card whose checks then asked ~1,5, which is how
    // seven cards were admitted onto a Mac that then froze.
    expect(DISPATCH_MEM_FLOOR_NATIVE_GB).toBeGreaterThan(GB_PER_AGENT_NATIVE);
    expect(DISPATCH_MEM_FLOOR_GB).toBeGreaterThan(GB_PER_AGENT_CLI);
  });

  test("col runtime nativo: gli stessi 8,7 GB sono abbondanti", () => {
    // LA RIGA CHE CONTA: stessa macchina, stessa lettura, coda che riparte.
    expect(dispatchResourceBlock("/tmp", disco, ram(8.7), false)).toBeNull();
  });

  test("il pavimento nativo esiste comunque: sotto la soglia si ferma anche lui", () => {
    // Non è zero: il server tiene le conversazioni in memoria e i tool leggono
    // file. Una macchina già in swap non deve peggiorare comunque.
    const r = dispatchResourceBlock("/tmp", disco, ram(1.5), false);
    expect(r).toBeTruthy();
    // The number is READ from the constant, not copied: this test went red when
    // the floor moved from 2 to 6, and a test that has to be edited every time
    // the value it guards changes is guarding the digit, not the behaviour.
    expect(r).toContain(`pavimento di ${DISPATCH_MEM_FLOOR_NATIVE_GB} GB`);
    // E il messaggio dice il costo GIUSTO: citare i 240 MB della CLI qui
    // manderebbe a cercare la causa nel posto sbagliato.
    expect(r).not.toContain("240 MB");
    // Both halves, and the second is the one that was missing: the session is
    // cheap, what the session LAUNCHES is not, and a message that only says
    // "2,3 MB" reads as "there is no room for nothing" - which is what sent the
    // 10/09 diagnosis after the wrong cause.
    expect(r).toContain("2,3 MB");
    expect(r).toContain("1,5 GB");
  });

  test("il disco viene prima della RAM, su entrambi i runtime", () => {
    // Un disco pieno rompe (SQLite smette di scrivere) mentre la RAM degrada:
    // l'ordine non cambia col runtime.
    for (const processi of [true, false]) {
      const r = dispatchResourceBlock("/tmp", () => 1, ram(0.5), processi);
      expect(r).toContain("Disco quasi pieno");
    }
  });

  test("una misura assente non ferma la coda, con nessuno dei due pavimenti", () => {
    // «Non lo so» non è «zero»: un errore di lettura fermerebbe tutto per
    // sempre. Vale identico sulle due strade.
    expect(dispatchResourceBlock("/tmp", () => null, () => null, true)).toBeNull();
    expect(dispatchResourceBlock("/tmp", () => null, () => null, false)).toBeNull();
  });
});

/**
 * IL PREZZO DI AMMISSIONE SEGUE IL RUNTIME.
 *
 * Il pavimento sapeva già distinguere una CLI da una sessione nativa; il TETTO
 * no, e prenotava 3 GB a testa anche per sessioni che ne costano 2,3 di
 * megabyte. Su questa macchina (34 GB) il conto dava 11 posti e non mordeva,
 * ma su una macchina piccola sì: 8 GB di RAM davano DUE posti a un runtime che
 * ne regge decine, ed è lì che i task partivano a scaglioni.
 *
 * I test non leggono la RAM di chi li esegue: fissano il caso che conta (la
 * macchina piccola) ragionando sui due divisori, così l'asserzione non dipende
 * dall'host che fa girare la suite.
 */
describe("il tetto conosce il runtime: 3 GB per una CLI, 0,25 per una sessione nativa", () => {
  test("i due prezzi non sono lo stesso numero, e il nativo costa molto meno", () => {
    // Se un giorno qualcuno li riallinea, i test qui underCeiling passerebbero per
    // caso: questa riga è la sentinella che rende visibile la regressione.
    expect(GB_PER_AGENT_NATIVE).toBeLessThan(GB_PER_AGENT_CLI);
  });

  test("col runtime nativo la RAM non è più il vincolo che stringe", () => {
    // `byMem` col nativo vale `RAM / 0,25` — su qualunque macchina che regga
    // Topics è ≥ 8, cioè il tetto massimo automatico. Quindi il numero che
    // comanda deve essere quello dei CORE, mai più quello della memoria.
    const native = structuralDispatchCapacity(false);
    const cli = structuralDispatchCapacity(true);
    expect(native).toBeGreaterThanOrEqual(cli);
  });

  test("il default resta la CLI: chi non passa niente ottiene il conto prudente", () => {
    // Un parametro con default sbagliato allarga il tetto di nascosto su ogni
    // chiamante che non è stato aggiornato. Il default deve essere il vecchio
    // comportamento, e questo lo inchioda.
    expect(structuralDispatchCapacity()).toBe(structuralDispatchCapacity(true));
  });

  test("stessa regola in `computeDispatchCapacity`, non solo nella strutturale", () => {
    // Le due funzioni rispondono a domande diverse ma dividono per lo stesso
    // prezzo: se una imparasse il runtime e l'altra no, il tetto e il divisore
    // della quota direbbero due cose diverse sulla stessa macchina.
    const probe = () => fleetReading({ coreUnits: 0, cores: 12 });
    const native = computeDispatchCapacity(0, probe, false).recommended;
    const cli = computeDispatchCapacity(0, probe, true).recommended;
    expect(native).toBeGreaterThanOrEqual(cli);
  });
});
