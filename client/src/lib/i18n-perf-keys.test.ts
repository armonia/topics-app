/**
 * LE STRINGHE CHE IL PANNELLO MOSTRA ESISTONO DAVVERO, IN ENTRAMBE LE LINGUE.
 *
 * PERCHÉ ESISTE, e perché non bastavano gli altri due controlli. `verdict.ts`
 * decide QUALE riga mostrare e `verdict.test.ts` lo prova; l'E2E
 * (`tests/e2e/perf-panel.spec.ts`) prova che il pannello si apre. In mezzo
 * resta un modo di rompere tutto che nessuno dei due vede: una chiave che il
 * dizionario non ha. `t()` allora restituisce la chiave stessa, e a schermo
 * compare `perf.verdict.mostlySwapped` al posto di una frase — con ogni test
 * verde.
 *
 * Non è teorico: è successo durante il lavoro che ha aggiunto quella riga. Una
 * lettura fatta subito dopo l'avvio dava il testo ITALIANO anche per l'inglese,
 * perché il catalogo inglese si carica su richiesta e non era ancora arrivato.
 * La conclusione sbagliata a portata di mano era «la traduzione manca»; la
 * risposta vera l'ha data `missingKeys('en')`, che ASPETTA il catalogo — ed è
 * la funzione che questo file usa, invece di leggere i dizionari a mano.
 */
import { describe, it, expect } from 'bun:test';
import { t, missingKeys } from './i18n';

/**
 * Le chiavi che il pannello prestazioni può mostrare, con dei valori di
 * esempio per i loro segnaposti. Elencate a mano di proposito: un test che le
 * ricavasse dal sorgente proverebbe che il codice è coerente con sé stesso, non
 * che dice qualcosa a una persona.
 */
const RIGHE_DEL_PANNELLO: Array<[string, Record<string, string | number>]> = [
  ['perf.verdict.noAccel', {}],
  ['perf.verdict.compressed', { gb: '2.5' }],
  ['perf.verdict.mostlySwapped', { pct: 78, mb: 234 }],
  ['perf.verdict.loaded', {}],
];

describe('le stringhe del pannello prestazioni', () => {
  it('esistono tutte in inglese: nessuna cade sul ripiego italiano', async () => {
    // `missingKeys` aspetta che il catalogo su richiesta sia arrivato — senza
    // quell'attesa risponderebbe «mancano tutte», che è vero e inutile.
    const mancanti = await missingKeys('en');
    const nostre = mancanti.filter((k) => k.startsWith('perf.'));
    expect(nostre).toEqual([]);
  });

  it('nessuna esce come CHIAVE GREZZA, che è ciò che si vedrebbe a schermo', () => {
    for (const [chiave, vars] of RIGHE_DEL_PANNELLO) {
      const reso = t(chiave, 'it', vars);
      // `t()` restituisce la chiave quando non la trova: è esattamente il
      // difetto, ed è invisibile a un test che guardi solo la decisione.
      expect(reso).not.toBe(chiave);
      expect(reso.length).toBeGreaterThan(0);
    }
  });

  it('nessuna lascia un segnaposto non sostituito', () => {
    // `{mb}` a schermo è peggio di una traduzione mancante: sembra un difetto
    // dei dati, non delle stringhe, e manda a cercare dalla parte sbagliata.
    for (const [chiave, vars] of RIGHE_DEL_PANNELLO) {
      for (const lingua of ['it', 'en'] as const) {
        expect(t(chiave, lingua, vars)).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  it('la riga nuova nomina ENTRAMBI i numeri che la rendono utile', () => {
    // Dire «il 78%» senza dire di che, o «234 MB» senza la proporzione, non
    // risponde alla domanda che l'ha fatta nascere: quanto di questo numero è
    // memoria vera. I due valori devono comparire tutti e due.
    const reso = t('perf.verdict.mostlySwapped', 'it', { pct: 78, mb: 234 });
    expect(reso).toContain('78');
    expect(reso).toContain('234');
  });

  it('la riga nuova NON consiglia di chiudere niente, al contrario dell\'altra', () => {
    // È la distinzione che giustifica l'esistenza di due righe invece di una:
    // sotto pressione vera «chiudi qualche pannello» aiuta; quando la memoria
    // è già stata restituita, lo stesso consiglio manda a fare una cosa inutile.
    const informativa = t('perf.verdict.mostlySwapped', 'it', { pct: 78, mb: 234 }).toLowerCase();
    expect(informativa).not.toContain('chiudi');
    expect(t('perf.verdict.compressed', 'it', { gb: '2.5' }).toLowerCase()).toContain('chiudi');
  });
});
