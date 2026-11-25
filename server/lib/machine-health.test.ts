/**
 * @covers MACHINE-05
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistory, cardRunsToday, cardsPerHour, samplesFromMinuteLog, createMachineHealth, HISTORY_POINTS, pushSample, STEP_S,
  type HealthTarget, type MachineHealthDeps, type Sample,
} from "./machine-health";
import type { MachinesHealthFile, MachineSecurityReport } from "../../shared/machine-health";

const NOW = new Date(2026, 10, 17, 14, 7, 30).getTime();
const NOW_S = Math.floor(NOW / 1000);

describe("storico a 288 punti", () => {
  test("il campione si taglia a 24 ore: dopo 300 giri restano 288 punti", () => {
    let list: Sample[] = [];
    for (let i = 0; i < 300; i++) list = pushSample(list, { t: NOW_S - (299 - i) * STEP_S, cpu: i % 100, mem: 50 });
    expect(list).toHaveLength(HISTORY_POINTS);
    const h = buildHistory(list, NOW_S);
    expect(h.cpu).toHaveLength(HISTORY_POINTS);
    expect(h.mem).toHaveLength(HISTORY_POINTS);
    expect(h.step_s).toBe(300);
    expect(h.cpu[HISTORY_POINTS - 1]).toBe(299 % 100);
  });

  test("i buchi sono null, `from` è il primo punto, due campioni nello stesso intervallo sono uno", () => {
    const base = Math.floor(NOW_S / STEP_S) * STEP_S;
    let list = pushSample([], { t: base - 600, cpu: 10, mem: 20 });
    list = pushSample(list, { t: base + 10, cpu: 30, mem: 40 });
    list = pushSample(list, { t: base + 200, cpu: 35, mem: 45 });
    expect(list).toHaveLength(2);
    const h = buildHistory(list, NOW_S);
    expect(h.from).toBe(base - (HISTORY_POINTS - 1) * STEP_S);
    expect(h.cpu[HISTORY_POINTS - 1]).toBe(35);
    expect(h.cpu[HISTORY_POINTS - 2]).toBeNull();
    expect(h.cpu[HISTORY_POINTS - 3]).toBe(10);
    expect(h.cpu.filter((v) => v !== null)).toHaveLength(2);
  });

  test("un campione più vecchio di 24 ore non entra nei punti", () => {
    const h = buildHistory([{ t: NOW_S - 25 * 3600, cpu: 1, mem: 1 }], NOW_S);
    expect(h.cpu.every((v) => v === null)).toBe(true);
  });
});

describe("carte di oggi, ora per ora", () => {
  test("24 interi, indice = ora locale, solo da mezzanotte locale", () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m).toISOString();
    const out = cardsPerHour([at(0, 5), at(9, 1), at(9, 59), at(13), new Date(2026, 10, 16, 23, 59).toISOString(), new Date(NOW + 3600_000).toISOString()], NOW);
    expect(out).toHaveLength(24);
    expect(out[0]).toBe(1);
    expect(out[9]).toBe(2);
    expect(out[13]).toBe(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe("il giro scrive il file nel formato del contratto", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "machines-health-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const mac: HealthTarget = { id: "m1", name: "Mac", kind: "local" };
  const pc: HealthTarget = { id: "pc", name: "PC", kind: "remote" };
  const report: MachineSecurityReport = { checked_at: NOW_S, status: "warn", checks: [{ key: "updates", status: "warn", detail: "1 aggiornamento in attesa da 8 giorni" }] };

  function deps(over: Partial<MachineHealthDeps> = {}): MachineHealthDeps {
    return {
      targets: () => [mac, pc],
      readMetrics: async (t) => (t.id === "pc" ? null : { cpu: 12, mem: 61 }),
      probe: async (t) => (t.id === "pc" ? null : report),
      attemptsToday: () => [
        { machineId: null, createdAt: new Date(2026, 10, 17, 9, 30).toISOString() },
        { machineId: "old-mac-row", createdAt: new Date(2026, 10, 17, 9, 45).toISOString() },
        { machineId: "pc", createdAt: new Date(2026, 10, 17, 11, 0).toISOString() },
        { machineId: "cloud", createdAt: new Date(2026, 10, 17, 11, 0).toISOString() },
      ],
      attribute: (id) => (id === null || id === "old-mac-row" ? "m1" : id === "pc" ? "pc" : null),
      filePath: join(dir, "machines-health.json"),
      statePath: join(dir, "machines-health-history.json"),
      now: () => NOW,
      ...over,
    };
  }

  test("formato del contratto: tre campi per macchina, 288 punti, 24 ore, nessun file temporaneo rimasto", async () => {
    await createMachineHealth(deps()).tick();
    const file = JSON.parse(await readFile(join(dir, "machines-health.json"), "utf8")) as MachinesHealthFile;
    expect(file.at).toBe(NOW_S);
    expect(file.machines.map((m) => [m.id, m.name, m.kind])).toEqual([["m1", "Mac", "local"], ["pc", "PC", "remote"]]);
    const [a, b] = file.machines;
    expect(Object.keys(a).sort()).toEqual(["cards_today", "history", "id", "kind", "name", "security"]);
    expect(Object.keys(a.security).sort()).toEqual(["checked_at", "checks", "status"]);
    expect(a.security).toEqual({ checked_at: NOW_S, status: "warn", checks: report.checks });
    expect(Object.keys(a.history).sort()).toEqual(["cpu", "from", "mem", "step_s"]);
    expect(a.history.cpu).toHaveLength(288);
    expect(a.history.cpu[287]).toBe(12);
    expect(a.history.mem[287]).toBe(61);
    expect(a.cards_today).toHaveLength(24);
    expect(a.cards_today[9]).toBe(2);
    expect(b.cards_today[11]).toBe(1);
    expect(b.cards_today.reduce((x, y) => x + y, 0)).toBe(1);
    // the PC never answered: no result, no points
    expect(b.security).toEqual({ checked_at: null, status: "unknown", checks: [] });
    expect(b.history.cpu.every((v) => v === null)).toBe(true);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("una macchina che non risponde più tiene l'ultimo esito con la sua ora, e la storia sopravvive a un riavvio", async () => {
    await createMachineHealth(deps({ targets: () => [pc], probe: async () => report, readMetrics: async () => ({ cpu: 5, mem: 6 }) })).tick();
    // server restart (fresh module), half an hour later, the PC is asleep
    const later = NOW + 30 * 60_000;
    await createMachineHealth(deps({ targets: () => [pc], probe: async () => null, readMetrics: async () => null, now: () => later })).tick();
    const file = JSON.parse(await readFile(join(dir, "machines-health.json"), "utf8")) as MachinesHealthFile;
    expect(file.machines[0].security.checked_at).toBe(NOW_S);
    expect(file.machines[0].security.status).toBe("warn");
    const cpu = file.machines[0].history.cpu;
    expect(cpu[287]).toBeNull();
    expect(cpu[287 - 6]).toBe(5);
  });

  test("le sonde non si ripetono prima di 30 minuti, i campioni sì", async () => {
    let probes = 0;
    let t = NOW;
    const h = createMachineHealth(deps({ targets: () => [mac], probe: async () => { probes++; return report; }, now: () => t }));
    await h.tick();
    t += 5 * 60_000; await h.tick();
    t += 5 * 60_000; await h.tick();
    expect(probes).toBe(1);
    t += 25 * 60_000; await h.tick();
    expect(probes).toBe(2);
    expect(h.snapshot([mac]).machines[0].history.cpu.filter((v) => v !== null)).toHaveLength(4);
  });

  test("macchine uscite dalla tabella spariscono dal file di salvataggio", async () => {
    const h = createMachineHealth(deps());
    await h.tick();
    const h2 = createMachineHealth(deps({ targets: () => [mac] }));
    await h2.tick();
    const saved = JSON.parse(await readFile(join(dir, "machines-health-history.json"), "utf8"));
    expect(Object.keys(saved.samples)).toEqual(["m1"]);
  });

  test("un file di salvataggio rovinato non rompe il giro", async () => {
    await writeFile(join(dir, "machines-health-history.json"), "{non è json");
    await createMachineHealth(deps()).tick();
    const file = JSON.parse(await readFile(join(dir, "machines-health.json"), "utf8")) as MachinesHealthFile;
    expect(file.machines).toHaveLength(2);
  });

  test("un errore nelle letture non ferma il giro né il file", async () => {
    await createMachineHealth(deps({ readMetrics: async () => { throw new Error("x"); }, probe: async () => { throw new Error("y"); } })).tick();
    const file = JSON.parse(await readFile(join(dir, "machines-health.json"), "utf8")) as MachinesHealthFile;
    expect(file.machines[0].security.status).toBe("unknown");
  });
});

describe("letture che il server del nodo non sa dare", () => {
  test("il registro al minuto del PC diventa medie da 5 minuti; il PC che dorme resta un buco", () => {
    const base = Math.floor(NOW_S / STEP_S) * STEP_S;
    const text = [
      JSON.stringify({ t: base - 600, s: "lavora", cpu: 10, mem: 40 }),
      JSON.stringify({ t: base - 590, s: "lavora", cpu: 20, mem: 42 }),
      JSON.stringify({ t: base - 300, s: "dorme" }),
      "riga rotta",
      JSON.stringify({ t: base + 5, s: "lavora", cpu: 7, mem: 50 }),
    ].join("\n");
    const got = samplesFromMinuteLog(text, base - 3600);
    expect(got).toEqual([{ t: base - 600, cpu: 15, mem: 41 }, { t: base, cpu: 7, mem: 50 }]);
  });

  test("esternali riempiono solo i punti vuoti: la lettura del nodo vince", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mh-ext-"));
    const base = Math.floor(NOW_S / STEP_S) * STEP_S;
    const h = createMachineHealth({
      targets: () => [{ id: "pc", name: "PC", kind: "remote" }],
      readMetrics: async () => ({ cpu: 99, mem: 98 }),
      probe: async () => null,
      attemptsToday: () => [],
      attribute: () => null,
      externalSamples: async () => [{ t: base - 300, cpu: 5, mem: 6 }, { t: base, cpu: 1, mem: 1 }],
      filePath: join(dir, "h.json"), statePath: join(dir, "s.json"), now: () => NOW,
    });
    await h.tick();
    const out = JSON.parse(await readFile(join(dir, "h.json"), "utf8")) as MachinesHealthFile;
    const hist = out.machines[0].history;
    expect(hist.cpu[HISTORY_POINTS - 1]).toBe(99);
    expect(hist.cpu[HISTORY_POINTS - 2]).toBe(5);
    expect(hist.mem[HISTORY_POINTS - 2]).toBe(6);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("card di oggi di un nodo", () => {
  test("un tentativo di oggi, una card avviata oggi senza tentativo e una vecchia ma in corso contano una volta; una chiusa ieri no", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, machine_id TEXT, status TEXT, in_progress_at TEXT)");
    db.run("CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT)");
    const midnight = new Date(2026, 10, 17, 0, 0, 0).getTime();
    const iso = (h: number) => new Date(midnight + h * 3600_000).toISOString();
    db.run("INSERT INTO tasks VALUES ('a','n1','review',?), ('b','n1','in_progress',?), ('c','n1','in_progress',?), ('d','n1','review',?), ('e',NULL,'review',?)", [iso(-5), iso(9), iso(-20), iso(-30), iso(3)]);
    db.run("INSERT INTO task_attempts VALUES ('1','a',?), ('2','a',?), ('3','e',?)", [iso(2), iso(5), iso(3)]);
    const runs = cardRunsToday(db, midnight);
    const byMachine = (m: string | null) => runs.filter((r) => r.machineId === m).map((r) => r.createdAt).sort();
    expect(byMachine("n1")).toEqual([iso(0), iso(2), iso(5), iso(9)].sort());
    expect(byMachine(null)).toEqual([iso(3)]);
  });
});
