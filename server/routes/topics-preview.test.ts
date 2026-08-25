/**
 * @covers TOPIC-PREVIEW-01
 */
import { describe, test, expect } from "bun:test";
import { topicPreviewText } from "./topics";

/**
 * DUE GEMELLE, UNA SOLA TESTATA.
 *
 * `topicPreviewText` (qui) e `cleanPreviewText` in
 * `client/src/state/topicPreviews.ts` sono due copie a mano della stessa
 * potatura — devono esserlo: il server pota ciò che manda al boot, il client
 * pota ciò che arriva dal WS, e i due lati non condividono un modulo. Finché
 * solo la copia CLIENT aveva un test, potevano divergere in silenzio: un caso
 * aggiustato di là e non di qua, e la stessa chat diceva due cose diverse a
 * seconda di quale canale l'aveva riempita.
 *
 * Questo file è quindi lo SPECCHIO di `topicPreviews.test.ts`: gli stessi casi,
 * le stesse attese. Se ne aggiungi uno lì, aggiungilo anche qui — è il senso del
 * file. Il troncamento a 120 caratteri è l'unica misura condivisa (`PREVIEW_MAX_CHARS`
 * di qua, `TOPIC_PREVIEW_MAX` di là) e viene asserito col numero nudo, così una
 * costante spostata da un lato solo si vede.
 */

const PREVIEW_MAX = 120;

describe("topicPreviewText — potatura (specchio del test client)", () => {
  test("un blocco di codice sparisce, la frase che lo introduceva resta", () => {
    const raw = "Ecco la patch:\n```ts\nconst x = 1;\nconst y = 2;\n```\nProvala.";
    expect(topicPreviewText(raw)).toBe("Ecco la patch: Provala.");
  });

  test("la recinzione APERTA (turno tagliato a metà) si porta via la coda", () => {
    expect(topicPreviewText("Guarda qui:\n```sh\nrm -rf /tmp/x")).toBe("Guarda qui:");
  });

  test("niente a-capo: il testo diventa UNA riga e gli spazi si comprimono", () => {
    const out = topicPreviewText("prima riga\n\n   seconda   riga\t\tterza");
    expect(out).toBe("prima riga seconda riga terza");
    expect(out).not.toContain("\n");
  });

  test("via i marcatori di struttura, ma NON gli underscore delle parole", () => {
    expect(topicPreviewText("## Titolo\n- primo\n1. secondo\n> citato")).toBe(
      "Titolo primo secondo citato",
    );
    // Se `__` sparisse, `mcp__topics__browser` diventerebbe una parola diversa.
    expect(topicPreviewText("ho chiamato mcp__topics__browser_navigate su session_key")).toBe(
      "ho chiamato mcp__topics__browser_navigate su session_key",
    );
  });

  test("grassetto e corsivo via, una moltiplicazione resta una moltiplicazione", () => {
    expect(topicPreviewText("**fatto** in *fretta*")).toBe("fatto in fretta");
    expect(topicPreviewText("conta 2 * 3 * 4 celle")).toBe("conta 2 * 3 * 4 celle");
  });

  test("link ridotto alla sua etichetta, immagine via, backtick via", () => {
    expect(topicPreviewText("vedi [il report](https://esempio.test/x?y=1) e `foo.ts`")).toBe(
      "vedi il report e foo.ts",
    );
    expect(topicPreviewText("![grafico](/media/a.png) ecco")).toBe("ecco");
  });

  test("una riga orizzontale non diventa il primo carattere che si legge", () => {
    expect(topicPreviewText("fatto\n---\ndettagli")).toBe("fatto dettagli");
  });

  test("l'impalcatura iniettata non è un messaggio", () => {
    expect(topicPreviewText("<system-reminder>non dirlo</system-reminder> ciao")).toBe("ciao");
  });

  test("un messaggio di solo codice non lascia niente", () => {
    expect(topicPreviewText("```\nrm -rf /\n```")).toBe("");
  });
});

describe("topicPreviewText — troncamento", () => {
  test("taglia a PREVIEW_MAX_CHARS con i puntini, senza superarlo", () => {
    const out = topicPreviewText("a".repeat(500));
    expect(out.length).toBe(PREVIEW_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  test("un testo corto non viene toccato", () => {
    expect(topicPreviewText("ok")).toBe("ok");
  });

  test("è IDEMPOTENTE: il client ripassa sul testo già potato dal server", () => {
    const once = topicPreviewText("Ecco:\n```js\nfoo()\n```\n" + "parola ".repeat(60));
    expect(topicPreviewText(once)).toBe(once);
  });
});
