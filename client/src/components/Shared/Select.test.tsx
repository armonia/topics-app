/**
 * Il cancello del `<select>` nudo.
 *
 * Il selettore della lingua era un `<select>` di sistema in mezzo a una UI
 * disegnata: su iOS apriva la ruota nativa, col suo carattere e i suoi margini.
 * Ne sono usciti otto insieme (`AppearanceSection`, `AIProvidersSection`,
 * `IdentitySection`, `TopicSettingsModal`, `NewTopicModal`, `TaskDetail` ×2,
 * `ToolInputForm`), tutti sostituiti da `Shared/Select.tsx`.
 *
 * PERCHÉ UN TEST E NON UNA REGOLA DI LINT: il difetto non è una cattiva pratica
 * generica, è che QUESTA app ha già un selettore suo e un secondo controllo
 * disegnato dal sistema operativo la fa sembrare due applicazioni. Un test dice
 * quel perché nel punto in cui fallisce; una regola di lint dice solo «vietato».
 *
 * Il conteggio è la barra dichiarata sul task: **zero**. Se domani un
 * `<select>` deve restare — un caso in cui la ruota nativa è la cosa giusta —
 * si aggiunge qui, con la riga che dice perché: l'eccezione è nominata, non
 * silenziosa.
 *
 * Niente DOM: jsdom/happy-dom non sono dipendenze del progetto (stessa scelta
 * di `Settings/IdentitySection.test.tsx`), quindi il presidio è sui SORGENTI.
 * `Select` usa hook, quindi non lo si può chiamare come funzione pura — il suo
 * comportamento in pagina è coperto dagli E2E.
  * @covers GESTURE-03
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');

/** I file in cui un `<select>` è tollerato, e la riga che dice perché. */
const ESENZIONI: Record<string, string> = {
  // Questo file: il cancello deve poter NOMINARE ciò che vieta.
  'components/Shared/Select.test.tsx': 'è il cancello stesso',
};

/**
 * Via i commenti e i pezzi di codice fra apici inversi.
 *
 * Serve perché la spiegazione di un difetto lo CITA — «qui c'era un `<select>`
 * di sistema» è esattamente la riga che si vuole poter scrivere accanto alla
 * correzione. Un cancello che vieta anche di parlarne costringe a raccontare i
 * fatti a mezze parole, e quella è la fine dei commenti utili.
 */
function soloCodice(testo: string): string {
  return testo
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // /* … */ e {/* … */}
    .replace(/^\s*\/\/.*$/gm, ' ')      // // …
    .replace(/`[^`]*`/g, '``');         // `codice fra apici inversi`
}

function sorgenti(dir: string, acc: string[] = []): string[] {
  for (const voce of readdirSync(dir)) {
    const p = join(dir, voce);
    if (statSync(p).isDirectory()) {
      sorgenti(p, acc);
    } else if (/\.(tsx?|css)$/.test(voce)) {
      acc.push(p);
    }
  }
  return acc;
}

describe('nessun <select> nativo nel client', () => {
  test('il conteggio dei tag `<select>` è zero (esenzioni dichiarate a parte)', () => {
    const colpevoli: string[] = [];
    for (const file of sorgenti(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ESENZIONI[rel]) continue;
      // Il TAG, non la parola: `<select` seguito da spazio, a-capo o `>`, in un
      // testo da cui commenti e apici inversi sono già spariti.
      const righe = soloCodice(readFileSync(file, 'utf8')).split('\n');
      righe.forEach((riga, i) => {
        if (/<select[\s>]/.test(riga)) colpevoli.push(`${rel}:${i + 1}: ${riga.trim().slice(0, 80)}`);
      });
    }
    expect(colpevoli).toEqual([]);
  });

  test('la primitiva che li sostituisce esiste ed è quella importata', () => {
    const primitiva = readFileSync(join(SRC, 'components/Shared/Select.tsx'), 'utf8');
    // Il valore della primitiva sta tutto nel fatto che passa da `Menu`: se un
    // giorno qualcuno la riscrivesse con un popover a mano perderebbe in un
    // colpo piazzamento, chiusura, tastiera e foglio dal basso su mobile.
    expect(primitiva).toContain("from './Menu'");
    expect(primitiva).toContain('role="listbox"');
    expect(primitiva).toContain('role="combobox"');
  });
});
