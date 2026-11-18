import { describe, expect, test } from "bun:test";
import { parseProcMemoryPct, readMemPct } from "./machine-metrics";

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
