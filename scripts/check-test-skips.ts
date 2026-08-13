#!/usr/bin/env bun
/**
 * scripts/check-test-skips.ts — un test che si salta da solo deve dire perché,
 * e non devono aumentare.
 *
 * ── Perché ──────────────────────────────────────────────────────────────────
 * `grid-split.spec.ts` chiudeva con «24 passed, 3 skipped». Nessuno legge quel
 * numero: tre criteri di accettazione erano fermi da mesi — uno saltava perché
 * la navigazione della sidebar non trovava più il progetto, un altro chiamava
 * "no-op" una divisione che non atterrava, il terzo era un `test.fixme()` col
 * corpo vuoto che si annotava da sé la copertura. Un test verde-vuoto è peggio
 * di un test assente: l'assenza si vede, il verde no.
 *
 * Questo check non vieta gli skip — alcuni sono onesti (un gateway che non c'è,
 * una CLI non installata, un bug di prodotto tracciato). Vieta i due modi in cui
 * smettono di essere onesti:
 *
 *   1. **Skip muto** — `test.skip()` / `test.fixme()` senza messaggio. Chi legge
 *      il report non può sapere se è l'ambiente o una regressione, quindi non
 *      guarda. Il messaggio è ciò che rende lo skip rivedibile.
 *
 *   2. **Crescita silenziosa** — il totale non può salire sopra BASELINE. Un
 *      cricchetto, come `typecheck-server.ts`: aggiungerne uno è una decisione,
 *      non un effetto collaterale. Se lo togli, ABBASSA la soglia.
 *
 * NON è coperto — e non può esserlo staticamente — lo skip la cui condizione è
 * sempre vera nell'ambiente reale. Per quello serve leggere il conteggio
 * "skipped" di una run: se un file ne ha di stabili, il posto giusto per dirlo
 * è il messaggio dello skip stesso.
 *
 * Run: `bun run scripts/check-test-skips.ts`
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from "fs";
import { join, resolve, relative } from "path";

const ROOT = "tests";
const SPEC_EXT = /\.(spec|test)\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "test-results"]);

/**
 * Il numero di skip/fixme al 07/08/2026: 14 dopo GRID-05, GRID-10 e lo stub del
 * DnD tolto (05/08), meno l'accordion di progetto in `sidebar.spec.ts` —
 * riattivato quando si è misurato che il vuoto non era un bug ma il contratto
 * guidato dalle tab, ed era il SEME del test a non sopravvivere al primo render.
 * Non alzarlo per far passare la CI: o il test si ripara, o lo skip merita una
 * discussione.
 *
 * ── 13 → 18 (13/08/2026, prima del push pubblico) ───────────────────────────
 * Cinque skip arrivati da lavoro già atterrato. Guardati UNO A UNO prima di
 * alzare la soglia — alzarla in blocco è il guasto che questo cancello esiste
 * per impedire. Tutti e cinque dipendono da un ambiente assente, nessuno è un
 * test rotto messo a tacere:
 *
 *  1-2. `board-card-stop.spec.ts:200,205` — NON sono due test spenti: sono il
 *       modo in cui una coppia si smista fra due progetti. La spec gira in
 *       `chromium` E in `chromium-touch-wide` (`playwright.config.ts:247-253`),
 *       e i due test si escludono a vicenda su `isMobile`. Verificato con
 *       `--list`: 4 istanze, e ogni AC ne ha esattamente UNA che esegue —
 *       il tasto destro col mouse, il long-press col dito. Copertura piena,
 *       mai zero.
 *
 *  3.   `board-task-id-chip.spec.ts:255` — non è un AC: il corpo scatta la
 *       foto della riga per la consegna. Gli AC del chip sono IDCHIP-01..03,
 *       che girano sempre. Si accende a richiesta con `CHIP_SHOT=1`.
 *
 *  4-5. `dictation-real-mic.spec.ts:150,208` — servono un motore STT vero
 *       (un modello whisper locale o una chiave ElevenLabs), come dice
 *       l'intestazione della spec alle righe 29-30. La condizione non è
 *       `true`: è una sonda viva su `/api/stt/capabilities`, e il messaggio
 *       del primo ELENCA ogni provider col suo perché. Senza motore la app
 *       nasconde il tasto dettatura, quindi girare qui proverebbe il
 *       contrario di ciò che il test afferma.
 */
const BASELINE = 18;

/** `test.skip(` e `test.fixme(` — non `test.describe.skip`, che disattiva un blocco intero. */
const SKIP_CALL = /\btest\.(skip|fixme)\s*\(/g;

interface Hit {
  file: string;
  line: number;
  kind: string;
  text: string;
  mute: boolean;
}

/** Il codice di una riga, senza il commento di fine riga. */
function codeOf(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.split("//")[0];
}

/** Quante righe al massimo si segue una chiamata aperta, per non correre via su un file rotto. */
const MAX_CALL_LINES = 12;

/**
 * Gli argomenti della chiamata, dal `(` alla parentesi che lo chiude. Conta le
 * parentesi invece di fermarsi alla prima: `test.skip(!(await ready()), MSG)`
 * ne contiene altre, e troncare lì direbbe "muto" a uno skip che ha il messaggio.
 *
 * E prosegue sulle RIGHE SUCCESSIVE finché le parentesi non si chiudono. Prima
 * si fermava a fine riga e giudicava la chiamata «sul primo pezzo»: ma il primo
 * pezzo di una chiamata mandata a capo è la sola `test.skip(`, cioè zero
 * argomenti, cioè "muto" — cosa che si dava proprio agli skip col messaggio
 * PIÙ lungo, gli unici che prettier manda a capo. Il caso vero era
 * `dictation-real-mic.spec.ts:150`, cinque righe di messaggio con l'elenco dei
 * provider e il perché di ognuno, accusato di non averne.
 *
 * `null` = la chiamata NON si chiude entro la finestra, quindi non si sa
 * giudicare. Restituire il troncone sarebbe peggio che inutile: quelle righe
 * sono codice di CONTORNO, e le virgolette che ci stanno dentro non sono il
 * messaggio dello skip — un `test.skip(` muto seguito da una qualsiasi riga
 * con una stringa risulterebbe "ha il messaggio". Si fallisce CHIUSI: chi
 * legge `null` lo tratta come muto. La versione a riga singola qui era più
 * severa (il resto della riga dopo `test.skip(` è vuoto, quindi muto), e un
 * parser più bravo non deve perdere un caso che quello ingenuo prendeva.
 */
function callArgs(codes: string[], startLine: number, openIdx: number): string | null {
  let depth = 0;
  let out = "";
  const last = Math.min(codes.length, startLine + MAX_CALL_LINES);
  for (let ln = startLine; ln < last; ln++) {
    const code = codes[ln];
    for (let i = ln === startLine ? openIdx : 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(") {
        depth++;
        if (depth === 1) continue; // la parentesi che apre non è un argomento
      } else if (ch === ")") {
        depth--;
        if (depth === 0) return out;
      }
      out += ch;
    }
    out += "\n";
  }
  return null;
}

/**
 * Muto = niente messaggio per chi legge il report. Un letterale di stringa o
 * una costante MAIUSCOLA (`NO_CLAUDE`) contano come messaggio; una sola
 * condizione booleana no.
 *
 * `null` (chiamata che non si chiude entro la finestra) = muto: se il parser
 * non è riuscito a leggere gli argomenti, non può dire che c'era un messaggio.
 */
function isMute(args: string | null): boolean {
  if (args === null) return true;
  const a = args.trim();
  if (a === "") return true;
  if (/["'`]/.test(a)) return false;
  return !/\b[A-Z][A-Z0-9_]{2,}\b/.test(a);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    // `lstat`, non `stat`: sotto tests/e2e/data vive un symlink al bundle
    // congelato della run, che fra una run e l'altra punta nel vuoto. `stat` lo
    // segue e lancia ENOENT; qui i link non si seguono comunque — le spec sono
    // file veri.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out);
    else if (SPEC_EXT.test(name)) out.push(full);
  }
}

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  // Il codice di TUTTE le righe in anticipo: `callArgs` deve poter proseguire
  // oltre la riga che apre la chiamata.
  const codes = lines.map(codeOf);
  codes.forEach((code, idx) => {
    const line = lines[idx];
    SKIP_CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SKIP_CALL.exec(code)) !== null) {
      const open = code.indexOf("(", m.index);
      hits.push({
        file: relative(process.cwd(), file),
        line: idx + 1,
        kind: m[1],
        text: line.trim(),
        mute: isMute(callArgs(codes, idx, open)),
      });
    }
  });
  return hits;
}

function main(): void {
  const root = resolve(ROOT);
  if (!existsSync(root)) {
    console.error(`[check-test-skips] ${ROOT}/ non esiste`);
    process.exit(1);
  }
  const files: string[] = [];
  walk(root, files);

  const hits = files.flatMap(scan);
  const mute = hits.filter((h) => h.mute);
  let failed = false;

  if (mute.length > 0) {
    failed = true;
    console.error(`[check-test-skips] FAIL — ${mute.length} skip senza messaggio:`);
    for (const h of mute) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    console.error(
      `\nScrivi COSA manca perché il test non possa girare ` +
        `(\`test.skip(cond, "il gateway non risponde")\`).\n` +
        `Senza messaggio, chi legge "skipped" nel report non sa se è l'ambiente o una regressione.`,
    );
  }

  console.log(`\n[check-test-skips] skip/fixme totali: ${hits.length} (baseline ${BASELINE})`);
  if (hits.length > BASELINE) {
    failed = true;
    console.error(
      `\n✗ Gli skip sono saliti ${BASELINE} → ${hits.length}. Ripara il test, ` +
        `oppure alza BASELINE spiegando nel commit perché quello nuovo è onesto.`,
    );
  } else if (hits.length < BASELINE) {
    console.log(
      `✓ ${BASELINE - hits.length} sotto la soglia. Abbassa BASELINE in ` +
        `scripts/check-test-skips.ts a ${hits.length} per bloccare il guadagno.`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
