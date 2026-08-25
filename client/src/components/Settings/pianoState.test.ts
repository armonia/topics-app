/**
 * Il piano: cosa si mostra, e di chi è il problema.
 *
 * Vale un test perché è l'ultimo metro fra i sette motivi che il server
 * distingue e la frase che una persona legge — ed è il metro in cui la
 * distinzione si perde senza che niente diventi rosso.
  * @covers LICENSE-05
 */
import { describe, expect, it } from 'bun:test';
import {
  chiaveErroreCheckout, chiaveMotivo, colpaNostra, giorniAllaScadenza,
  mostraMotivo, POSTI_MAX_ACQUISTO, POSTI_MIN_ACQUISTO, postiValidi,
  scadenzaVicina, siPuoComprare, type MotivoLicenza,
} from './pianoState';
import { MOTIVI_LICENZA } from '../../../../shared/licenza-motivi';
import { t } from '../../lib/i18n';

/**
 * L'elenco viene dal modulo condiviso, non riscritto qui.
 *
 * Riscriverlo vorrebbe dire un test che continua a dire di sì il giorno in cui
 * il server distingue un ottavo motivo: girerebbe sui sette che conosce e non
 * si accorgerebbe dell'ottavo, che è precisamente il caso in cui a schermo
 * comparirebbe una chiave nuda.
 */
const TUTTI: readonly MotivoLicenza[] = MOTIVI_LICENZA;

describe('motivo · si tace sui due casi normali, si parla sugli altri cinque', () => {
  it('`valid` e `no_token` non mostrano niente', () => {
    // Se questi due parlassero, l'installazione di quasi tutti si aprirebbe con
    // un avviso — e un avviso che c'è sempre è un avviso che nessuno legge.
    expect(mostraMotivo('valid')).toBe(false);
    expect(mostraMotivo('no_token')).toBe(false);
  });

  it('gli altri cinque parlano, tutti', () => {
    const muti = TUTTI.filter((r) => !mostraMotivo(r));
    expect(muti.sort()).toEqual(['no_token', 'valid']);
  });

  it('ogni motivo ha una chiave sua: nessuno cade su quella di un altro', () => {
    // È la proprietà che conta: appiattire due motivi sulla stessa frase
    // rimetterebbe insieme proprio ciò che il server separa.
    const chiavi = TUTTI.map(chiaveMotivo);
    expect(new Set(chiavi).size).toBe(TUTTI.length);
  });
});

describe('motivo · di chi è il problema', () => {
  it('senza chiave di verifica la colpa è NOSTRA', () => {
    // Cambia cosa fa la persona dopo: smette di incollare gettoni, perché
    // nessuno potrà mai funzionare su questa build.
    expect(colpaNostra('no_verification_key')).toBe(true);
  });

  it('scaduto e per-un-altra-macchina non lo sono', () => {
    // Qui c'è qualcosa da fare: rinnovare, o chiedere il gettone giusto.
    expect(colpaNostra('expired')).toBe(false);
    expect(colpaNostra('other_installation')).toBe(false);
  });

  it('e non è vero per tutti: il predicato distingue davvero', () => {
    // Controllo positivo del criterio: senza, un `return true` passerebbe i due
    // casi qui sopra a metà e questo blocco non se ne accorgerebbe.
    expect(TUTTI.filter(colpaNostra)).toEqual(['no_verification_key']);
  });
});

describe('acquisto · il bottone si disegna solo se può funzionare', () => {
  it('serve Stripe configurato E un\'installazione', () => {
    expect(siPuoComprare({ configured: true, webhookConfigured: true, installationId: 'i1' })).toBe(true);
    expect(siPuoComprare({ configured: false, webhookConfigured: true, installationId: 'i1' })).toBe(false);
    expect(siPuoComprare({ configured: true, webhookConfigured: true, installationId: '' })).toBe(false);
    expect(siPuoComprare(null)).toBe(false);
  });

  it('il webhook NON entra nella decisione', () => {
    // Sono indipendenti per costruzione (`statoPubblico`): si può ricevere
    // eventi senza poter aprire un checkout, e viceversa. Legarli qui
    // spegnerebbe il bottone per una ragione che non lo riguarda.
    expect(siPuoComprare({ configured: true, webhookConfigured: false, installationId: 'i1' })).toBe(true);
  });
});

describe('scadenza · si arrotonda dalla parte che non illude', () => {
  const ORA = 1_700_000_000_000;

  it('non scade mai: nessun numero', () => {
    expect(giorniAllaScadenza(null, ORA)).toBeNull();
    expect(scadenzaVicina(null, ORA)).toBe(false);
  });

  it('ventitré ore sono ZERO giorni, non uno', () => {
    // Per DIFETTO: arrotondare per eccesso vorrebbe dire una persona che si
    // scopre scaduta il giorno in cui contava di non esserlo.
    expect(giorniAllaScadenza(ORA + 23 * 3_600_000, ORA)).toBe(0);
  });

  it('già scaduta dà un numero negativo, non zero', () => {
    // Zero direbbe «scade oggi», che è un'altra cosa.
    expect(giorniAllaScadenza(ORA - 86_400_000, ORA)).toBe(-1);
  });

  it('trenta giorni avvisa, trentuno no', () => {
    expect(scadenzaVicina(ORA + 30 * 86_400_000, ORA)).toBe(true);
    expect(scadenzaVicina(ORA + 31 * 86_400_000, ORA)).toBe(false);
  });
});

describe('posti · non si manda una richiesta già rifiutata', () => {
  it('uno non si vende: è il piano gratuito', () => {
    expect(postiValidi(1)).toBe(POSTI_MIN_ACQUISTO);
    expect(postiValidi(0)).toBe(POSTI_MIN_ACQUISTO);
    expect(postiValidi(-5)).toBe(POSTI_MIN_ACQUISTO);
  });

  it('sopra il tetto si taglia', () => {
    expect(postiValidi(10_000)).toBe(POSTI_MAX_ACQUISTO);
  });

  it('i numeri storti cadono sul minimo invece di viaggiare', () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(`${n}→${postiValidi(n)}`).toBe(`${n}→${POSTI_MIN_ACQUISTO}`);
    }
    expect(postiValidi(3.9)).toBe(3);
  });
});

describe('le frasi esistono davvero, in tutte e due le lingue', () => {
  // Le chiavi qui si COSTRUISCONO (`plan.reason.${motivo}`), quindi il
  // controllo che allinea le due lingue fra loro non basta: una chiave assente
  // da ENTRAMBE è allineata benissimo, e a schermo diventa
  // «plan.reason.expired» in mezzo alla pagina. Il giorno in cui il server
  // distingue un ottavo motivo, questo è ciò che lo dice.
  it('ogni motivo ha la sua frase, in italiano e in inglese', () => {
    for (const r of TUTTI) {
      const k = chiaveMotivo(r);
      for (const lingua of ['it', 'en'] as const) {
        expect(`${lingua}:${k}→${t(k, lingua)}`).not.toBe(`${lingua}:${k}→${k}`);
      }
    }
  });

  it('e ogni rifiuto del checkout pure, generico compreso', () => {
    const codici = ['not_configured', 'no_installation', 'bad_seats', 'upstream_error', 'unreachable', undefined];
    for (const c of codici) {
      const k = chiaveErroreCheckout(c);
      for (const lingua of ['it', 'en'] as const) {
        expect(`${lingua}:${k}→${t(k, lingua)}`).not.toBe(`${lingua}:${k}→${k}`);
      }
    }
  });

  it('e il controllo sa accorgersene: una chiave inventata torna se stessa', () => {
    // Controllo positivo del criterio. Senza, i due casi qui sopra passerebbero
    // anche se `t` avesse smesso di ripiegare sulla chiave nuda.
    expect(t('plan.reason.mai_esistito', 'it')).toBe('plan.reason.mai_esistito');
  });
});

describe('rifiuto del checkout · un codice nuovo non diventa silenzio', () => {
  it('i codici noti hanno la loro frase', () => {
    expect(chiaveErroreCheckout('not_configured')).toBe('plan.checkoutErr.not_configured');
    expect(chiaveErroreCheckout('unreachable')).toBe('plan.checkoutErr.unreachable');
  });

  it('uno sconosciuto, o assente, cade su quella generica', () => {
    expect(chiaveErroreCheckout('inventato_domani')).toBe('plan.checkoutErr.generic');
    expect(chiaveErroreCheckout(undefined)).toBe('plan.checkoutErr.generic');
  });
});
