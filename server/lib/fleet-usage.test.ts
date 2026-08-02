import { describe, it, expect, beforeEach } from "bun:test";
import {
  parseCpuTimeSeconds,
  parsePsRows,
  summarizeFleet,
  resolveFleetRoots,
  registerFleetSocket,
  _resetFleetSockets,
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
