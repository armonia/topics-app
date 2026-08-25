/**
 * @covers PRESENCE-13
 *
 * DUE SUPERFICI, UN NUMERO — il banco che mancava.
 *
 * Il difetto (task bbf68c9c): la presenza Discord diceva «16 sessioni aperte»
 * contando righe di `topics WHERE archived = 0`, che sono CONTENITORI; la barra
 * di stato mostrava le sessioni della flotta, che sono PROCESSI con un pid. E le
 * sessioni Claude che Topics non ha avviato non comparivano in nessuna delle
 * due. Nessuno dei due numeri era sbagliato per conto suo, ed e' esattamente per
 * questo che nessun test poteva prenderlo: ognuno era coerente con se' stesso.
 *
 * La cura su main non e' un terzo contatore, e' una fonte SOLA
 * (`computePresenceCounts`) letta da entrambe. Il che rende la garanzia
 * STRUTTURALE, e questo file la pianta: non «i due numeri sono uguali oggi» —
 * quello si prova solo accendendo Discord — ma «i due non possono divergere,
 * perche' chiamano la stessa funzione con gli stessi ingressi».
 *
 * Il caso che lo rende non vacuo e' l'ultimo: cerca il pattern DIVERGENTE, cioe'
 * qualcuno che riconti i topic aperti per conto suo fuori dalla fonte. E' il
 * modo in cui il difetto tornerebbe, e senza quel caso questo file
 * sopravviverebbe alla sua stessa regressione.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = readFileSync(join(ROOT, "server.ts"), "utf8");
const STATUS = readFileSync(join(ROOT, "server/routes/status.ts"), "utf8");

/** Gli argomenti della chiamata, normalizzati: e' il confronto che conta. */
function argomenti(src: string): string | null {
  const i = src.indexOf("computePresenceCounts(");
  if (i < 0) return null;
  let livello = 0;
  for (let j = i + "computePresenceCounts".length; j < src.length; j++) {
    if (src[j] === "(") livello++;
    else if (src[j] === ")") {
      livello--;
      if (livello === 0) {
        return src
          .slice(i + "computePresenceCounts(".length, j)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\s+/g, "")
          // `status.ts:57` destruttura `{ db, activeStreams } = ctx`, `server.ts`
          // scrive `ctx.db`: e' lo STESSO oggetto, e un confronto che va rosso
          // su quel prefisso segnalerebbe una cosmesi invece di una divergenza.
          .replace(/\bctx\./g, "")
          .replace(/,$/, "");
      }
    }
  }
  return null;
}

describe("presence · due superfici, un numero", () => {
  test("la barra di stato legge computePresenceCounts", () => {
    expect(argomenti(STATUS), "la barra ha smesso di leggere la fonte comune").not.toBeNull();
  });

  test("la presenza Discord legge la STESSA funzione", () => {
    expect(argomenti(SERVER), "la presenza Discord ha smesso di leggere la fonte comune").not.toBeNull();
  });

  test("IL PATTO: le due superfici passano gli STESSI ingressi", () => {
    expect(argomenti(SERVER)).toBe(argomenti(STATUS)!);
  });

  test("il pattern DIVERGENTE non e' tornato: nessuno riconta i topic aperti fuori dalla fonte", () => {
    // `archived = 0` su `topics` era il conteggio della presenza Discord, ed e'
    // la forma esatta in cui il difetto si ripresenterebbe. Vive UNA volta, in
    // `profile-stats.ts`, che E' la fonte.
    const colpevoli: string[] = [];
    const visita = (dir: string) => {
      for (const voce of readdirSync(dir)) {
        if (voce === "node_modules" || voce.startsWith(".")) continue;
        const p = join(dir, voce);
        if (statSync(p).isDirectory()) { visita(p); continue; }
        if (!p.endsWith(".ts") || p.includes(".test.")) continue;
        const src = readFileSync(p, "utf8");
        // CONTA, non «legge». La prima versione cercava qualunque
        // `FROM topics ... archived = 0` e pescava
        // `ui-state-orphan-cleanup.ts`, che seleziona degli id per fare
        // pulizia: quello non e' un secondo contatore, e un cancello che lo
        // chiama tale insegna a ignorarlo.
        if (/COUNT\([\s\S]{0,40}?FROM\s+topics\b[\s\S]{0,120}?archived\s*=\s*0/i.test(src)) {
          colpevoli.push(p.slice(ROOT.length + 1));
        }
      }
    };
    visita(join(ROOT, "server"));
    expect(
      colpevoli,
      "un secondo conteggio dei topic aperti: e' la forma in cui le due superfici tornano a divergere",
    ).toEqual(["server/services/profile-stats.ts"]);
  });
});
