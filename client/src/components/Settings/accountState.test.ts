/**
 * @covers APPSET-06
 */
import { describe, test, expect } from 'bun:test';
import { mostraSezione, chiaveErrore, CODICI_ACCOUNT, type StatoAccount } from './accountState';
import { t, missingKeys } from '../../lib/i18n';

function stato(p: Partial<StatoAccount> = {}): StatoAccount {
  return {
    configured: false, linked: false, accountId: null, email: null,
    personId: 'p1', personName: 'Attilio', linkedAt: null, ...p,
  };
}

describe('quando la sezione Account si mostra', () => {
  test('non si mostra su un’installazione senza servizio e senza collegamenti', () => {
    expect(mostraSezione(stato())).toBe(false);
  });

  test('si mostra appena c’è un servizio a cui chiedere', () => {
    expect(mostraSezione(stato({ configured: true }))).toBe(true);
  });

  test('SI MOSTRA anche col servizio sparito, se un account è collegato', () => {
    // È il caso ORG-08: perdere il contatto col servizio non deve far sparire
    // il collegamento né il bottone per staccarlo, che è un gesto locale.
    expect(mostraSezione(stato({ configured: false, linked: true, accountId: 'a1' }))).toBe(true);
  });

  test('finché non si sa, non si disegna niente', () => {
    expect(mostraSezione(null)).toBe(false);
  });
});

describe('dal codice del server alla frase', () => {
  test('ogni codice ha una frase VERA nel dizionario, in entrambe le lingue', async () => {
    // `missingKeys` e non `t()`: `t()` ripiega sull'ALTRA lingua prima che sulla
    // chiave nuda, quindi «la stringa inglese esiste» è una domanda a cui `t()`
    // non può rispondere di no finché quella italiana c'è — misurato togliendo
    // una chiave da EN e vedendo il test restare verde. Un'asserzione che non
    // può fallire è peggio della sua assenza.
    const buchiIt = new Set(await missingKeys('it'));
    const buchiEn = new Set(await missingKeys('en'));
    for (const c of CODICI_ACCOUNT) {
      const chiave = chiaveErrore(c);
      expect(chiave).toBe(`account.err.${c}`);
      expect(buchiIt.has(chiave)).toBe(false);
      expect(buchiEn.has(chiave)).toBe(false);
      // E la frase non è la chiave: una chiave inesistente in ENTRAMBE le
      // lingue passerebbe i due controlli qui sopra.
      expect(t(chiave, 'en')).not.toBe(chiave);
    }
  });

  test('un codice che questa interfaccia non conosce non lascia il pannello muto', () => {
    expect(chiaveErrore('un_codice_di_domani')).toBe('account.err.generic');
    expect(chiaveErrore(null)).toBe('account.err.generic');
    expect(chiaveErrore(undefined)).toBe('account.err.generic');
    expect(t('account.err.generic', 'en')).not.toBe('account.err.generic');
  });
});
