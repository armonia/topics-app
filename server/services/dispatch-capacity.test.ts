import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { DISPATCH_DISK_FLOOR_GB, DISPATCH_MEM_FLOOR_GB, availableMemGB, computeDispatchCapacity, dispatchResourceBlock, effectiveDispatchCap, fleetSlotBudget, freeDiskGB, memoryTooTight, readGlobalCap, sizingDispatchCap, structuralDispatchCapacity } from "./dispatch-capacity";
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF, clampGlobalCap, isGlobalCapOff } from "../../shared/board";

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
  const memoriaLarga = () => DISPATCH_MEM_FLOOR_GB + 8;

  test("con spazio non blocca", () => {
    expect(dispatchResourceBlock("/", freeDiskGB, memoriaLarga)).toBeNull();
  });

  test("un path che non si legge NON blocca: non sapere non è sapere di no", () => {
    expect(dispatchResourceBlock("/percorso/che/non/esiste/davvero", freeDiskGB, memoriaLarga)).toBeNull();
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
    const msg = dispatchResourceBlock("/qualunque", () => 3.5, memoriaLarga);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("3.5 GB liberi");
    expect(msg!).toContain(String(DISPATCH_DISK_FLOOR_GB));
    // Una coda senza il perché è la coda invisibile: la frase deve dire anche
    // che non si è perso niente, o chi legge pensa che la card sia morta.
    expect(msg!).toContain("Riprendo");
  });

  test("un solo GB sopra il pavimento non blocca: la soglia è una soglia", () => {
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB + 1, memoriaLarga)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB, memoriaLarga)).toBeNull();
    expect(dispatchResourceBlock("/qualunque", () => DISPATCH_DISK_FLOOR_GB - 0.1, memoriaLarga)).not.toBeNull();
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
  const discoLargo = () => 999;

  test("con memoria in abbondanza NON blocca", () => {
    expect(dispatchResourceBlock("/qualunque", discoLargo, () => DISPATCH_MEM_FLOOR_GB + 8)).toBeNull();
  });

  test("sotto il pavimento BLOCCA, e la frase porta il numero", () => {
    const msg = dispatchResourceBlock("/qualunque", discoLargo, () => 2.1);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("2.1 GB disponibili");
    expect(msg!).toContain(String(DISPATCH_MEM_FLOOR_GB));
    expect(msg!).toContain("Riprendo");
  });

  test("la soglia è una soglia, e il verso è «sotto blocca»", () => {
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
    expect(dispatchResourceBlock("/qualunque", discoLargo, () => null)).toBeNull();
  });

  test("una sonda che esplode non ferma la coda", () => {
    expect(
      dispatchResourceBlock("/qualunque", discoLargo, () => { throw new Error("vm_stat non c'è"); }),
    ).toBeNull();
  });

  test("il disco vince sulla memoria: una frase sola per card", () => {
    // Entrambi sotto: due frasi insieme sono rumore, e il disco va per primo
    // perché un disco pieno ROMPE (scritture SQLite) mentre la RAM degrada.
    const msg = dispatchResourceBlock("/qualunque", () => 1, () => 1);
    expect(msg!).toContain("Disco quasi pieno");
    expect(msg!).not.toContain("Memoria quasi finita");
  });

  test("legge vm_stat davvero: pagine libere + speculative + inattive", () => {
    // Un vm_stat finto ma nella forma vera, cosi' l'unita' e' verificata senza
    // dipendere da quanta RAM ha la macchina che esegue la suite.
    // 65536 pagine da 16384 byte = 1,073 GB per ciascuna delle tre voci.
    const finto = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                65536.",
      "Pages active:                             700000.",
      "Pages inactive:                            65536.",
      "Pages speculative:                         65536.",
      "Pages throttled:                               0.",
    ].join("\n");
    const gb = availableMemGB(() => finto);
    expect(gb).not.toBeNull();
    // 3 x 65536 x 16384 / 1e9 = 3,221 GB. Un errore di unita' (pagine contate
    // come byte) darebbe 0,0002 e il pavimento morderebbe SEMPRE.
    expect(gb!).toBeCloseTo(3.221, 2);
  });

  test("le pagine ATTIVE non contano: sono in uso, non disponibili", () => {
    // La riga `Pages active` del campione sopra vale 700000 pagine, cioe' 11,5
    // GB: se finisse nel totale il pavimento non morderebbe mai su una macchina
    // piena, che e' precisamente il caso per cui esiste.
    const conAttive = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                65536.",
      "Pages active:                             700000.",
      "Pages inactive:                            65536.",
      "Pages speculative:                         65536.",
    ].join("\n");
    expect(availableMemGB(() => conAttive)!).toBeLessThan(4);
  });

  test("un output illeggibile vale «non lo so», non una sottostima", () => {
    // Una voce mancante e il totale sarebbe piu' basso del vero, cioe' un
    // pavimento che morde quando non deve: peggio del non sapere.
    expect(availableMemGB(() => "roba che non e' vm_stat")).toBeNull();
    expect(availableMemGB(() => "Pages free: 100.\nPages inactive: 50.")).toBeNull(); // manca page size
    expect(availableMemGB(() => null)).toBeNull();
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
  // I core li chiediamo AL MODULO, non a `os.cpus()`.
  //
  // Non è pignoleria: con `os.cpus().length` questo blocco è caduto una volta
  // nella suite intera e mai da solo, perché sotto carico quella lettura sa
  // tornare vuota (vedi `server/lib/machine-cores.ts`). Un test che chiede la
  // stessa cosa da una porta diversa può rispondersi «un core» mentre il codice
  // sotto misura ne vede dodici, e allora il rosso non parla del codice: parla
  // di quanto era occupata la macchina che lo eseguiva.
  const cores = computeDispatchCapacity(0, () => null).cores;

  test("macchina satura ma carico NON nostro: il tetto resta quello strutturale", () => {
    // La sonda della flotta dice «noi teniamo un decimo di core». Qualunque
    // cosa stia facendo il resto della macchina, il tetto non si ritira.
    const cap = computeDispatchCapacity(0, () => ({ coreUnits: 0.1, cores }));
    expect(cap.recommended).toBe(structuralDispatchCapacity());
    expect(cap.oursCores).toBe(0.1);
    expect(cap.reason).toContain("di quota");
  });

  test("carico NOSTRO oltre la quota: il tetto scende e la riga dice da cosa", () => {
    const strutturale = structuralDispatchCapacity();
    // La flotta si mangia quattro volte la sua quota: il residuo va a zero e
    // resta solo il pavimento, che è 2 e non 1 apposta.
    const cap = computeDispatchCapacity(1, () => ({ coreUnits: cores * 4, cores }));
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
