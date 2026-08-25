/**
 * Riconoscere i propri echi sul filo.
 *
 * Il frame `welcome` porta `clientId` da sempre, col commento «Echo of the WS
 * client id», e non lo leggeva nessuno: il client non sapeva quale fosse il
 * proprio id, quindi ogni broadcast sembrava venire da un altro. Il caso concreto
 * è `typing`: il server esclude la socket mittente, ma non copre lo STESSO utente
 * con la topic aperta due volte (app desktop più una scheda su localhost, due
 * finestre, la PWA sul telefono). Lì ognuno vedeva «qualcuno sta scrivendo»
 * mentre a scrivere era lui.
 *
 * La scelta che questi test fissano è quella asimmetrica: nel dubbio il frame è
 * ALTRUI. Mostrare un indicatore di troppo per una frazione di secondo è un
 * fastidio; non mostrare mai l'attività di un altro utente rompe la funzione.
  * @covers WIRE-05
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { getWsClientId, isOwnFrame, setWsClientId } from './wsIdentity';

beforeEach(() => setWsClientId(null));

describe('setWsClientId / getWsClientId', () => {
  test('parte sconosciuto', () => {
    expect(getWsClientId()).toBe(null);
  });

  test('registra e restituisce l id', () => {
    setWsClientId('sock-1');
    expect(getWsClientId()).toBe('sock-1');
  });

  test('una riconnessione SOSTITUISCE l id, non lo affianca', () => {
    // Il server assegna un id nuovo per socket: tenere il primo farebbe fallire
    // il confronto in silenzio dopo ogni riconnessione.
    setWsClientId('sock-1');
    setWsClientId('sock-2');
    expect(getWsClientId()).toBe('sock-2');
  });

  test('una stringa vuota vale come sconosciuto, non come id valido', () => {
    setWsClientId('');
    expect(getWsClientId()).toBe(null);
  });
});

describe('isOwnFrame', () => {
  test('riconosce il proprio frame', () => {
    setWsClientId('sock-1');
    expect(isOwnFrame('sock-1')).toBe(true);
  });

  test('un frame di un altro non è proprio', () => {
    setWsClientId('sock-1');
    expect(isOwnFrame('sock-2')).toBe(false);
  });

  test('senza id noto, il frame è ALTRUI — mai proprio', () => {
    // Welcome non ancora arrivato: sopprimere qui vorrebbe dire perdere
    // l'attività di un altro utente nei primi istanti di connessione.
    expect(isOwnFrame('sock-1')).toBe(false);
  });

  test('un frame senza clientId è ALTRUI', () => {
    setWsClientId('sock-1');
    expect(isOwnFrame(undefined)).toBe(false);
    expect(isOwnFrame(null)).toBe(false);
    expect(isOwnFrame('')).toBe(false);
  });

  test('due sconosciuti non si equivalgono (null !== null)', () => {
    // Il caso che una `===` ingenua sbaglierebbe: id sconosciuto e frame senza
    // id darebbero `null === null` ⇒ vero, e il client si zittirebbe da solo.
    setWsClientId(null);
    expect(isOwnFrame(null)).toBe(false);
  });
});
