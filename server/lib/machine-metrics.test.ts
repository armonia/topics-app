/**
 * @covers MACHINE-05
 */
import { describe, expect, test } from "bun:test";
import { memPctFromReadout, parseProcMemoryPct, readMemPct } from "./machine-metrics";

const PROC_MEMORY_TEXT = "MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   16000000 kB\n";

describe("memoria dei nodi non macOS", () => {
  test("Linux: totale meno MemAvailable, in percento", () => {
    expect(parseProcMemoryPct(PROC_MEMORY_TEXT)).toBe(50);
    expect(readMemPct(null, "linux", () => PROC_MEMORY_TEXT)).toBe(50);
  });
  test("una riga mancante è non misurato, mai 0", () => {
    expect(parseProcMemoryPct("MemTotal: 100 kB\n")).toBeNull();
    expect(readMemPct(null, "linux", () => { throw new Error("no procfs"); })).toBeNull();
  });
  test("Windows: freemem è la memoria disponibile", () => {
    expect(readMemPct(null, "win32", () => "", 16e9, 4e9)).toBe(75);
  });
  test("la lettura del cancello di macOS vince", () => {
    expect(readMemPct(61, "darwin")).toBe(61);
    expect(readMemPct(null, "darwin")).toBeNull();
  });
});

describe("memory of a node on an old build", () => {
  test("processes over the machine total, in percent", () => {
    expect(memPctFromReadout({ memTotalMB: 1000, procs: [{ memMB: 200 }, { memMB: 100 }], rest: { memMB: 200 } })).toBe(50);
  });
  test("no total or no process list is not measured, never 0", () => {
    expect(memPctFromReadout(null)).toBeNull();
    expect(memPctFromReadout({ memTotalMB: null, procs: [] })).toBeNull();
    expect(memPctFromReadout({ memTotalMB: 1000 })).toBeNull();
  });  test("a malformed remote payload never throws and skips bad entries", () => {
    const bad = (readout: unknown) => memPctFromReadout(readout as Parameters<typeof memPctFromReadout>[0]);
    expect(bad({ memTotalMB: 1000, procs: [null] })).toBeNull();
    expect(bad({ memTotalMB: 1000, procs: [{ memMB: "x" }] })).toBeNull();
    expect(bad({ memTotalMB: 1000, procs: [], rest: { memMB: null } })).toBeNull();
    expect(bad({ memTotalMB: 1000, procs: [null, { memMB: "x" }, { memMB: 100 }], rest: { memMB: null } })).toBe(10);
  });

});
