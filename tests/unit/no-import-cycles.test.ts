/**
 * @covers GATE-08
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";

/**
 * Nessun ciclo di import fra moduli, tranne quello che è stato deciso.
 *
 * PERCHÉ CONTA, visto che oggi «funziona». In ESM un ciclo non è un errore: si
 * risolve se ogni lato usa l'altro solo A CHIAMATA AVVENUTA, quando tutti i
 * moduli sono già stati inizializzati. È una proprietà del codice di adesso,
 * non del disegno. Basta che uno dei due legga un binding dell'altro a livello
 * di modulo — una `const`, un `new`, un registro popolato all'import — perché
 * la stessa catena diventi un `Cannot access '…' before initialization`
 * all'avvio, oppure, peggio, un `undefined` silenzioso: il valore c'è, arriva
 * tardi, e nessuno lancia.
 *
 * Ne sono stati sciolti due, entrambi trovati non a occhio ma costruendo il
 * grafo:
 *  · `file-watcher → git-watcher → routes/files → file-watcher`: il watcher
 *    importava una ROUTE per invalidarle la cache. La cache è finita in
 *    `server/lib/git-status-cache.ts`, che è la cosa davvero condivisa;
 *  · `syncCrossTab → persistLocal → syncCrossTab`: la chiave di localStorage.
 *    Era una `const` — cioè esattamente il caso pericoloso — ed è finita in
 *    `state/pane/middleware/storageKeys.ts`.
 *
 * COSA GUARDA E COSA NO. Solo gli import di VALORE fra file del repo: gli
 * `import type` spariscono alla compilazione e un ciclo di tipi non esiste a
 * runtime, e gli `import()` dinamici sono asincroni, quindi per definizione
 * fuori dall'inizializzazione. I file di test restano fuori: non sono nel grafo
 * del prodotto.
 *
 * DEROGHE È VUOTO, e va tenuto così. L'unica che c'è stata —
 * `MessageContent.tsx ↔ Chat/PlanView.tsx`, i due lati si scambiavano
 * `markdownComponents` — è sparita insieme a `PlanView`, la vista che approvava
 * i piani a fiuto sulla prosa (vedi `Chat/planDetection.ts`): tolta quella, il
 * ciclo non c'era più da sciogliere. L'elenco resta perché una deroga scritta
 * si può discutere; una taciuta diventa la regola.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const SCOPES = ["server", "client/src", "shared", "relay"];

/** Cicli ammessi, come insieme di file (l'ordine di partenza non conta). */
const DEROGHE: ReadonlyArray<readonly string[]> = [];

function sorgenti(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sorgenti(p, out);
    else if (/\.tsx?$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** `import …/export … from './x'` — il gruppo 1 è lo specificatore relativo. */
const DA = /(?:^|\n)[ \t]*(?:import|export)[ \t][\s\S]*?[ \t]from[ \t]*["'](\.[^"']+)["']/g;
/** `import type …` / `export type …`: cancellati alla compilazione. */
const SOLO_TIPI = /(?:^|\n)[ \t]*(?:import|export)[ \t]+type[ \t]/;

function risolvi(da: string, spec: string): string | null {
  const base = resolve(dirname(da), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function trovaCicli(files: string[]): string[][] {
  const grafo = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const archi = new Set<string>();
    for (const m of src.matchAll(DA)) {
      if (SOLO_TIPI.test(m[0]!)) continue;
      const t = risolvi(f, m[1]!);
      if (t && t !== f) archi.add(t);
    }
    grafo.set(f, [...archi]);
  }

  const cicli: string[][] = [];
  const stato = new Map<string, 0 | 1 | 2>();
  const pila: string[] = [];
  const visita = (n: string) => {
    stato.set(n, 1);
    pila.push(n);
    for (const m of grafo.get(n) ?? []) {
      if (!grafo.has(m)) continue; // fuori scopo (node_modules, test)
      const s = stato.get(m) ?? 0;
      if (s === 1) cicli.push(pila.slice(pila.indexOf(m)));
      else if (s === 0) visita(m);
    }
    pila.pop();
    stato.set(n, 2);
  };
  for (const f of files) if ((stato.get(f) ?? 0) === 0) visita(f);
  return cicli;
}

const chiave = (c: readonly string[]) => [...new Set(c)].sort().join(" + ");

describe("il grafo degli import non ha cicli oltre a quelli dichiarati", () => {
  const files = SCOPES.flatMap((s) => sorgenti(resolve(ROOT, s)));
  const rel = (p: string) => p.slice(ROOT.length + 1);
  const trovati = trovaCicli(files).map((c) => c.map(rel));

  test("il grafo è stato costruito davvero (guardia contro un verde a vuoto)", () => {
    // Senza questa, uno scope rinominato renderebbe `files` vuoto e il test
    // qui sotto passerebbe misurando zero file — il modo più comune in cui un
    // cancello smette di mordere senza diventare rosso.
    expect(files.length).toBeGreaterThan(400);
  });

  test("ogni ciclo trovato è fra quelli ammessi", () => {
    const ammessi = new Set(DEROGHE.map(chiave));
    const nuovi = trovati.filter((c) => !ammessi.has(chiave(c)));
    expect(
      nuovi.map((c) => c.join(" -> ")),
      "cicli di import NON dichiarati. Scioglili spostando la cosa condivisa in un modulo che entrambi importano — oppure, se il ciclo è benigno e voluto, aggiungilo a DEROGHE con scritto il perché.",
    ).toEqual([]);
  });

  test("ogni deroga dichiarata esiste ancora (niente eccezioni fossili)", () => {
    // Una deroga che non corrisponde più a un ciclo vero è un permesso che
    // sopravvive alla ragione per cui era stato dato: va tolta, non lasciata lì
    // ad autorizzare qualcosa che nessuno ha più chiesto.
    const trovatiK = new Set(trovati.map(chiave));
    for (const d of DEROGHE) {
      expect(trovatiK.has(chiave(d)), `la deroga "${chiave(d)}" non corrisponde più a nessun ciclo: toglila da DEROGHE`).toBe(true);
    }
  });
});
