/**
 * @covers GIT-MSG-01
 */
import { describe, expect, test } from "bun:test";
import {
  stagedEntries,
  splitDiffByFile,
  budgetedDiff,
  buildSystemPrompt,
  buildUserPrompt,
  rulesFallback,
  usableMessage,
  DIFF_BUDGET,
} from "./commit-message";

/** Come la scrive git: campi separati da NUL, terminatore compreso. */
const z = (...voci: string[]) => voci.map(v => v + "\0").join("");

describe("stagedEntries", () => {
  test("un file modificato SOLO sul disco non e in stage — nemmeno se e il primo", () => {
    // Il difetto vero: il codice di prima faceva `.trim()` sull'output intero e
    // poi splittava per riga. Il trim mangia lo spazio iniziale della PRIMA
    // riga, quindi ` M a.txt` diventava `M a.txt` e passava il filtro. Da li
    // due conseguenze: il prompt descriveva file non in stage, e la guardia
    // «niente in stage» non scattava.
    const out = stagedEntries(z(" M a.txt", "M  z.txt"));
    expect(out.map(e => e.path)).toEqual(["z.txt"]);
  });

  test("l'ordine non cambia l'esito: lo stesso input al contrario da lo stesso file", () => {
    const out = stagedEntries(z("M  z.txt", " M a.txt"));
    expect(out.map(e => e.path)).toEqual(["z.txt"]);
  });

  test("un file staged E poi modificato conta: la sua meta nell'indice c'e", () => {
    expect(stagedEntries(z("MM b.txt")).map(e => e.path)).toEqual(["b.txt"]);
  });

  test("i non tracciati non sono in stage: git non li conosce ancora", () => {
    expect(stagedEntries(z("?? nuovo.txt", "A  aggiunto.txt")).map(e => e.path)).toEqual([
      "aggiunto.txt",
    ]);
  });

  test("gli ignorati nemmeno", () => {
    expect(stagedEntries(z("!! build/", "M  src.ts")).map(e => e.path)).toEqual(["src.ts"]);
  });

  test("albero pulito: nessuna voce", () => {
    expect(stagedEntries("")).toEqual([]);
  });
});

describe("splitDiffByFile", () => {
  const diff = [
    "diff --git a/uno.ts b/uno.ts",
    "index 111..222 100644",
    "--- a/uno.ts",
    "+++ b/uno.ts",
    "@@ -1 +1 @@",
    "-vecchio",
    "+nuovo",
    "diff --git a/due.ts b/due.ts",
    "index 333..444 100644",
    "--- a/due.ts",
    "+++ b/due.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");

  test("spezza sui confini di git e prende il nome NUOVO", () => {
    const files = splitDiffByFile(diff);
    expect(files.map(f => f.path)).toEqual(["uno.ts", "due.ts"]);
  });

  test("ogni pezzo si porta la sua intestazione", () => {
    expect(splitDiffByFile(diff)[0].text.startsWith("diff --git a/uno.ts")).toBe(true);
  });

  test("una riga di CONTENUTO che assomiglia a un'intestazione non spezza", () => {
    // Le righe di contenuto hanno sempre un prefisso ` `, `+` o `-`: e' per
    // questo che l'ancora e' `diff --git` a INIZIO riga.
    const insidioso = [
      "diff --git a/f.md b/f.md",
      "@@ -1,2 +1,2 @@",
      "+diff --git a/finto b/finto",
      " testo",
    ].join("\n");
    expect(splitDiffByFile(insidioso)).toHaveLength(1);
  });

  test("diff vuoto: nessun file", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("\n \n")).toEqual([]);
  });

  test("un rename prende il nome nuovo, che e quello che si legge nella lista", () => {
    const r = "diff --git a/vecchio.ts b/nuovo.ts\nsimilarity index 100%\n";
    expect(splitDiffByFile(r)[0].path).toBe("nuovo.ts");
  });
});

describe("budgetedDiff", () => {
  const fileDa = (nome: string, righe: number) =>
    [`diff --git a/${nome} b/${nome}`, `@@ -1,${righe} +1,${righe} @@`]
      .concat(Array.from({ length: righe }, (_, i) => `+riga ${i} di ${nome}`))
      .join("\n");

  test("sotto il budget non tocca niente", () => {
    const d = fileDa("piccolo.ts", 5);
    expect(budgetedDiff(d, 10_000)).toBe(d);
  });

  test("NESSUN file scompare, nemmeno quando uno e enorme", () => {
    // Il punto di tutto il modulo: `slice(0, 4000)` sul diff intero faceva
    // sparire ogni file dopo il primo, in silenzio. Misurato sugli ultimi 30
    // commit di questo repo: 24 su 30 erano oltre i 4000 caratteri, cioe' il
    // caso NORMALE era «il modello vede un pezzo del primo file e basta».
    const d = [fileDa("enorme.ts", 2000), fileDa("a.ts", 3), fileDa("b.ts", 3), fileDa("c.ts", 3)].join("\n");
    const out = budgetedDiff(d, 4000);
    for (const nome of ["enorme.ts", "a.ts", "b.ts", "c.ts"]) {
      expect(out).toContain(`b/${nome}`);
    }
  });

  test("i piccoli restano INTERI: il loro avanzo va a chi sfora", () => {
    const d = [fileDa("enorme.ts", 2000), fileDa("a.ts", 3)].join("\n");
    const out = budgetedDiff(d, 4000);
    // Il pezzo del file piccolo, non l'output intero: il grosso e' troncato di
    // proposito e il suo marcatore c'e' — e' quello che si vuole.
    const smallPiece = splitDiffByFile(out).find(f => f.path === "a.ts")!;
    expect(smallPiece.text).toContain("+riga 2 di a.ts");
    expect(smallPiece.text).not.toContain("… (");

    // E l'avanzo del piccolo e' andato al grosso: senza redistribuzione avrebbe
    // avuto meta' budget (2000 caratteri), con la redistribuzione ha quasi
    // tutto cio' che il piccolo non ha usato.
    const bigPiece = splitDiffByFile(out).find(f => f.path === "enorme.ts")!;
    expect(bigPiece.text.length).toBeGreaterThan(3000);
  });

  test("chi tronca lo DICE, con quante righe ha omesso", () => {
    const d = fileDa("enorme.ts", 2000);
    const out = budgetedDiff(d, 1000);
    const marcatore = out.split("\n").find(r => r.startsWith("… ("));
    expect(marcatore).toBeDefined();
    expect(marcatore).toMatch(/… \(\d+ righe omesse\)/);
  });

  test("il totale resta nell'ordine del budget", () => {
    const d = [fileDa("x.ts", 3000), fileDa("y.ts", 3000)].join("\n");
    const out = budgetedDiff(d, 4000);
    // Non esattamente <= budget: si taglia a fine riga e si aggiunge il
    // marcatore, quindi si concede un margine — cio' che conta e' che non sia
    // l'ordine di grandezza del diff originale.
    expect(out.length).toBeLessThan(4000 * 1.5);
    expect(out.length).toBeLessThan(d.length / 5);
  });

  test("si taglia a fine riga: mezza riga di diff confonde piu di quanto informi", () => {
    const out = budgetedDiff(fileDa("x.ts", 500), 300);
    const righe = out.split("\n").filter(r => r.startsWith("+riga"));
    for (const r of righe) expect(r).toMatch(/^\+riga \d+ di x\.ts$/);
  });

  test("il budget di serie e quello dichiarato", () => {
    expect(DIFF_BUDGET).toBe(12_000);
  });
});

describe("buildSystemPrompt", () => {
  test("gli esempi finiscono nel prompt", () => {
    const p = buildSystemPrompt(["Aggiusta il divisore", "Il piede resta in fondo"]);
    expect(p).toContain("- Aggiusta il divisore");
    expect(p).toContain("- Il piede resta in fondo");
  });

  test("NON detta ne la lingua ne il formato", () => {
    // Il prompt di prima cablava «conventional commit format» in inglese,
    // mentre gli ultimi 200 commit di questo repo sono frasi italiane e nemmeno
    // uno porta un prefisso `feat:`. Lo stile si MOSTRA, non si dichiara.
    const p = buildSystemPrompt(["qualcosa"]);
    expect(p).not.toContain("conventional");
    expect(p).not.toContain("72");
  });

  test("senza esempi il prompt regge lo stesso (repo appena creato)", () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain("modifiche IN STAGE");
    expect(p).not.toContain("Esempi");
  });

  test("gli esempi vuoti non lasciano trattini orfani", () => {
    expect(buildSystemPrompt(["", "vero", ""])).toContain("- vero");
    expect(buildSystemPrompt(["", "vero", ""]).split("\n").filter(r => r === "- ")).toEqual([]);
  });
});

describe("buildUserPrompt", () => {
  test("porta la mappa dei file E il diff", () => {
    const p = buildUserPrompt(" a.ts | 2 +-\n 1 file changed", "diff --git a/a.ts b/a.ts\n+x");
    expect(p).toContain("1 file changed");
    expect(p).toContain("diff --git a/a.ts");
  });

  test("niente da dire: lo dice invece di mandare stringhe vuote", () => {
    const p = buildUserPrompt("", "");
    expect(p).toContain("(nessuno)");
    expect(p).toContain("(nessuna)");
  });
});

describe("rulesFallback", () => {
  test("un file solo: lo nomina", () => {
    expect(rulesFallback([{ path: "src/a.ts", status: "M " }])).toBe("Aggiorna src/a.ts");
  });

  test("solo aggiunte: il verbo cambia", () => {
    expect(rulesFallback([{ path: "a.ts", status: "A " }, { path: "b.ts", status: "A " }]))
      .toBe("Aggiungi a.ts, b.ts");
  });

  test("solo cancellazioni", () => {
    expect(rulesFallback([{ path: "a.ts", status: "D " }])).toBe("Rimuovi a.ts");
  });

  test("misto: torna al verbo generico", () => {
    expect(rulesFallback([{ path: "a.ts", status: "A " }, { path: "b.ts", status: "D " }]))
      .toBe("Aggiorna a.ts, b.ts");
  });

  test("tanti file: conta invece di elencare", () => {
    const molti = ["a", "b", "c", "d", "e"].map(n => ({ path: `${n}.ts`, status: "M " }));
    expect(rulesFallback(molti)).toBe("Aggiorna 5 file (a.ts, b.ts, …)");
  });

  test("nessun file: non lancia", () => {
    expect(rulesFallback([])).toBeTruthy();
  });
});

describe("usableMessage", () => {
  test("l'errore della CLI non finisce nella casella del commit", () => {
    // `claude-code.complete()` su exit non-zero NON lancia: risolve con
    // `content: "Error: CLI exited with code N"`. Senza questo controllo il ✨
    // incollerebbe quella stringa come messaggio.
    expect(usableMessage("Error: CLI exited with code 1")).toBeNull();
  });

  test("vuoto e spazi sono niente", () => {
    expect(usableMessage("")).toBeNull();
    expect(usableMessage("   \n  ")).toBeNull();
    expect(usableMessage(undefined)).toBeNull();
    expect(usableMessage(null)).toBeNull();
  });

  test("il blocco di codice si scarta: e la cornice, non il messaggio", () => {
    expect(usableMessage("```\nAggiusta il divisore\n```")).toBe("Aggiusta il divisore");
    expect(usableMessage("```text\nAggiusta il divisore\n```")).toBe("Aggiusta il divisore");
  });

  test("un messaggio su piu righe resta intero", () => {
    expect(usableMessage("Titolo\n\nCorpo che spiega")).toBe("Titolo\n\nCorpo che spiega");
  });

  test("una parola che CONTIENE «error» passa: il controllo e sul prefisso", () => {
    expect(usableMessage("Gestisci l'errore dei dispositivi")).toBe("Gestisci l'errore dei dispositivi");
  });
});
