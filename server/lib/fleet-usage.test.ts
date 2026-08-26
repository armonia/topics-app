/**
 * @covers RES-ATTR-01
 *
 * The server attributes every process to the session hosting it.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  parseCpuTimeSeconds,
  parsePsRows,
  summarizeFleet,
  resolveFleetRoots,
  registerFleetSocket,
  _resetFleetSockets,
  _resetFleetUsageCache,
  getFleetUsage,
  type PsRow,
} from "./fleet-usage";

describe("parsePsRows", () => {
  it("keeps the command intact when it contains spaces", () => {
    const rows = parsePsRows(
      "  100     1  12345   3.4 1:23.45 /usr/bin/node /path/to/pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 100,
      ppid: 1,
      rssKB: 12345,
      cpu: 3.4,
      cpuSeconds: 83.45,
      command: "/usr/bin/node /path/to/pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock",
    });
  });

  it("skips the header and any malformed line instead of throwing", () => {
    const rows = parsePsRows("  PID  PPID   RSS %CPU TIME COMMAND\n\ngarbage\n 7 1 100 0.0 0:00.10 bun\n");
    expect(rows.map(r => r.pid)).toEqual([7]);
  });
});

describe("resolveFleetRoots", () => {
  beforeEach(_resetFleetSockets);

  it("finds a sidecar by its --socket argument, never by ppid", () => {
    registerFleetSocket("pty-bridge", "/tmp/topics-pty-bridge-abc.sock");
    const rows = parsePsRows(
      [
        " 10 1 1000 0.0 0:01.00 bun run server.ts",
        // launchd-reparented: ppid 1, NOT a descendant of the server
        " 20 1 2000 0.0 0:01.00 node pty-bridge.js --socket /tmp/topics-pty-bridge-abc.sock",
      ].join("\n"),
    );
    expect(resolveFleetRoots(rows, 10)).toEqual([
      { kind: "server", pid: 10 },
      { kind: "pty-bridge", pid: 20 },
    ]);
  });

  it("ignores a sidecar socket belonging to another data instance", () => {
    registerFleetSocket("pty-bridge", "/tmp/topics-pty-bridge-prod.sock");
    const rows = parsePsRows(
      [
        " 10 1 1000 0.0 0:01.00 bun run server.ts",
        " 30 1 9000 0.0 0:01.00 node pty-bridge.js --socket /tmp/topics-pty-bridge-e2e-13334.sock",
      ].join("\n"),
    );
    expect(resolveFleetRoots(rows, 10)).toEqual([{ kind: "server", pid: 10 }]);
  });
});

describe("summarizeFleet", () => {
  const rows: PsRow[] = parsePsRows(
    [
      " 10 1  90000  2.0 0:01.00 bun run server.ts",
      " 20 1  30000  1.0 0:01.00 node pty-bridge.js --socket /tmp/s.sock",
      " 21 20 2000000 40.0 0:01.00 claude",
      " 22 21 500000 10.0 0:01.00 chrome-headless-shell",
      " 40 1  540000 29.0 0:01.00 webrtc-bridge --socket /tmp/w.sock",
      " 99 1  10000  5.0 0:01.00 unrelated-process",
    ].join("\n"),
  );

  it("sums the whole descendant tree of every root, not just the roots", () => {
    const out = summarizeFleet(rows, [
      { kind: "server", pid: 10 },
      { kind: "pty-bridge", pid: 20 },
      { kind: "webrtc-bridge", pid: 40 },
    ]);
    // 90000 + 30000 + 2000000 + 500000 + 540000 KB
    expect(out.memoryMB).toBe(Math.round(90000 / 1024) + Math.round((30000 + 2000000 + 500000) / 1024) + Math.round(540000 / 1024));
    expect(out.processCount).toBe(5);
    expect(out.cpuPercent).toBe(82);
    // The unrelated process is not ours and must not be billed to Topics.
    expect(out.roots.every(r => r.pid !== 99)).toBe(true);
  });

  it("bills a pid to exactly one root even when two roots reach it", () => {
    const out = summarizeFleet(rows, [
      { kind: "pty-bridge", pid: 20 },
      // 21 is already inside 20's tree; adding it as a root must not double count
      { kind: "ai-bridge", pid: 21 },
    ]);
    expect(out.processCount).toBe(3);
    expect(out.memoryMB).toBe(Math.round((30000 + 2000000 + 500000) / 1024));
  });

  it("normalizza sui core: la somma per-core diventa la scala 0-100 della macchina", () => {
    // Il difetto: `ps` conta per CORE (100% = un core saturo), quindi la flotta
    // segnava "170%" accanto a un Mac al 30% — due scale diverse affiancate,
    // che si legge come una contraddizione. Su 12 core quel 170% è il 14%.
    const perCore = summarizeFleet(rows, [
      { kind: "server", pid: 10 },
      { kind: "pty-bridge", pid: 20 },
      { kind: "webrtc-bridge", pid: 40 },
    ]);
    const normalized = summarizeFleet(
      rows,
      [
        { kind: "server", pid: 10 },
        { kind: "pty-bridge", pid: 20 },
        { kind: "webrtc-bridge", pid: 40 },
      ],
      undefined,
      12,
    );
    expect(perCore.cpuPercent).toBe(82);
    expect(normalized.cpuCores).toBe(12);
    // ~6.8, non esattamente 82/12: ogni root si arrotonda a un decimale PRIMA
    // della somma, quindi il totale può scostarsi di qualche centesimo. Su una
    // scala 0-100 è rumore, e vale il prezzo di avere i root già arrotondati
    // come li mostra il tooltip.
    expect(normalized.cpuPercent).toBeCloseTo(82 / 12, 0);
    // Anche il dettaglio per-root, non solo il totale: il tooltip li mostra
    // affiancati e non devono essere su scale diverse.
    for (const r of normalized.roots) {
      const same = perCore.roots.find(p => p.pid === r.pid)!;
      expect(r.cpuPercent).toBeCloseTo(same.cpuPercent / 12, 0);
    }
    // La memoria NON si normalizza: i MB sono già assoluti.
    expect(normalized.memoryMB).toBe(perCore.memoryMB);
  });

  it("un conteggio core assurdo non produce Infinity", () => {
    const out = summarizeFleet(rows, [{ kind: "server", pid: 10 }], undefined, 0);
    expect(Number.isFinite(out.cpuPercent)).toBe(true);
    expect(out.cpuCores).toBe(1);
  });

  it("preferisce phys_footprint a rss, e dichiara quale metrica ha usato", () => {
    // `rss` e footprint divergono in entrambi i versi (rss conta le pagine
    // condivise una volta per processo; il footprint include il compresso), per
    // cui il totale deve dire DA DOVE viene invece di lasciarlo indovinare.
    const withFp = rows.map(r => ({ ...r, footprintKB: Math.round(r.rssKB / 2) }));
    const out = summarizeFleet(withFp, [{ kind: "pty-bridge", pid: 20 }]);
    expect(out.memMetric).toBe("footprint");
    expect(out.memoryMB).toBe(Math.round((30000 + 2000000 + 500000) / 2 / 1024));
  });

  it("senza footprint ripiega su rss e lo DICE", () => {
    const out = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }]);
    expect(out.memMetric).toBe("rss");
    expect(out.memoryMB).toBe(Math.round((30000 + 2000000 + 500000) / 1024));
  });

  it("una copertura parziale è 'mixed', non spacciata per footprint", () => {
    // Un pid muore fra `ps` e la lettura del footprint: il totale è misto, e
    // presentarlo come footprint puro sarebbe una piccola bugia.
    const partial = rows.map(r => (r.pid === 21 ? { ...r, footprintKB: 1000 } : r));
    const out = summarizeFleet(partial, [{ kind: "pty-bridge", pid: 20 }]);
    expect(out.memMetric).toBe("mixed");
  });

  it("attribuisce due sessioni distinte dentro lo stesso pty-bridge", () => {
    // `roots` sa solo dire «il pty-bridge tiene N MB»; qui si chiede QUANTO ne
    // tiene ciascuna sessione.
    const out = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], undefined, 1, [
      { sessionId: "s-a", name: "A", pid: 21 },
      { sessionId: "s-b", name: "B", pid: 40 },
    ]);
    const a = out.sessions.find(s => s.sessionId === "s-a")!;
    const b = out.sessions.find(s => s.sessionId === "s-b")!;
    // 21 porta con sé il figlio 22; 40 è da solo.
    expect(a.processCount).toBe(2);
    expect(a.memoryMB).toBe(Math.round((2000000 + 500000) / 1024));
    expect(b.processCount).toBe(1);
    expect(b.memoryMB).toBe(Math.round(540000 / 1024));
  });

  it("i totali di flotta NON cambiano quando si attribuiscono le sessioni", () => {
    // Il punto più importante: l'attribuzione è una LENTE su processi già
    // contati. Se togliesse pid ai root, la barra cambierebbe numero per un
    // dettaglio che doveva solo spiegarla.
    const roots = [{ kind: "server" as const, pid: 10 }, { kind: "pty-bridge" as const, pid: 20 }];
    const senza = summarizeFleet(rows, roots);
    const con = summarizeFleet(rows, roots, undefined, 1, [
      { sessionId: "s-a", name: "A", pid: 21 },
      { sessionId: "s-b", name: "B", pid: 22 },
    ]);
    expect(con.processCount).toBe(senza.processCount);
    expect(con.memoryMB).toBe(senza.memoryMB);
    expect(con.cpuPercent).toBe(senza.cpuPercent);
    expect(con.roots).toEqual(senza.roots);
    expect(senza.sessions).toEqual([]);
  });

  it("un pid raggiungibile da due sessioni è fatturato a una sola", () => {
    const out = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], undefined, 1, [
      { sessionId: "s-a", name: "A", pid: 21 },
      { sessionId: "s-nested", name: "figlio di A", pid: 22 },
    ]);
    const tot = out.sessions.reduce((a, s) => a + s.processCount, 0);
    expect(tot).toBe(2); // 21 e 22 contati una volta ciascuno, non 3
  });

  it("una sessione il cui processo è già morto non compare", () => {
    const out = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], undefined, 1, [
      { sessionId: "s-morta", name: "chiusa", pid: 99999 },
    ]);
    expect(out.sessions).toEqual([]);
  });

  it("una sessione senza base CPU è 'non misurata', non zero", () => {
    // La regola che il modulo applica già ai pid nuovi: uno 0 direbbe «ferma»,
    // e di una sessione appena avviata non lo sappiamo.
    const nessunaBase = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], () => null, 1, [
      { sessionId: "s-a", name: "A", pid: 21 },
    ]);
    expect(nessunaBase.sessions[0].cpuPercent).toBeNull();

    const ferma = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], () => 0, 1, [
      { sessionId: "s-a", name: "A", pid: 21 },
    ]);
    expect(ferma.sessions[0].cpuPercent).toBe(0);
  });

  it("la CPU di sessione è normalizzata sui core come tutto il resto", () => {
    const out = summarizeFleet(rows, [{ kind: "pty-bridge", pid: 20 }], () => 24, 12, [
      { sessionId: "s-a", name: "A", pid: 21 },
    ]);
    // due processi (21 + 22) × 24% per-core ÷ 12 core = 4
    expect(out.sessions[0].cpuPercent).toBe(4);
  });

  it("drops a root that is no longer running", () => {
    const out = summarizeFleet(rows, [
      { kind: "server", pid: 10 },
      { kind: "ai-bridge", pid: 777 },
    ]);
    expect(out.roots.map(r => r.kind)).toEqual(["server"]);
  });
});

describe("CPU istantanea, non media di vita", () => {
  // Il difetto: `ps pcpu` e' la media sull'INTERA VITA del processo. Un CLI che
  // ha macinato per un'ora resta alto per sempre anche a riposo, e la somma
  // sulla flotta non scende piu'. Misurato il 2026-08-02: la status bar segnava
  // 318% con l'app ferma, mentre `top` dava l'8% per lo stesso processo.
  //
  // La misura giusta e' la DIFFERENZA dei secondi di CPU fra due letture,
  // divisa per il tempo reale trascorso.

  it("`ps time` si legge in tutti i formati che ps produce", () => {
    expect(parseCpuTimeSeconds("0:00.00")).toBe(0);
    expect(parseCpuTimeSeconds("1:30.50")).toBe(90.5);
    expect(parseCpuTimeSeconds("2:03:04")).toBe(2 * 3600 + 3 * 60 + 4);
    expect(parseCpuTimeSeconds("3-04:05:06")).toBe(3 * 86400 + 4 * 3600 + 5 * 60 + 6);
    expect(parseCpuTimeSeconds("spazzatura")).toBe(0);
  });

  const rowsAt = (cpuSecondsByPid: Record<number, number>): PsRow[] =>
    parsePsRows(
      [
        ` 10 1 90000 99.0 ${fmt(cpuSecondsByPid[10] ?? 0)} bun run server.ts`,
        ` 21 10 500000 99.0 ${fmt(cpuSecondsByPid[21] ?? 0)} claude`,
      ].join("\n"),
    );
  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

  it("un processo FERMO conta 0, anche se la sua media di vita e' altissima", () => {
    // Entrambe le righe dichiarano `pcpu` 99.0 — la media di vita. Ma fra le due
    // letture non hanno consumato NIENTE: la CPU istantanea e' 0.
    const before = rowsAt({ 10: 3600, 21: 7200 });
    const after = rowsAt({ 10: 3600, 21: 7200 });
    const base = { at: 0, byPid: new Map(before.map((r) => [r.pid, r.cpuSeconds])) };
    const out = summarizeFleet(after, [{ kind: "server", pid: 10 }], (row) => {
      const prev = base.byPid.get(row.pid);
      const dt = 10; // 10 secondi fra le letture
      return prev === undefined ? 0 : Math.max(0, ((row.cpuSeconds - prev) / dt) * 100);
    });
    expect(out.cpuPercent).toBe(0);
  });

  it("un processo che lavora conta quanto ha davvero consumato", () => {
    // Il server consuma 1s di CPU in 10s reali = 10%; il figlio 5s = 50%.
    const before = rowsAt({ 10: 100, 21: 200 });
    const after = rowsAt({ 10: 101, 21: 205 });
    const base = { at: 0, byPid: new Map(before.map((r) => [r.pid, r.cpuSeconds])) };
    const out = summarizeFleet(after, [{ kind: "server", pid: 10 }], (row) => {
      const prev = base.byPid.get(row.pid);
      const dt = 10;
      return prev === undefined ? 0 : Math.max(0, ((row.cpuSeconds - prev) / dt) * 100);
    });
    expect(out.cpuPercent).toBe(60); // 10% + 50%
  });

  it("senza la funzione istantanea si ripiega su pcpu — e si vede che e' un altro numero", () => {
    // La prova che il difetto era reale: sugli stessi identici dati, la vecchia
    // strada somma 99+99 = 198% per due processi FERMI.
    const rows = rowsAt({ 10: 3600, 21: 7200 });
    const out = summarizeFleet(rows, [{ kind: "server", pid: 10 }]);
    expect(out.cpuPercent).toBe(198);
  });
});

describe("il buco da 911 MB: responsible pid E ppid, non l'uno O l'altro", () => {
  /* IL CASO VERO, letto sull'app viva il 2026-08-20.
   *
   * I `claude` delle sessioni sono figli dell'ai-bridge, ma macOS li dichiara
   * RESPONSABILI DI SE STESSI (`responsibility_get_pid_responsible_for_pid`
   * torna il pid stesso). Il ramo `responsibleOf` cercava solo
   * `responsible == root.pid`, quindi non appartenevano a nessun root: 911 MB
   * di CLI degli agenti restavano fuori dal totale che la status bar esiste
   * per mostrare.
   *
   * Non e' un caso limite: e' cio' che macOS fa a un programma lanciato come
   * sessione propria, cioe' esattamente la parte che pesa. */
  const rows: PsRow[] = parsePsRows(
    [
      " 10 1  90000  1.0 0:01.00 bun run server.ts",
      " 57 1  20000  1.0 0:01.00 bun run ai-bridge.mjs --socket /tmp/a.sock",
      " 95 57 554768 5.0 0:01.00 claude --print",   // figlio dell'ai-bridge…
      " 91 57 362496 3.0 0:01.00 claude --print",   // …ma responsabile di se'
      " 96 95 100000 1.0 0:01.00 mcp-server",       // e i loro figli
    ].join("\n"),
  );

  /** Il responsible come lo riporta macOS in questo scenario. */
  const responsibleOf = (pid: number): number | null => {
    if (pid === 10 || pid === 57) return 10; // i nostri sotto il server
    if (pid === 95 || pid === 91) return pid; // <- il caso che si perdeva
    return null;
  };

  it("un processo responsabile di SE STESSO viene comunque attribuito al suo albero", () => {
    const out = summarizeFleet(
      rows,
      [{ kind: "server", pid: 10 }, { kind: "ai-bridge", pid: 57 }],
      undefined, 1, [], [], responsibleOf,
    );
    // Tutti e cinque: senza l'unione, 95/91/96 sparivano e restavano in 2.
    expect(out.processCount).toBe(5);
    expect(out.memoryMB).toBe(Math.round((90000 + 20000 + 554768 + 362496 + 100000) / 1024));
  });

  it("i figli di un processo che si auto-attribuisce non si perdono a loro volta", () => {
    // 96 e' figlio di 95, che e' figlio di 57: senza risalire in modo
    // transitivo, aggiungere 95 non basterebbe a portarsi dietro 96.
    const out = summarizeFleet(
      rows, [{ kind: "ai-bridge", pid: 57 }], undefined, 1, [], [], responsibleOf,
    );
    expect(out.roots[0].processCount).toBe(4); // 57 + 95 + 91 + 96
  });

  it("UNIRE non gonfia: nessun pid e' fatturato due volte", () => {
    // Un pid raggiungibile sia per responsible sia per ppid deve contare una
    // volta sola — altrimenti la correzione del buco ne aprirebbe uno opposto.
    const out = summarizeFleet(
      rows,
      [{ kind: "server", pid: 10 }, { kind: "ai-bridge", pid: 57 }],
      undefined, 1, [], [], responsibleOf,
    );
    const somma = out.roots.reduce((a, r) => a + r.processCount, 0);
    expect(somma).toBe(out.processCount);
    expect(out.processCount).toBe(new Set(rows.map(r => r.pid)).size);
  });

  it("un processo ESTRANEO resta fuori: unire non vuol dire prendere tutto", () => {
    const conEstraneo = parsePsRows([
      " 10 1  90000  1.0 0:01.00 bun run server.ts",
      " 57 1  20000  1.0 0:01.00 bun run ai-bridge.mjs --socket /tmp/a.sock",
      " 95 57 554768 5.0 0:01.00 claude --print",
      " 77 1  700000 9.0 0:01.00 qualcun-altro",
    ].join("\n"));
    const out = summarizeFleet(
      conEstraneo,
      [{ kind: "server", pid: 10 }, { kind: "ai-bridge", pid: 57 }],
      undefined, 1, [], [], responsibleOf,
    );
    expect(out.processCount).toBe(3);
    expect(out.memoryMB).toBe(Math.round((90000 + 20000 + 554768) / 1024));
  });

  it("le SESSIONI non superano piu' il totale della flotta", () => {
    // Il sintomo da cui e' partita la diagnosi: l'inventario mostrava
    // «Terminali e sessioni: 669 MB» sopra un totale dichiarato di 560. Le
    // sessioni sono una LENTE su processi gia' contati, quindi la loro somma
    // non puo' eccedere il totale — se accade, il totale sta perdendo pezzi.
    const out = summarizeFleet(
      rows,
      [{ kind: "server", pid: 10 }, { kind: "ai-bridge", pid: 57 }],
      undefined, 1,
      [{ sessionId: "a", name: "sessione-A", pid: 95 }, { sessionId: "b", name: "sessione-B", pid: 91 }],
      [], responsibleOf,
    );
    const sessioni = out.sessions.reduce((a, s) => a + s.memoryMB, 0);
    expect(sessioni).toBeLessThanOrEqual(out.memoryMB);
  });
});

/**
 * THE COLD-CACHE STAMPEDE.
 *
 * The comment above `cached` states the contract in its own words: "one
 * snapshot shared by every caller in a window ... it is not run per request".
 * With a WARM cache that held. With a cold one it did not, and nothing here
 * looked: `fleetLoadSync` fires `void getFleetUsage()` on every request that
 * finds the cache stale, none of those callers could see the others, and each
 * one ran its own `ps -axo` over ~500 processes plus one `proc_pid_rusage` per
 * row. A freshly started server taking a burst paid that tens of times over
 * for a single answer.
 *
 * Measured here before it was fixed: twenty concurrent callers made FORTY
 * readings. One fault, not two — and the second suspect is worth naming
 * because it looked guilty. The first-sample path returns early, so it seems
 * to skip writing the cache; it does not, because it returns through
 * `finish()`, which writes it. The second test below pins exactly that, and it
 * has never been red: it is not a defect closed, it is the invariant the fix
 * leans on, held in place.
 *
 * The two readings of a first sample are BY DESIGN and stay: instantaneous CPU
 * is a difference between two readings, and one alone would only give `ps
 * pcpu`, the process's whole-life average — the very defect this module was
 * built to remove. So the bar is TWO, not one.
 */
describe("fleet cache · la valanga a freddo", () => {
  const ROWS: PsRow[] = [
    { pid: 1, ppid: 0, rssKB: 1000, cpu: 0.1, cpuSeconds: 1, command: "/sbin/launchd" },
    { pid: 2, ppid: 1, rssKB: 2000, cpu: 0.2, cpuSeconds: 2, command: "/usr/bin/node server.ts" },
  ];

  beforeEach(() => _resetFleetUsageCache());

  it("venti chiamanti a cache fredda fanno DUE letture, non quaranta", async () => {
    let readings = 0;
    const take = async (): Promise<PsRow[]> => {
      readings++;
      await new Promise((r) => setTimeout(r, 10));
      return ROWS;
    };

    await Promise.all(Array.from({ length: 20 }, () => getFleetUsage(take)));

    expect(
      readings,
      "ogni chiamante a freddo ha lanciato il suo `ps`: e' la valanga, e su una macchina vera sono ~500 processi letti per ognuno",
    ).toBeLessThanOrEqual(2);
  });

  it("dopo la prima lettura la cache e' PIENA, o il chiamante dietro ne lancia un'altra", async () => {
    let readings = 0;
    const take = async (): Promise<PsRow[]> => { readings++; return ROWS; };

    await getFleetUsage(take);
    const afterFirstRead = readings;
    await getFleetUsage(take);

    expect(
      readings,
      "la seconda chiamata subito dopo la prima ha riletto: il percorso del primo campione torna senza scrivere `cached`",
    ).toBe(afterFirstRead);
  });

  it("e il banco sa diventare rosso: senza cache ogni chiamata rilegge", async () => {
    // The non-vacuous half, asserted instead of trusted. If `take` were not
    // really wired in, `readings` would stay at zero and the two cases above
    // would pass while looking at nothing at all.
    let readings = 0;
    const take = async (): Promise<PsRow[]> => { readings++; return ROWS; };
    await getFleetUsage(take);
    expect(readings, "la sonda iniettata non e' stata chiamata: le prove qui sopra non misurano nulla").toBeGreaterThan(0);
  });
});
