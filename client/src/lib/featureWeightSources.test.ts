/**
 * LE SORGENTI DELL'INVENTARIO GIRANO DAVVERO.
 *
 * IL GUASTO CHE PREVIENE, ed e' silenzioso per costruzione. Ogni sorgente e' una
 * closure che legge lo stato di uno store: se quello store cambia forma — un
 * export rinominato, un campo che diventa opzionale, un `undefined` dove prima
 * c'era una Map — la closure lancia. E il registro, di proposito, NON propaga:
 * cattura l'errore e marca la voce «non misurato», perche' un proprietario rotto
 * non deve azzerare la misura di tutti gli altri.
 *
 * Ottimo per l'utente, pessimo per chi mantiene: la riga sparisce dai numeri e
 * compare come «non misurato» in fondo a un elenco, dove somiglia a uno stato
 * legittimo. Nessun test fallisce, nessun log si accende. Questo file e' l'unico
 * posto che se ne accorge.
 *
 * PROVA ANCHE IL CONTRATTO, non solo l'assenza di eccezioni: una sorgente che
 * tornasse `{entries: NaN}` non lancerebbe, e NaN attraversa tutto l'inventario
 * fino a comparire a schermo.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { registerFeatureWeightSources } from './featureWeightSources';
import { collectFeatureWeights, _resetFeatureWeights } from './featureWeight';
import { NOMI_PER_TEST } from './featureWeightText';

let spegni: (() => void) | null = null;
afterEach(() => { spegni?.(); spegni = null; _resetFeatureWeights(); });

function raccogli() {
  _resetFeatureWeights();
  spegni = registerFeatureWeightSources();
  return collectFeatureWeights();
}

describe('registerFeatureWeightSources', () => {
  test('ogni sorgente registrata gira senza esplodere', () => {
    const voci = raccogli();
    const rotte = voci.filter(v => v.errore).map(v => `${v.id}: ${v.errore}`);
    expect(rotte).toEqual([]);
    // E ce ne sono: un registro vuoto passerebbe il controllo qui sopra senza
    // aver provato niente.
    expect(voci.length).toBeGreaterThanOrEqual(6);
  });

  test('i conteggi sono NUMERI FINITI: un NaN non lancia e arriva fino a schermo', () => {
    for (const v of raccogli()) {
      expect(Number.isFinite(v.peso.entries)).toBe(true);
      expect(v.peso.entries).toBeGreaterThanOrEqual(0);
      if (v.peso.items !== undefined) {
        expect(Number.isFinite(v.peso.items)).toBe(true);
        expect(v.peso.items).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('sono tutte TRATTENUTE: i MB veri non nascono da qui', () => {
    // Le voci misurate vengono dalla flotta e dalle webview (`featureUsage.ts`),
    // che sono processi reali. Una voce `misurato` registrata qui porterebbe
    // numeri che non vengono da nessuna lettura di sistema.
    for (const v of raccogli()) expect(v.natura).toBe('trattenuto');
  });

  test('nessuna voce trattenuta dichiara MB o processi', () => {
    // Il tipo lo permette (i campi sono opzionali su `PesoDichiarato`), quindi
    // il divieto vive qui: RES-ATTR-07 vieta di esprimere in MB cio' che vive
    // nel renderer condiviso.
    for (const v of raccogli()) {
      expect(v.peso.memoryMB).toBeUndefined();
      expect(v.peso.processCount).toBeUndefined();
    }
  });

  test('spegnere le sorgenti svuota il registro: nessun residuo fra due montaggi', () => {
    _resetFeatureWeights();
    const off = registerFeatureWeightSources();
    expect(collectFeatureWeights().length).toBeGreaterThan(0);
    off();
    expect(collectFeatureWeights()).toEqual([]);
  });

  test('registrarle due volte non le duplica (StrictMode monta due volte)', () => {
    _resetFeatureWeights();
    const off1 = registerFeatureWeightSources();
    const n = collectFeatureWeights().length;
    const off2 = registerFeatureWeightSources();
    expect(collectFeatureWeights().length).toBe(n);
    off1(); off2();
  });

  test('OGNI sorgente ha un nome: senza, la riga direbbe «N voci»', () => {
    // Il cancello contro la deriva: aggiungere una sorgente e dimenticarsi di
    // nominarla non deve passare in silenzio. `chat.messages` non e' qui perche'
    // la registra `useChat` (conosce i marker di compattazione e gli sfratti,
    // che da fuori non si vedono).
    const senzaNome = raccogli().map(v => v.id).filter(id => !(id in NOMI_PER_TEST));
    expect(senzaNome).toEqual([]);
  });
});
