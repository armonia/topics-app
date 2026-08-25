/**
 * Le fixture sono l'output LETTERALE di git, catturato da un repo vero, non
 * ricostruito a memoria: il formato dei rename e dei binari e' esattamente il
 * punto in cui questo parser puo' sbagliare.
 *
 * @covers GIT-COUNT-01
 */
import { test, expect, describe } from "bun:test";
import { parseNumstatZ, statOf, attachNumstats, NUMSTAT_MAX_FILES } from "./git-numstat";

// git diff --numstat -z  (modifica + cancellazione, con un path non-ASCII)
const NON_STAGED = "0\t1\tcittà.md\x002\t0\ttesto.md\x00";
// git diff --cached --numstat -z  (aggiunta + binario + rename)
const STAGED = "2\t0\taggiunto.md\x001\t1\tbin.dat\x000\t0\t\x00da-rinominare.md\x00rinominato.md\x00";
// Un binario vero: git non conta le righe.
const BINARIO = "-\t-\tvero.bin\x00";

describe("parseNumstatZ", () => {
  test("legge i conteggi e tiene il path grezzo", () => {
    const m = parseNumstatZ(NON_STAGED);
    expect(m.size).toBe(2);
    expect(m.get("città.md")).toEqual({ added: 0, removed: 1 });
    expect(m.get("testo.md")).toEqual({ added: 2, removed: 0 });
  });

  test("un rename si aggancia al path NUOVO, non al vecchio", () => {
    const m = parseNumstatZ(STAGED);
    // L'ordine nel record e' vecchio-poi-nuovo, il contrario di status -z.
    expect(m.has("rinominato.md")).toBe(true);
    expect(m.has("da-rinominare.md")).toBe(false);
  });

  test("i due path del rename non fanno slittare i record successivi", () => {
    // Il rename sta in mezzo: se i suoi campi non vengono consumati entrambi,
    // il record dopo viene letto come se fosse un path e i conteggi scivolano.
    const m = parseNumstatZ("0\t0\t\x00vecchio.md\x00nuovo.md\x005\t2\tdopo.md\x00");
    expect(m.get("dopo.md")).toEqual({ added: 5, removed: 2 });
    expect(m.size).toBe(2);
  });

  test("un binario non e' zero righe", () => {
    const m = parseNumstatZ(BINARIO);
    expect(m.get("vero.bin")).toEqual({ added: 0, removed: 0, binary: true });
  });

  test("nessuna modifica: mappa vuota, non un errore", () => {
    expect(parseNumstatZ("").size).toBe(0);
  });

  test("un record senza tab si salta invece di produrre un path vuoto", () => {
    const m = parseNumstatZ("spazzatura\x003\t1\tbuono.md\x00");
    expect(m.size).toBe(1);
    expect(m.get("buono.md")).toEqual({ added: 3, removed: 1 });
  });
});

describe("statOf", () => {
  const m = parseNumstatZ("4\t2\tsotto/cartella/a.md\x00");

  test("senza prefisso cerca il path com'e'", () => {
    expect(statOf(m, "sotto/cartella/a.md", "")).toEqual({ added: 4, removed: 2 });
  });

  test("con prefisso lo rimette: git risponde dalla radice del repo", () => {
    // La lista mostra `a.md`, git dice `sotto/cartella/a.md`.
    expect(statOf(m, "a.md", "sotto/cartella/")).toEqual({ added: 4, removed: 2 });
  });

  test("chi non ha conteggi torna undefined, non zero", () => {
    // Zero direbbe «nessuna riga cambiata», che e' un'altra cosa da «non lo so».
    expect(statOf(m, "altro.md", "")).toBeUndefined();
  });
});

describe("attachNumstats", () => {
  const stats = {
    staged: parseNumstatZ("10\t0\tmezzo.md\x005\t5\tsolo-staged.md\x00"),
    unstaged: parseNumstatZ("3\t1\tmezzo.md\x002\t0\tsolo-albero.md\x00"),
  };

  test("un file staged a meta' porta due numeri diversi, non lo stesso due volte", () => {
    // `MM`: staged nell'indice E modificato ancora nell'albero.
    const [f] = attachNumstats([{ path: "mezzo.md", status: "MM" }], stats, "");
    expect(f.staged).toEqual({ added: 10, removed: 0 });
    expect(f.unstaged).toEqual({ added: 3, removed: 1 });
  });

  test("guarda il lato giusto: un file solo staged non prende numeri dall'albero", () => {
    const [f] = attachNumstats([{ path: "solo-staged.md", status: "M " }], stats, "");
    expect(f.staged).toEqual({ added: 5, removed: 5 });
    expect(f.unstaged).toBeUndefined();
  });

  test("un non tracciato resta senza numeri", () => {
    // git non lo mette in nessun diff: uno zero direbbe «non e' cambiato».
    const [f] = attachNumstats([{ path: "nuovo.md", status: "??" }], stats, "");
    expect(f.staged).toBeUndefined();
    expect(f.unstaged).toBeUndefined();
  });

  test("oltre la soglia i conteggi si saltano e la lista resta intera", () => {
    const tanti = Array.from({ length: NUMSTAT_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, status: " M" }));
    const out = attachNumstats(tanti, stats, "");
    expect(out.length).toBe(NUMSTAT_MAX_FILES + 1);
    expect(out.every(f => f.unstaged === undefined)).toBe(true);
  });
});
