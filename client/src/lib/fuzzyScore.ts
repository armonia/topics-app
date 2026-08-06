/**
 * fuzzyScore — UN matcher per i path, e con un punteggio.
 *
 * Ce n'erano due, con lo stesso nome, nello stesso client:
 *   - `CommandPalette.fuzzyMatch` → booleano puro, nessun punteggio. I risultati
 *     uscivano nell'ordine di camminata del filesystem e venivano tagliati a 20.
 *     Misurato: cercando `store.ts` gli 11 file veri esistono nella lista e
 *     NESSUNO entra nelle 20 righe mostrate; `sever` (un refuso) restituiva 732
 *     file che quella stringa non ce l'hanno.
 *   - `FileMentionMenu.fuzzyMatch` → questo, con un punteggio sensato, usato per
 *     ordinare. Funzionava, e nessun altro lo sapeva.
 *
 * Questa è la seconda versione, estratta. Un ordinamento senza punteggio non è
 * un ordinamento «semplice»: è la ragione per cui una ricerca sembra rotta pur
 * avendo trovato la cosa giusta.
 *
 * La regola: tutti i caratteri della query compaiono in ORDINE nel bersaglio
 * (sottosequenza), e il punteggio premia
 *   - i caratteri CONSECUTIVI (+4): `store` in `store.ts` deve battere s…t…o…r…e
 *     sparpagliati per mezzo path;
 *   - l'INIZIO di una sequenza su un confine di parola (+3): dopo `/`, `.`,
 *     `-`, `_`, spazio, o a inizio stringa — è ciò che fa vincere il NOME del
 *     file sul path che lo contiene.
 *
 * Due tarature qui sono state CORRETTE rispetto alla versione ereditata, e il
 * test le tiene ferme:
 *   1. il bonus di confine valeva +3 CONTRO +2 dei consecutivi, e si sommava a
 *      OGNI carattere. Risultato: `s-t-o-r-e.ts` (22) batteva `store.ts` (18),
 *      perché ogni trattino regalava un confine. Cioè l'esatto contrario di
 *      quello che un matcher di path deve fare;
 *   2. il confine ora premia solo il carattere che APRE una sequenza. Un bonus
 *      «hai cominciato in un punto sensato» non ha senso ripetuto in mezzo a
 *      una parola.
 */

export interface FuzzyResult {
  match: boolean;
  score: number;
}

const BOUNDARY = new Set(['/', '.', '-', '_', ' ']);

export function fuzzyScore(query: string, target: string): FuzzyResult {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return { match: true, score: 0 };

  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const consecutivo = lastMatchIdx === ti - 1;
    if (consecutivo) score += 4;
    // Solo chi APRE una sequenza può prendere il bonus di confine: dentro una
    // parola non c'è nessun confine da premiare, e sommarlo a ogni carattere
    // faceva vincere i path pieni di trattini.
    else if (ti === 0 || BOUNDARY.has(t[ti - 1])) score += 3;
    score += 1;
    lastMatchIdx = ti;
    qi++;
  }

  return { match: qi === q.length, score };
}

/**
 * Ordina i path per pertinenza alla query e tiene i primi `limit`.
 *
 * Il taglio va DOPO l'ordinamento — è tutto il punto. Tagliare prima (com'era)
 * significa mostrare i primi venti che il filesystem ha incontrato, che non
 * hanno alcuna ragione di essere i venti migliori.
 *
 * A parità di punteggio vince il path più CORTO: fra `src/store.ts` e
 * `src/components/x/store.ts` il primo è quasi sempre quello cercato.
 */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  const q = query.trim();
  if (!q) return paths.slice(0, limit);
  const scored: Array<{ p: string; score: number }> = [];
  for (const p of paths) {
    // Il NOME del file conta più del path: un match su `store.ts` deve battere
    // un match sparso su `src/…/…/…`. Si prende il migliore dei due.
    const slash = p.lastIndexOf('/');
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    const onBase = fuzzyScore(q, base);
    const onPath = fuzzyScore(q, p);
    if (!onBase.match && !onPath.match) continue;
    // +10 al match sul nome: senza, un path lungo accumula punti di confine e
    // scavalca il file che si chiama esattamente come la query.
    const score = Math.max(onBase.match ? onBase.score + 10 : 0, onPath.match ? onPath.score : 0);
    scored.push({ p, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.p.length - b.p.length) || a.p.localeCompare(b.p));
  return scored.slice(0, limit).map((s) => s.p);
}
