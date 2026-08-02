/**
 * Un solo algoritmo per stampare un conteggio di token.
 *
 * Ce n'erano CINQUE copie, e non erano d'accordo: tre regole di arrotondamento
 * (intero, un decimale, un decimale solo sotto i 10k) e due suffissi (`k` e
 * `K`). Le differenze di aspetto sono deliberate — superfici diverse, densità
 * diverse, e quattro asserzioni E2E le fissano — quindi restano, ma diventano
 * un PARAMETRO invece di cinque implementazioni indipendenti.
 *
 * Quello che non era deliberato è il confine con i milioni. Chi arrotonda a
 * intero stampava `1000K` per 999.600 token, perché il ramo dei milioni
 * scattava a 1.000.000 esatti mentre l'arrotondamento portava già a 1000. Il
 * confine giusto dipende da quanti decimali si stampano — ed è esattamente il
 * genere di dettaglio che, replicato a mano, viene azzeccato in un posto solo
 * (era `useRealContext`) e sbagliato negli altri quattro. Qui si calcola.
 */

export interface FormatTokensOptions {
  /** Cifre decimali sotto il milione. `undefined` = arrotonda a intero. */
  decimals?: number;
  /** Suffisso delle migliaia: `k` (default) o `K`. */
  suffix?: 'k' | 'K';
  /** Decimali sopra il milione (default 1; 0 sopra i ~10M per non dire «10.0M»). */
  millionDecimals?: number;
}

export function formatTokens(n: number, opts: FormatTokensOptions = {}): string {
  const { decimals, suffix = 'k' } = opts;
  if (!Number.isFinite(n)) return String(n);

  // Il confine: si passa ai milioni quando il valore stampato in migliaia
  // arriverebbe a "1000". Con 0 decimali succede già a 999.500 (arrotondamento
  // per eccesso), con 1 decimale a 999.950. Da qui il calcolo invece di una
  // costante copiata.
  const step = decimals === undefined ? 500 : 0.5 * 10 ** (3 - decimals);
  const millionAt = 1_000_000 - step;

  if (n >= millionAt) {
    const md = opts.millionDecimals ?? (n >= 9_950_000 ? 0 : 1);
    return `${(n / 1_000_000).toFixed(md)}M`;
  }
  if (n >= 1_000) {
    const k = decimals === undefined ? String(Math.round(n / 1000)) : (n / 1000).toFixed(decimals);
    return `${k}${suffix}`;
  }
  return String(decimals === undefined ? n : Math.round(n));
}
