#!/usr/bin/env bun
/**
 * IL CANCELLO CHE MANCAVA AL CRASH DELLA RAFFICA.
 *
 * COSA E' SUCCESSO. Il 2026-08-16 una raffica di messaggi ha ucciso la pane
 * della chat: React #185 «Maximum update depth exceeded», zero messaggi
 * disegnati, «Questa pane si e' rotta». La causa, corretta in `39001fa9`:
 * `scrollerRef` di Virtuoso era una freccia scritta INLINE nel JSX di
 * `MessageList.tsx`. Una freccia inline e' una funzione nuova a ogni render, e
 * React tratta il cambio di identita' di una callback ref come uno
 * scollegamento — chiama la vecchia con `null` e la nuova con l'elemento. Se
 * dentro quella callback c'e' un `setState`, ogni render ne fa partire due, il
 * valore alterna `null` e l'elemento, e ognuna delle due chiamate provoca un
 * altro render. Il ciclo si chiude su se stesso.
 *
 * PERCHE' UNO SCRIPT E NON UNA SPEC E2E. La card lo dice, e vale la pena non
 * rifare la strada: una spec che versa 120 messaggi da 4 KB passa IDENTICA con
 * e senza il fix; anche con 300 da 8 KB; anche cedendo il controllo alla pagina
 * ogni 5-10 messaggi; e non si vede nemmeno sul tempo (10,3-10,5 s senza fix
 * contro 10,3-10,7 con). Le due volte in cui e' crashato la macchina era carica
 * di agenti. Un cancello che dipende dal carico e' «un cancello che grida a
 * caso», cioe' uno che verra' spento.
 *
 * QUESTO MISURA LA CAUSA, NON L'EFFETTO, ed e' per quello che e' deterministico:
 * la forma del codice che produce il ciclo si vede leggendo il JSX, e non ha
 * bisogno di riprodurre il crash — che e' la parte che dipende dal carico.
 *
 * COSA E' ROSSO: una callback ref scritta inline nel JSX (`ref={(el) => ...}`,
 * `scrollerRef={(el) => ...}`) il cui corpo invoca un setter di stato React.
 * Il rimedio e' sempre lo stesso: `useCallback` con le dipendenze giuste, che
 * e' esattamente cio' che ha chiuso il difetto.
 *
 * COSA NON E' ROSSO, di proposito: una callback ref inline che scrive SOLO in un
 * ref (`ref={(n) => { slotRefs.current[i] = n; }}`). Il repo ne ha otto, sono
 * corrette, e non toccano lo stato: la doppia invocazione le fa scrivere due
 * volte lo stesso valore e finisce li'. Vietarle tutte sarebbe un cancello che
 * chiede lavoro senza togliere un difetto, cioe' il tipo che si impara a
 * spegnere.
 *
 * COME SI VEDE ROSSO:
 *   bun run scripts/check-ref-callbacks.ts --self-test
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");

/** Un attributo che consegna un elemento del DOM: `ref`, `scrollerRef`, `innerRef`… */
const REF_ATTR = /(^|\s)([a-zA-Z]*[Rr]ef)=\{\(/;

/**
 * `setQualcosa(` — la convenzione dei setter di `useState`.
 *
 * E' un'euristica sul NOME, quindi prende anche funzioni che setter non sono:
 * `MessageContent.tsx` ha un `setRef` che e' una `useCallback` e scrive solo in
 * una Map dentro un ref. Per questo non basta il nome — vedi `dichiaratoLocale`.
 */
const SETTER = /\bset[A-Z][A-Za-z0-9_]*\s*\(/;

/**
 * Quel nome e' dichiarato NEL FILE come funzione normale?
 *
 * Un setter di `useState` non si dichiara: arriva dalla destrutturazione
 * `const [x, setX] = useState(...)`. Se invece il file contiene
 * `const setX = useCallback(...)` o `function setX(`, allora e' roba sua, ha
 * identita' stabile, e chiamarla dentro una callback ref non innesca niente.
 *
 * Il verso di questa esclusione e' quello giusto: un falso NEGATIVO qui
 * significa non vedere un difetto raro; un falso POSITIVO significa un cancello
 * che chiede di riscrivere codice corretto, ed e' cosi' che un cancello si fa
 * spegnere.
 */
function dichiaratoLocale(src: string, nome: string): boolean {
  const esc = nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(const|let|var|function)\\s+${esc}\\b`).test(src);
}

export interface Hit {
  file: string;
  line: number;
  attr: string;
  text: string;
}

/**
 * Le callback ref inline che toccano lo stato, in una sorgente.
 *
 * Il corpo si legge bilanciando le graffe dall'apertura della freccia: una
 * riga sola non basta, perche' la forma pericolosa e' quasi sempre su piu'
 * righe, ed e' proprio quella che un grep riga-per-riga si perde.
 */
export function findInlineRefSetters(src: string, file = "<memoria>"): Hit[] {
  const out: Hit[] = [];
  const righe = src.split(/\r?\n/);
  for (let i = 0; i < righe.length; i++) {
    const m = REF_ATTR.exec(righe[i]);
    if (!m) continue;
    // Il corpo: da qui fino alla chiusura della parentesi dell'attributo.
    let depth = 0;
    let corpo = "";
    let visto = false;
    for (let j = i; j < Math.min(righe.length, i + 40); j++) {
      const riga = j === i ? righe[j].slice(m.index) : righe[j];
      for (const ch of riga) {
        if (ch === "{") { depth++; visto = true; }
        else if (ch === "}") depth--;
        corpo += ch;
        if (visto && depth === 0) break;
      }
      corpo += "\n";
      if (visto && depth === 0) break;
    }
    const chiamati = [...corpo.matchAll(/\bset[A-Z][A-Za-z0-9_]*(?=\s*\()/g)].map((x) => x[0]);
    const veriSetter = chiamati.filter((n) => !dichiaratoLocale(src, n));
    if (!SETTER.test(corpo) || veriSetter.length === 0) continue;
    out.push({ file, line: i + 1, attr: m[2], text: righe[i].trim() });
  }
  return out;
}

function tracked(): string[] {
  const r = spawnSync("git", ["ls-files", "client/**/*.tsx"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files e' uscito ${r.status}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    // La forma ESATTA che ha causato il crash, prima di `39001fa9`.
    const difetto = `
      <Virtuoso
        scrollerRef={(ref) => {
          const el = ref as HTMLElement | null;
          scrollerElRef.current = el;
          setScrollerEl((prev) => (prev === el ? prev : el));
        }}
      />`;
    const sano = `<div ref={(n) => { slotRefs.current[0] = n; }} />`;
    const rossi = findInlineRefSetters(difetto);
    const verdi = findInlineRefSetters(sano);
    const ok = rossi.length === 1 && verdi.length === 0;
    console.log(ok
      ? "[ref-callbacks] self-test OK: prende la forma del crash, lascia stare quella sana."
      : `[ref-callbacks] self-test FALLITO: difetto=${rossi.length} (atteso 1), sano=${verdi.length} (atteso 0)`);
    process.exit(ok ? 0 : 1);
  }

  const hits: Hit[] = [];
  let scanned = 0;
  for (const f of tracked()) {
    scanned++;
    hits.push(...findInlineRefSetters(readFileSync(resolve(ROOT, f), "utf8"), f));
  }
  if (hits.length === 0) {
    console.log(`[ref-callbacks] OK — ${scanned} file, nessuna callback ref inline che tocca lo stato.`);
    process.exit(0);
  }
  console.error(`[ref-callbacks] FAIL — ${hits.length} callback ref inline che chiamano un setter di stato:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.attr}={(…) => … ${h.text.slice(0, 80)}`);
  console.error(
    "\nUna freccia inline e' una funzione NUOVA a ogni render, e React tratta il cambio\n" +
      "di identita' di una callback ref come uno scollegamento: chiama la vecchia con null\n" +
      "e la nuova con l'elemento. Con un setState dentro, sono due render in piu' per ogni\n" +
      "render — il ciclo che ha prodotto React #185 e la pane rotta il 2026-08-16.\n" +
      "Rimedio: `useCallback` con le dipendenze giuste (vedi MessageList.tsx:203).",
  );
  process.exit(1);
}
