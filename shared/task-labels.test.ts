import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveVisibility,
  isAgentWritableLabel,
  isTaskLabel,
  isUserVisibleFile,
  normalizeLabels,
  whoCloses,
  KIND_LABELS,
  TASK_LABELS,
  VISIBILITY_LABELS,
} from "./task-labels";

describe("il vocabolario è CHIUSO", () => {
  test("sei etichette: due che decidono, quattro che filtrano", () => {
    expect(VISIBILITY_LABELS).toEqual(["visibile", "invisibile"]);
    expect(KIND_LABELS).toEqual(["bugfix", "feature", "chore", "misura"]);
    expect(TASK_LABELS).toHaveLength(6);
  });
  test("ciò che assomiglia a un'etichetta non è un'etichetta", () => {
    // Il motivo per cui `task_labels` è una tabella e non una colonna con le
    // virgole: su una stringa `LIKE '%bugfix%'` questi passerebbero tutti.
    expect(isTaskLabel("bugfix-ui")).toBe(false);
    expect(isTaskLabel("Bugfix")).toBe(false);
    expect(isTaskLabel("invisibili")).toBe(false);
    expect(isTaskLabel("")).toBe(false);
    expect(isTaskLabel(undefined)).toBe(false);
  });
});

describe("isUserVisibleFile — che cosa può VEDERE un umano", () => {
  test("sorgente del client sì, test del client no", () => {
    expect(isUserVisibleFile("client/src/components/Board/Card.tsx")).toBe(true);
    expect(isUserVisibleFile("client/src/lib/board.ts")).toBe(true);
    expect(isUserVisibleFile("client/src/components/Board/format.test.ts")).toBe(false);
    expect(isUserVisibleFile("client/src/components/Board/Card.spec.tsx")).toBe(false);
  });
  test("fuori da client/src non si vede niente, nemmeno dentro client/", () => {
    // La config di Vite e index.html stanno in `client/` ma non danno a nessuno
    // niente da guardare: la regola dice `client/src/**`, e lo dice sul serio.
    expect(isUserVisibleFile("client/vite.config.ts")).toBe(false);
    expect(isUserVisibleFile("client/index.html")).toBe(false);
    expect(isUserVisibleFile("server/routes/tasks.ts")).toBe(false);
    expect(isUserVisibleFile("scripts/board-doctor.ts")).toBe(false);
    expect(isUserVisibleFile("docs/board-protocol.md")).toBe(false);
    expect(isUserVisibleFile("tests/e2e/board.spec.ts")).toBe(false);
    expect(isUserVisibleFile("desktop-tauri/src-tauri/src/main.rs")).toBe(false);
  });
  test("il prefisso `./` non cambia la risposta", () => {
    expect(isUserVisibleFile("./client/src/App.tsx")).toBe(true);
  });
});

describe("deriveVisibility", () => {
  test("un solo file di client/src fuori dai test basta a renderla visibile", () => {
    expect(deriveVisibility(["server/a.ts", "server/b.ts", "client/src/App.tsx"])).toBe("visibile");
  });
  test("server, script, test e doc: invisibile", () => {
    expect(deriveVisibility(["server/routes/tasks.ts", "docs/board-protocol.md"])).toBe("invisibile");
    expect(deriveVisibility(["scripts/probe.mjs", "tests/e2e/x.spec.ts"])).toBe("invisibile");
  });
  test("SOLO test del client: invisibile — nessuno li vede girare", () => {
    expect(deriveVisibility(["client/src/components/Board/format.test.ts"])).toBe("invisibile");
  });
  test("NESSUN file toccato ⇒ VISIBILE, non invisibile", () => {
    // L'attenzione che vale quanto la regola. Un piano, una decisione, una
    // ricerca, un acquisto non producono diff: se l'assenza di file valesse
    // "invisibile", la macchina si chiuderebbe da sé proprio le card che solo
    // un umano può giudicare. L'assenza di prova non è prova.
    expect(deriveVisibility([])).toBe("visibile");
  });
});

describe("chi può scrivere che cosa", () => {
  test("un agente alza la mano, non se la abbassa", () => {
    expect(isAgentWritableLabel("visibile")).toBe(true);
    expect(isAgentWritableLabel("invisibile")).toBe(false);
  });
  test("le etichette di genere non decidono niente, quindi le scrive chiunque", () => {
    for (const l of KIND_LABELS) expect(isAgentWritableLabel(l)).toBe(true);
  });
  test("ciò che non è nel vocabolario non è scrivibile da nessuno", () => {
    expect(isAgentWritableLabel("bugfix-ui")).toBe(false);
  });
});

describe("whoCloses — la conseguenza operativa", () => {
  test("invisibile + barra verde ⇒ la chiude il conduttore", () => {
    expect(whoCloses(['invisibile', 'chore'], 'pass')).toBe("conductor");
  });
  test("visibile con la barra verde resta all'umano", () => {
    expect(whoCloses(["visibile"], "pass")).toBe("human");
  });
  test("invisibile ma barra rossa, in corso o MAI GIRATA ⇒ umano", () => {
    // `null` è il caso che conta: "nessun check" non è un verde, e una card che
    // non ha mai fatto girare la barra non è autorizzata da nessuno.
    expect(whoCloses(["invisibile"], "fail")).toBe("human");
    expect(whoCloses(["invisibile"], "running")).toBe("human");
    expect(whoCloses(["invisibile"], null)).toBe("human");
  });
  test("senza etichette la chiude un umano — il default sicuro", () => {
    expect(whoCloses([], "pass")).toBe("human");
  });
});

describe("normalizeLabels", () => {
  test("scarta l'ignoto e deduplica", () => {
    expect(normalizeLabels(["bugfix", "bugfix", "nope", 3, null])).toEqual(["bugfix"]);
  });
  test("una sola visibilità: `visibile` e `invisibile` insieme non sono una card", () => {
    expect(normalizeLabels(["visibile", "chore", "invisibile"])).toEqual(["chore", "invisibile"]);
    expect(normalizeLabels(["invisibile", "visibile"])).toEqual(["visibile"]);
  });
});

/**
 * LA BARRA. La regola è nata da uno smistamento a mano sulla coda di review
 * dell'11/08/2026: 29 card, aperte una per una, guardando il diff. Qui la stessa
 * coda è congelata in `tests/fixtures/review-queue-2026-08-11.json` — le 29 card
 * vere, con i file dei loro commit PROPRI ricostruiti da git — e la derivazione
 * ci ripassa sopra.
 *
 * Il verdetto atteso è DATO, non ricalcolato: se qualcuno allarga la regola a
 * `client/**`, o si dimentica l'esclusione dei `*.test.*`, o decide che una card
 * senza codice è invisibile, il conto qui cambia e il test lo dice.
 */
describe("BARRA — la coda di review dell'11/08/2026", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "tests", "fixtures", "review-queue-2026-08-11.json"), "utf8"),
  ) as { at: string; cards: Array<{ id: string; text: string; basis: string; files: string[]; expected: string }> };

  test("sono le 29 card che stavano in review a quell'istante", () => {
    expect(fixture.cards).toHaveLength(29);
    expect(new Set(fixture.cards.map((c) => c.id)).size).toBe(29);
  });

  test("la derivazione dà lo stesso verdetto su OGNI card", () => {
    const disagree = fixture.cards
      .filter((c) => deriveVisibility(c.files) !== c.expected)
      .map((c) => `${c.id.slice(0, 8)} ${c.text.slice(0, 40)}`);
    expect(disagree).toEqual([]);
  });

  test("il conto: 23 visibili, 6 invisibili", () => {
    // Il numero è la misura, e va scritto qui perché una fixture rigenerata che
    // sposta lo spartiacque non passi in silenzio.
    //
    // ATTENZIONE, e sta qui perché è il pezzo onesto: lo smistamento a mano di
    // Attilio quel giorno contava 19/10, non 23/6. Le liste di file non sono più
    // ricostruibili come le vide lui — i rami di due card sono stati assorbiti da
    // altri rami (basis `own-commits-empty`: zero commit propri oggi) e la coda è
    // stata approvata, potata e mergiata nelle ore successive. Le card su cui la
    // regola e la mano possono divergere sono quelle in cui `client/src` è una
    // minoranza del diff (b8706bdc 1/10, f3fe84b4 2/14, 08541fae 3/14, 799f5496
    // 3/17, 7fb737a9 3/18): la regola dice «tocca ⇒ visibile» e non pesa. La
    // correzione è un campo `expected` in questo file, e resta perché una
    // visibilità `human` la derivazione non la sovrascrive più.
    const visibili = fixture.cards.filter((c) => deriveVisibility(c.files) === "visibile");
    const invisibili = fixture.cards.filter((c) => deriveVisibility(c.files) === "invisibile");
    expect(visibili).toHaveLength(23);
    expect(invisibili).toHaveLength(6);
  });

  test("le card ricostruite VUOTE sono dichiarate, non spacciate per misure", () => {
    // `own-commits-empty` = oggi quel ramo non ha più commit propri. Cadono su
    // `visibile` per la regola dell'assenza-di-codice — che è il default sicuro,
    // ma non è un'osservazione sul loro diff, ed è scritto nel file.
    const empty = fixture.cards.filter((c) => !c.files.length);
    expect(empty.every((c) => c.basis.endsWith("-empty") || c.basis === "unreconstructible")).toBe(true);
    expect(empty).toHaveLength(2);
  });

  test("un terzo della coda non lo poteva vedere nessuno: ci sono card senza UNA riga di client", () => {
    // La misura che ha giustificato il lavoro: card con del codice sotto e zero
    // superficie. Se questa lista si svuotasse, la regola non servirebbe a nulla.
    const cieche = fixture.cards.filter((c) => c.files.length && !c.files.some(isUserVisibleFile));
    expect(cieche.length).toBeGreaterThanOrEqual(6);
  });
});
