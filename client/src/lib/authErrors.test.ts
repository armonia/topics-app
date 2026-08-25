/**
 * Ogni codice di rifiuto di `/api/auth/**` ha una frase VERA, nelle due lingue.
 *
 * Il difetto che questo file presidia non è ipotetico: prima di
 * `shared/auth-codes.ts` il server mandava prosa italiana nel campo `error` e
 * `ShareControl` la stampava tale e quale — «quel dispositivo vede già tutto: è
 * un tuo dispositivo, non un ospite» sotto un titolo che dice «Share this card
 * with a guest». Tolta la prosa, il rischio si sposta: un codice nuovo che
 * arriva senza traduzione. Qui diventa rosso invece che un pannello muto.
  * @covers AUTHERR-01
 */
import { describe, test, expect } from 'bun:test';
import { chiaveErroreAuth, CODICI_AUTH } from './authErrors';
import { t, missingKeys } from './i18n';

describe('dal codice di /api/auth/** alla frase', () => {
  test('ogni codice ha una frase in ENTRAMBE le lingue', async () => {
    // `missingKeys` e non `t()`: `t()` ripiega sull'ALTRA lingua prima che sulla
    // chiave nuda, quindi «la stringa inglese esiste» è una domanda a cui `t()`
    // non può rispondere di no finché quella italiana c'è. Un'asserzione che
    // non può fallire è peggio della sua assenza.
    const buchiIt = new Set(await missingKeys('it'));
    const buchiEn = new Set(await missingKeys('en'));
    for (const c of CODICI_AUTH) {
      const chiave = chiaveErroreAuth(c);
      expect(chiave).toBe(`auth.err.${c}`);
      expect(buchiIt.has(chiave), `manca in italiano: ${chiave}`).toBe(false);
      expect(buchiEn.has(chiave), `manca in inglese: ${chiave}`).toBe(false);
      // E la frase non è la chiave: una chiave inesistente in ENTRAMBE le
      // lingue passerebbe i due controlli qui sopra.
      expect(t(chiave, 'en')).not.toBe(chiave);
    }
  });

  test('la frase INGLESE non è la stessa dell’italiana', () => {
    // Il controllo che rende il precedente capace di fallire davvero: copiare
    // la riga italiana dentro il dizionario inglese soddisfa `missingKeys` e
    // lascia l'italiano in mezzo a un pannello inglese, che è esattamente il
    // difetto di partenza.
    for (const c of CODICI_AUTH) {
      const chiave = `auth.err.${c}`;
      expect(t(chiave, 'en'), `non tradotto: ${chiave}`).not.toBe(t(chiave, 'it'));
    }
  });

  test('un codice che questa interfaccia non conosce non lascia il pannello muto', () => {
    expect(chiaveErroreAuth('un_codice_di_domani')).toBe('auth.err.generic');
    expect(chiaveErroreAuth(null)).toBe('auth.err.generic');
    expect(chiaveErroreAuth(undefined)).toBe('auth.err.generic');
    expect(chiaveErroreAuth('')).toBe('auth.err.generic');
    expect(t('auth.err.generic', 'en')).not.toBe('auth.err.generic');
  });
});
