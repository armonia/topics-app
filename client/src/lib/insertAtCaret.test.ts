/**
 * @covers STT-05
 */
import { describe, it, expect } from 'bun:test';
import { insertAtCaret } from './insertAtCaret';

/**
 * Dove finisce la voce dentro un campo già scritto.
 *
 * La regola che conta è che NIENTE si perda e che il cursore resti dopo il
 * pezzo appena dettato: è quello che rende ripetibile una dettatura in due
 * riprese, il modo normale di dettare una frase lunga.
 */
describe('insertAtCaret', () => {
  it('in coda a del testo mette lo spazio che il trascrittore non manda', () => {
    const { next, caret } = insertAtCaret('ciao', 4, 'mondo');
    expect(next).toBe('ciao mondo');
    expect(caret).toBe(10);
  });

  it('nel campo vuoto non inventa spazi', () => {
    expect(insertAtCaret('', 0, 'mondo')).toEqual({ next: 'mondo', caret: 5 });
  });

  it('a metà frase separa da entrambi i lati senza mangiare la coda', () => {
    const { next, caret } = insertAtCaret('ciao mondo', 4, 'bel');
    expect(next).toBe('ciao bel mondo');
    // Il cursore sta subito dopo «bel», non in fondo: la dettatura successiva
    // continua da lì invece di scavalcare quella di un istante fa.
    expect(caret).toBe(8);
    expect(next.slice(caret)).toBe(' mondo');
  });

  it('non raddoppia gli spazi che ci sono già', () => {
    expect(insertAtCaret('ciao ', 5, 'mondo').next).toBe('ciao mondo');
    // Gli spazi che c'erano ai due lati bastano entrambi: il testo entra in
    // mezzo senza aggiungerne, e non resta un doppio spazio dove non c'era.
    expect(insertAtCaret('ciao  mondo', 5, 'bel').next).toBe('ciao bel mondo');
  });

  it('un a capo vale come spazio: la voce non si incolla alla riga di sopra', () => {
    expect(insertAtCaret('prima\n', 6, 'seconda').next).toBe('prima\nseconda');
  });

  it('un cursore fuori scala si stringe invece di tagliare il testo', () => {
    expect(insertAtCaret('ciao', 99, 'mondo').next).toBe('ciao mondo');
    expect(insertAtCaret('ciao', -5, 'mondo').next).toBe('mondo ciao');
  });
});
