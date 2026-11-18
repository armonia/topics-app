import { describe, expect, test } from "bun:test";
import { parseMeminfoPct, readMemPct } from "./machine-metrics";

const MEMINFO = "MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   16000000 kB\n";

describe("memoria dei nodi non macOS", () => {
  test("Linux: totale meno MemAvailable, in percento", () => {
    expect(parseMeminfoPct(MEMINFO)).toBe(50);
    expect(readMemPct(null, "linux", () => MEMINFO)).toBe(50);
  });
  test("una riga mancante è non misurato, mai 0", () => {
    expect(parseMeminfoPct("MemTotal: 100 kB\n")).toBeNull();
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
