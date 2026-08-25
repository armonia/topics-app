/**
 * @covers KANBAN-17
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveCloser,
  deriveKind,
  isAgentWritableLabel,
  isDocumentFile,
  isTaskLabel,
  isUserVisibleFile,
  normalizeLabels,
  whoCloses,
  CLOSER_LABELS,
  KIND_LABELS,
  TASK_LABELS,
} from "./task-labels";

describe("il vocabolario è CHIUSO", () => {
  test("sette etichette: TRE che decidono chi chiude, quattro che filtrano", () => {
    // Tre, non due. `decisione` è la classe che mancava, ed è quella che salva i
    // piani dall'essere chiusi dalla macchina.
    expect(CLOSER_LABELS).toEqual(["visibile", "decisione", "invisibile"]);
    expect(KIND_LABELS).toEqual(["bugfix", "feature", "chore", "misura"]);
    expect(TASK_LABELS).toHaveLength(7);
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

describe("isDocumentFile — che cos'è un documento", () => {
  test("un .md ovunque, e tutto ciò che sta sotto openspec/ e docs/", () => {
    expect(isDocumentFile("docs/PIANO-amicizia-sessioni.md")).toBe(true);
    expect(isDocumentFile("desktop-tauri/SIGNING.md")).toBe(true);
    expect(isDocumentFile("README.md")).toBe(true);
    // Gli allegati di una proposta restano parte della proposta: un mockup non
    // trasforma un piano in codice.
    expect(isDocumentFile("openspec/changes/agent-inline-browser/mockup.html")).toBe(true);
  });
  test("il codice non è un documento, nemmeno se è piccolo", () => {
    expect(isDocumentFile("server/routes/tasks.ts")).toBe(false);
    expect(isDocumentFile("scripts/probe-fake-mic.mjs")).toBe(false);
    expect(isDocumentFile("knip.jsonc")).toBe(false);
  });
});

describe("deriveCloser — le tre classi", () => {
  test("un solo file di client/src fuori dai test basta a renderla visibile", () => {
    expect(deriveCloser(["server/a.ts", "server/b.ts", "client/src/App.tsx"])).toBe("visibile");
  });
  test("l'ordine è la regola: client/src vince anche se è il 10% del diff", () => {
    // Il peso non c'entra: una superficie che si vede è una superficie che si
    // guarda. `0a1b2c05` toccava 3 file di client su 14 ed è visibile.
    const files = [...Array(13).keys()].map((i) => `server/f${i}.ts`);
    expect(deriveCloser([...files, "client/src/App.tsx"])).toBe("visibile");
  });
  test("server, script e test senza client: INVISIBILE — la chiude il conduttore", () => {
    expect(deriveCloser(["server/routes/tasks.ts", "shared/board.ts"])).toBe("invisibile");
    expect(deriveCloser(["scripts/probe.mjs", "tests/e2e/x.spec.ts"])).toBe("invisibile");
  });
  test("SOLO test del client: invisibile — nessuno li vede girare", () => {
    expect(deriveCloser(["client/src/components/Board/format.test.ts"])).toBe("invisibile");
  });
  test("SOLO documenti ⇒ DECISIONE, non invisibile", () => {
    // Il caso che la regola a due classi sbagliava: sette piani su una trentina
    // di card finivano in «invisibile» e l'agente se li sarebbe chiusi da solo.
    // Un piano non è invisibile: è invisibile il suo effetto, non la sua importanza.
    expect(deriveCloser(["docs/PIANO-amicizia-sessioni.md"])).toBe("decisione");
    expect(deriveCloser(["openspec/changes/x/proposal.md", "openspec/changes/x/mockup.html"])).toBe("decisione");
    expect(deriveCloser(["desktop-tauri/SIGNING.md"])).toBe("decisione");
  });
  test("NESSUN file toccato ⇒ DECISIONE", () => {
    // Un acquisto, una ricerca, una decisione non producono diff. L'assenza di
    // prova non è prova: la card resta di chi decide.
    expect(deriveCloser([])).toBe("decisione");
  });
  test("un documento INSIEME al codice non salva il codice", () => {
    // Un `.md` accanto a un cambio di server non lo trasforma in un piano.
    expect(deriveCloser(["docs/x.md", "server/routes/tasks.ts"])).toBe("invisibile");
  });
});

describe("chi può scrivere che cosa", () => {
  test("un agente alza la mano, non se la abbassa", () => {
    // `visibile` e `decisione` sono due modi di passare la card a un umano:
    // sempre permessi. `invisibile` è l'unica che gliela toglie.
    expect(isAgentWritableLabel("visibile")).toBe(true);
    expect(isAgentWritableLabel("decisione")).toBe(true);
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
  test("visibile e decisione con la barra verde restano all'umano", () => {
    expect(whoCloses(["visibile"], "pass")).toBe("human");
    expect(whoCloses(["decisione"], "pass")).toBe("human");
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
 * LA BARRA. La regola è nata da uno smistamento a mano su una coda di review di
 * 29 card, aperte una per una, guardando il diff. Quella coda è congelata in
 * `tests/fixtures/review-queue-2026-08-11.json`: la forma è quella misurata (29
 * card, i file dei loro commit PROPRI, il verdetto dato a mano), mentre id e
 * titoli sono SINTETICI: il file sta in un repo pubblico e non deve raccontare
 * la roadmap di nessuno. La derivazione ci ripassa sopra.
 *
 * Il verdetto atteso è DATO, non ricalcolato: se qualcuno allarga la regola a
 * `client/**`, si dimentica l'esclusione dei `*.test.*`, o rimette i documenti
 * nello stesso mucchio del codice, il conto qui cambia e il test lo dice.
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
      .filter((c) => deriveCloser(c.files) !== c.expected)
      .map((c) => `${c.id.slice(0, 8)} ${c.text.slice(0, 40)}`);
    expect(disagree).toEqual([]);
  });

  test("IL CONTO: 21 visibili, 6 decisioni, 2 invisibili", () => {
    // Questa è la barra, e questa volta torna.
    //
    // La barra originale diceva 19/10 e la prima implementazione dava 23/6:
    // NESSUNO dei due era il numero giusto, perché entrambi contavano con DUE
    // classi una coda che ne ha tre. Con le tre classi il conto è 21/6/2, e i
    // due numeri che decidono qualcosa coincidono con lo smistamento a mano
    // (21 visibili, 2 invisibili su ~30 card; a mano la terza classe ne contava
    // 7 perché quell'istantanea, presa più tardi, aveva una card in più della
    // coda congelata qui).
    //
    // Il numero che cambia il lavoro è l'ULTIMO: la scorciatoia vale 2 card su
    // 29, non 10. Con la regola a due classi le 6 decisioni (un piano, una
    // ricerca, una proposta openspec, un documento di rilascio e due card senza
    // file) sarebbero finite in «invisibile», cioè le avrebbe chiuse il conduttore.
    // Sono esattamente le card su cui deve decidere una persona.
    const by = (k: string) => fixture.cards.filter((c) => deriveCloser(c.files) === k);
    expect(by("visibile")).toHaveLength(21);
    expect(by("decisione")).toHaveLength(6);
    expect(by("invisibile")).toHaveLength(2);
  });

  test("la scorciatoia è STRETTA: meno di una card su dieci la chiude la macchina", () => {
    // Se un giorno questa proporzione si ribaltasse senza che nessuno l'abbia
    // deciso, vorrebbe dire che la regola ha smesso di misurare ciò che si vede.
    const auto = fixture.cards.filter((c) => deriveCloser(c.files) === "invisibile");
    expect(auto.length / fixture.cards.length).toBeLessThan(0.1);
  });

  test("le card ricostruite VUOTE sono dichiarate, non spacciate per misure", () => {
    // `own-commits-empty` = oggi quel ramo non ha più commit propri. Cadono su
    // `decisione`, che è il default sicuro (la chiude un umano) — ma non è
    // un'osservazione sul loro diff, ed è scritto nel `basis`.
    const empty = fixture.cards.filter((c) => !c.files.length);
    expect(empty.every((c) => c.basis.includes("empty") || c.basis === "unreconstructible")).toBe(true);
    expect(empty).toHaveLength(2);
  });

  test("i piani NON finiscono fra le invisibili", () => {
    // Il difetto della prima versione, in una asserzione: nessuna card di soli
    // documenti può essere marcata invisibile.
    const docsOnly = fixture.cards.filter((c) => c.files.length && c.files.every(isDocumentFile));
    expect(docsOnly.length).toBeGreaterThanOrEqual(4);
    for (const c of docsOnly) expect(deriveCloser(c.files)).toBe("decisione");
  });
});

describe("deriveKind — il genere si deriva, non si aspetta che qualcuno lo scriva", () => {
  const mod = (...paths: string[]) => paths.map((path) => ({ path, added: false }));
  const add = (...paths: string[]) => paths.map((path) => ({ path, added: true }));

  test("SOLO test toccati ⇒ `misura`, anche quando i test sono nuovi", () => {
    expect(deriveKind(mod("tests/e2e/board.spec.ts"))).toBe("misura");
    expect(deriveKind(add("client/src/lib/board.test.ts"))).toBe("misura");
    expect(deriveKind([...mod("tests/unit/a.test.ts"), ...add("server/x.test.ts")])).toBe("misura");
  });

  test("SOLO build/config/dipendenze ⇒ `chore`", () => {
    expect(deriveKind(mod("package.json", "bun.lock"))).toBe("chore");
    expect(deriveKind(mod(".github/workflows/tauri-release.yml"))).toBe("chore");
    expect(deriveKind(mod("desktop-tauri/src-tauri/Cargo.toml"))).toBe("chore");
    expect(deriveKind(mod("tsconfig.json", "knip.jsonc", "client/vite.config.ts"))).toBe("chore");
  });

  test("un file NUOVO di prodotto ⇒ `feature`, e basta che sia uno", () => {
    expect(deriveKind(add("client/src/components/Board/Chip.tsx"))).toBe("feature");
    expect(deriveKind([...mod("server/routes/tasks.ts"), ...add("server/services/kind.ts")]))
      .toBe("feature");
  });

  test("solo modifiche a codice che esisteva già ⇒ `bugfix`", () => {
    expect(deriveKind(mod("server/routes/tasks.ts", "shared/board.ts"))).toBe("bugfix");
    expect(deriveKind(mod("client/src/App.tsx"))).toBe("bugfix");
  });

  test("i file di CONTORNO non spostano il genere del prodotto", () => {
    // Un fix di server che si porta dietro il suo test e un bump di lockfile
    // resta un fix: test e config accompagnano il lavoro, non lo classificano.
    expect(deriveKind([...mod("server/routes/tasks.ts", "bun.lock"), ...add("server/routes/tasks.test.ts")]))
      .toBe("bugfix");
    // E un file nuovo di prodotto resta una feature anche in mezzo ai test.
    expect(deriveKind(add("client/src/components/New.tsx", "tests/e2e/new.spec.ts")))
      .toBe("feature");
  });

  test("ciò per cui il vocabolario NON ha una parola non prende un genere", () => {
    // Niente file: non c'è niente da misurare. E una card di soli documenti è un
    // piano o una ricerca — `chore` sarebbe una bugia che poi il filtro propaga.
    expect(deriveKind([])).toBeNull();
    expect(deriveKind(mod("docs/PIANO-amicizia-sessioni.md"))).toBeNull();
    expect(deriveKind(add("openspec/changes/x/proposal.md", "openspec/changes/x/mockup.html")))
      .toBeNull();
  });

  test("un genere derivato è SEMPRE una parola del vocabolario chiuso", () => {
    const cases = [mod("server/a.ts"), add("client/src/a.tsx"), mod("package.json"), mod("tests/a.spec.ts")];
    for (const c of cases) expect(KIND_LABELS).toContain(deriveKind(c)!);
  });
});
