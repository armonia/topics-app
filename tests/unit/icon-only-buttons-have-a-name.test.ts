/**
 * @covers A11Y-01
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, statSync, readFileSync } from "fs";
import { resolve, join } from "path";

/**
 * Un bottone che contiene SOLO un'icona deve avere un nome.
 *
 * Per chi vede, una «×» in alto a destra è ovvia. Per uno screen reader un
 * `<button><X /></button>` si annuncia «button» e basta: nessun nome, nessun
 * modo di sapere che chiude. Non è una sfumatura di stile — è la differenza fra
 * poter chiudere un pannello e non poterlo chiudere.
 *
 * Al 2026-08-10 erano DICIASSETTE, e quasi tutte erano chiusure: le impostazioni
 * globali, l'ispettore del contesto, il dettaglio di un task, le scorciatoie da
 * tastiera, il toast, la tab dell'editor, la risposta in composizione, i due
 * banner di esito comando. Cioè proprio i comandi che servono per USCIRE da
 * qualcosa. Il repo l'a11y la misura già (`axe-core` in
 * `tests/e2e/chat-layout-audit.spec.ts`), ma su UNA superficie: questo controllo
 * costa un grep e vale su tutte.
 *
 * COSA GUARDA, ESATTAMENTE. Un `<button>` il cui contenuto è UN SOLO componente
 * auto-chiuso con l'iniziale maiuscola — cioè un'icona e nient'altro — e che non
 * porta né `aria-label`, né `aria-labelledby`, né `title`.
 *
 * Il perimetro è stretto di proposito. La prima versione segnalava qualunque
 * bottone senza testo LETTERALE e ne trovava 89: due su quattro, controllati a
 * mano, erano falsi positivi, perché il testo stava in un'espressione
 * (`{label}`, `{g.nome}`) — che per il DOM è testo a tutti gli effetti.
 * Distinguere `{icona}` da `{etichetta}` con un'espressione regolare non si può,
 * e un cancello che grida ottantanove volte lo si spegne il primo giorno. La
 * classe «solo un'icona» invece è dimostrabile guardando il sorgente, ed è anche
 * quella dove il difetto è certo.
 *
 * `title` conta come nome perché in HTML lo è (fallback del nome accessibile) ed
 * è ciò che il resto di questo repo usa già sui comandi delle righe.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = resolve(ROOT, "client", "src");

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sorgenti(p, out);
    else if (e.endsWith(".tsx") && !e.includes(".test.")) out.push(p);
  }
  return out;
}

/** Un solo componente auto-chiuso con iniziale maiuscola: `<X size={12} />`. */
const ONLY_ONE_ICON = /^<[A-Z][A-Za-z0-9]*(\s[^>]*?)?\/>$/s;
const HA_UN_NOME = /aria-label|aria-labelledby|\btitle=/;

/** Fine del tag di apertura, saltando le graffe JSX (`className={`…`}`). */
function fineTagApertura(src: string, da: number): number {
  let depth = 0;
  for (let i = da; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

function senzaNome(file: string): number[] {
  const src = readFileSync(file, "utf8");
  const righe: number[] = [];
  for (const m of src.matchAll(/<button\b/g)) {
    const i = m.index!;
    const fine = fineTagApertura(src, i);
    if (fine < 0) continue;
    if (HA_UN_NOME.test(src.slice(i, fine + 1))) continue;
    const chiusura = src.indexOf("</button>", fine);
    if (chiusura < 0) continue;
    const corpo = src.slice(fine + 1, chiusura).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").trim();
    if (ONLY_ONE_ICON.test(corpo)) righe.push(src.slice(0, i).split("\n").length);
  }
  return righe;
}

describe("nessun bottone di sola icona resta senza nome", () => {
  const files = sorgenti(SRC);

  test("i sorgenti sono stati trovati (guardia contro un verde a vuoto)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("ogni bottone che contiene solo un'icona ha un nome accessibile", () => {
    const colpevoli: string[] = [];
    for (const f of files) {
      for (const riga of senzaNome(f)) colpevoli.push(`${f.slice(ROOT.length + 1)}:${riga}`);
    }
    expect(
      colpevoli,
      'questi <button> contengono solo un\'icona e nessun nome: uno screen reader li annuncia "button" e basta. Aggiungi `aria-label` (o `title`) che dica cosa fa il comando, non che icona porta.',
    ).toEqual([]);
  });
});
