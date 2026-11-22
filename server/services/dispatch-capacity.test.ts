/**
 * The concurrency cap the dispatcher claims against: the global switch row,
 * the effective cap right now, and the structural capacity of the machine.
 * @covers KANBAN-07
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { DISPATCH_MEM_FLOOR_GB, DISPATCH_MEM_FLOOR_NATIVE_GB, GB_PER_AGENT_CLI, GB_PER_AGENT_NATIVE, availableMemGB, computeDispatchCapacity, effectiveDispatchCap, freeDiskGB, readGlobalCap, sizingDispatchCap, structuralDispatchCapacity, probeVm } from "./dispatch-capacity";

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
  test("non guarda il carico: due readings di fila danno lo stesso numero", () => {
    // La raccomandazione viva può saltare fra due chiamate (il load si muove);
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
    // A riposo il carico non morde e le due readings coincidono; underCeiling carico la
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
  test("misura GB veri, non blocchi", () => {
    const gb = freeDiskGB("/");
    expect(gb).not.toBeNull();
    // Un errore di unità qui (blocchi al posto di byte) darebbe un numero enorme
    // e il pavimento non morderebbe mai — il modo silenzioso in cui una guardia
    // diventa decorazione.
    expect(gb!).toBeLessThan(100_000);
    expect(gb!).toBeGreaterThan(0);
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

  test("P1: the probe keeps the swap TOTAL of the same `vm.swapusage` line", async () => {
    const got = await probeVm(async (argv) => argv[0] === "/usr/bin/vm_stat"
      ? "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 9123456.\nPages occupied by compressor: 476226."
      : "total = 16384.00M  used = 15805.31M  free = 578.69M  (encrypted)", "darwin");
    expect(got!.swapUsedMB).toBeCloseTo(15_805.31, 2);
    // Thrown away until 16/09/2026, and it is the whole second door: without it
    // `swapVerdict` cannot tell a machine at its ceiling from a calm one.
    expect(got!.swapTotalMB).toBeCloseTo(16_384, 2);
    const mute = await probeVm(async (argv) => argv[0] === "/usr/bin/vm_stat" ? "page size of 16384 bytes" : null, "darwin");
    expect(mute!.swapTotalMB).toBeNull();
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

  // The memory figures the panel can explain a memory hold with. Which axis
  // blocks travels as `admission`, from the dispatcher (task-dispatcher-pressure).
  test("the wire carries what one agent costs in memory and the share of the free it is compared with", () => {
    // 5 GB, over the 4 GB floor a card is priced at when nothing is measured.
    const priceList = { coreUnits: () => [0.5], memGB: () => [5] };
    const cap = computeDispatchCapacity(
      4, () => fleetReading({ coreUnits: 0.2, cores }), false, () => 0.3,
      { share: 0.8, frozen: 0 }, priceList,
    );
    expect(cap.agentCostMemGB).toBe(5);
    // Rounded to one decimal like every other figure on the wire: 0.8 x 0.3.
    expect(cap.freeQuotaMemGB).toBe(0.2);
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

  test("il pavimento nativo deve stare SOPRA il prezzo di un posto", () => {
    // THE LESSON OF 2026-09-10, as an invariant instead of a number. The floor
    // governs the NEXT admission, so it has to leave room for the card it is
    // about to let in. With the old pair (floor 2, seat 0,25) it did not: the
    // gate opened at 2 GB for a card whose checks then asked ~1,5, which is how
    // seven cards were admitted onto a Mac that then froze.
    expect(DISPATCH_MEM_FLOOR_NATIVE_GB).toBeGreaterThan(GB_PER_AGENT_NATIVE);
    expect(DISPATCH_MEM_FLOOR_GB).toBeGreaterThan(GB_PER_AGENT_CLI);
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

describe("the memory probe under launchd", () => {
  // launchd starts the server with a PATH that has no /usr/sbin: a bare
  // `sysctl` made every swap reading null on the live server (15/09/2026), and
  // with it the swap verdict and the brake.
  test("every binary is spawned by absolute path, and the swap reading reaches the sample", async () => {
    const spawned: string[][] = [];
    const sample = await probeVm(async (argv) => {
      spawned.push(argv);
      if (argv[0]!.endsWith("vm_stat")) {
        return "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 3550.\nPages speculative: 100.\nPages purgeable: 10.\nFile-backed pages: 200000.\nPages occupied by compressor: 656466.\nSwapins: 23380813.\n";
      }
      return "total = 15360.00M  used = 13993.56M  free = 1366.44M  (encrypted)";
    }, "darwin");
    for (const argv of spawned) expect(argv[0]!.startsWith("/")).toBe(true);
    expect(spawned.map((a) => a[0])).toEqual(["/usr/bin/vm_stat", "/usr/sbin/sysctl"]);
    expect(sample?.swapUsedMB).toBe(13993.56);
    expect(sample?.swapins).toBe(23380813);
  });
});
