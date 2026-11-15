import { describe, expect, test } from "bun:test";
import { judge, overall, raised, scoresOf } from "./check-mutation.ts";

const report = (files: Record<string, string[]>) => ({
  files: Object.fromEntries(Object.entries(files).map(([f, s]) => [f, { mutants: s.map((status) => ({ status })) }])),
});

describe("check:mutation", () => {
  test("lo score conta presi su validi e ignora i mutanti che non provano niente", () => {
    const s = scoresOf(report({ "a.ts": ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "RuntimeError"] }));
    expect(s["a.ts"]).toEqual({ detected: 2, undetected: 2, score: 50 });
  });

  test("l'indice pesa i mutanti, non fa la media dei file", () => {
    const s = scoresOf(report({ "a.ts": ["Killed", "Killed", "Killed"], "b.ts": ["Survived"] }));
    expect(overall(s)).toBe(75);
  });

  test("uno score sceso sotto la baseline è rosso", () => {
    const s = scoresOf(report({ "a.ts": ["Killed", "Survived"] }));
    expect(judge(["a.ts"], s, { "a.ts": 60 })[0].ok).toBe(false);
  });

  test("uguale o salito è verde", () => {
    const s = scoresOf(report({ "a.ts": ["Killed", "Survived"] }));
    expect(judge(["a.ts"], s, { "a.ts": 50 })[0].ok).toBe(true);
    expect(judge(["a.ts"], s, { "a.ts": 40 })[0].ok).toBe(true);
  });

  test("un modulo critico che manca dal report è rosso: non misurato non è passato", () => {
    expect(judge(["a.ts"], {}, { "a.ts": 50 })[0].ok).toBe(false);
  });

  test("un modulo critico senza baseline è rosso finché non entra col suo numero", () => {
    const s = scoresOf(report({ "a.ts": ["Killed"] }));
    expect(judge(["a.ts"], s, {})[0].ok).toBe(false);
  });

  test("--update-baseline non abbassa mai", () => {
    const s = scoresOf(report({ "a.ts": ["Killed", "Survived"], "b.ts": ["Killed"] }));
    expect(raised(["a.ts", "b.ts"], s, { "a.ts": 80, "b.ts": 10 })).toEqual({ "a.ts": 80, "b.ts": 100 });
  });
});
