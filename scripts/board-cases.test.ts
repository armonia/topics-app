/**
 * Le prove della matrice devono poter DIVENTARE ROSSE.
 *
 * Una matrice di casi limite è utile solo se le sue asserzioni sono
 * falsificabili: un'asserzione-assenza che cerca in una lista di file che si
 * accorcia da sola, o un filtro `-t` che non matcha nessun test, sono verdi
 * eterni travestiti da prova. Questi test pinzano proprio quelle tre trappole,
 * perché sono le uniche con cui il file può mentire senza che nessuno se ne
 * accorga.
  * @covers BENCH-03
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  FINGERPRINT_ABSENT,
  REGEX_META,
  coverageFor,
  fingerprintFiles,
  mustColumns,
  sourceAbsentIn,
  sourceAssert,
  type BoardTask,
} from "./board-cases";

const ROOT = join(import.meta.dir, "..");

function scratch(files: Record<string, string>): { dir: string; rel: (n: string) => string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "board-cases-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return {
    dir,
    rel: (n: string) => relative(ROOT, join(dir, n)),
    drop: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("il filtro dei test non può essere una regex muta", () => {
  test("i metacaratteri che rompono `bun test -t` sono riconosciuti", () => {
    // Sono esattamente quelli visti sul campo: le parentesi e il `+` dei titoli
    // reali («…(reject + resume with step ref)») facevano girare ZERO test, e
    // zero test è una prova che non può fallire.
    for (const bad of ["parks (does not run in-place)", "books wall-clock + usage", "a?b", "x|y", "a[b]"]) {
      expect(REGEX_META.test(bad)).toBe(true);
    }
  });

  test("un filtro letterale passa", () => {
    for (const ok of ["server-composed question block", "REATTACHES in place", "Landa su main"]) {
      expect(REGEX_META.test(ok)).toBe(false);
    }
  });
});

describe("l'asserzione-assenza vale quanto la superficie su cui cerca", () => {
  test("verde quando l'ago non c'è in nessuno dei file", () => {
    const s = scratch({ "a.tsx": "const x = 1;", "b.tsx": "const y = 2;" });
    try {
      const p = sourceAbsentIn("claim", [s.rel("a.tsx"), s.rel("b.tsx")], ["permissionRequest"]);
      expect(p.status).toBe("pass");
      expect(p.detail).toContain("2 file letti");
    } finally {
      s.drop();
    }
  });

  test("ROSSA appena l'ago compare in uno solo dei file", () => {
    const s = scratch({ "a.tsx": "const x = 1;", "b.tsx": "render(permissionRequest)" });
    try {
      const p = sourceAbsentIn("claim", [s.rel("a.tsx"), s.rel("b.tsx")], ["permissionRequest"]);
      expect(p.status).toBe("fail");
      expect(p.detail).toContain("permissionRequest");
    } finally {
      s.drop();
    }
  });

  test("un file MANCANTE è rosso, non un file da saltare", () => {
    // È la trappola vera: un elenco scritto a mano che invecchia verde. Se un
    // file sparisce, l'assenza è stata verificata su una superficie più piccola
    // di quella dichiarata — e questo va detto, non ignorato.
    const s = scratch({ "a.tsx": "const x = 1;" });
    try {
      const p = sourceAbsentIn("claim", [s.rel("a.tsx"), s.rel("sparito.tsx")], ["qualsiasi"]);
      expect(p.status).toBe("fail");
      expect(p.detail).toContain("file mancanti");
    } finally {
      s.drop();
    }
  });
});

describe("l'asserzione d'ordine legge davvero l'ordine", () => {
  test("verde quando il primo precede il secondo", () => {
    const s = scratch({ "r.ts": "reviewDecision();\nresume();\n" });
    try {
      const p = sourceAssert("claim", s.rel("r.ts"), { before: ["reviewDecision(", "resume("] });
      expect(p.status).toBe("pass");
    } finally {
      s.drop();
    }
  });

  test("ROSSA a ordine invertito — è il difetto che sveglia un agente per niente", () => {
    const s = scratch({ "r.ts": "resume();\nreviewDecision();\n" });
    try {
      const p = sourceAssert("claim", s.rel("r.ts"), { before: ["reviewDecision(", "resume("] });
      expect(p.status).toBe("fail");
    } finally {
      s.drop();
    }
  });

  test("un file che non esiste non è un'asserzione soddisfatta", () => {
    const p = sourceAssert("claim", "questo/file/non/esiste.ts", { contains: ["x"] });
    expect(p.status).toBe("fail");
    expect(p.detail).toContain("file mancante");
  });
});

describe("un censimento sulla board può diventare rosso", () => {
  // Le righe `http-get` che CONTANO (quanti task hanno needs_input, planFirst,
  // deliveredBy…) non asseriscono un numero: un numero atteso invecchierebbe
  // ogni giorno. Ma senza nemmeno una condizione sono verdi eterni. Il fatto
  // falsificabile è il DENOMINATORE: la colonna che si sta contando deve
  // esistere nel payload, altrimenti si conta `undefined` e si stampa «0».
  const row = (over: Partial<BoardTask> = {}): BoardTask => ({
    id: "t", status: "done", dispatchState: null, assignedTopicId: null,
    agentTokens: 0, agentCacheReadTokens: 0, planFirst: false, previewImage: null,
    deliveredBy: null, dispatchAttempts: 0, completedAt: null, updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  });

  test("verde quando la colonna c'è, anche se il conteggio è zero", () => {
    expect(() => mustColumns([row()], "dispatchState", "planFirst")).not.toThrow();
  });

  test("ROSSA quando la colonna sparisce dal payload: contare undefined non è contare zero", () => {
    const withoutColumn = [{ ...row() } as Record<string, unknown>];
    delete withoutColumn[0]!.dispatchState;
    expect(() => mustColumns(withoutColumn as unknown as BoardTask[], "dispatchState")).toThrow(/dispatchState/);
  });

  test("ROSSA su una board senza task: un censimento senza denominatore non è un verde", () => {
    expect(() => mustColumns([], "planFirst")).toThrow(/denominatore/);
  });
});

describe("l'impronta lega la matrice congelata alle sorgenti che copre", () => {
  test("stesso contenuto, stesso sha256; un byte diverso, sha256 diverso", () => {
    const s = scratch({ "a.ts": "x", "b.ts": "x " });
    try {
      const fp = fingerprintFiles([s.rel("a.ts"), s.rel("b.ts")], ROOT);
      expect(fp.algo).toBe("sha256");
      expect(fp.files[s.rel("a.ts")]).not.toBe(fp.files[s.rel("b.ts")]);
      expect(fp.files[s.rel("a.ts")]).toBe(fingerprintFiles([s.rel("a.ts")], ROOT).files[s.rel("a.ts")]);
    } finally {
      s.drop();
    }
  });

  test("un file assente è timbrato ASSENTE, non omesso: uno che RIAPPARE è deriva quanto uno che sparisce", () => {
    const fp = fingerprintFiles(["questo/non/esiste.ts"], ROOT);
    expect(fp.files["questo/non/esiste.ts"]).toBe(FINGERPRINT_ABSENT);
  });
});

describe("la traduzione verso il vocabolario di board-vs-chat è dichiarata, non comoda", () => {
  test("solo un caso COPERTO diventa 'covered'", () => {
    expect(coverageFor("covered")).toBe("covered");
  });

  test("un buco NON diventa 'covered': diventa 'workaround' (una strada c'è, ma non sulla board)", () => {
    // 'uncovered' nel loro schema significa «nessuna strada». Un permesso una
    // strada ce l'ha — passa dal tab dell'agente — quindi chiamarlo uncovered
    // sarebbe falso quanto chiamarlo covered.
    expect(coverageFor("gap")).toBe("workaround");
    expect(coverageFor("partial")).toBe("workaround");
  });
});
