/**
 * Quando l'invito si mostra — e soprattutto quando NON si mostra.
 *
 * Tre condizioni necessarie, e la terza (`canSubscribe`) porta dentro di sé
 * tutti i casi in cui chiedere sarebbe una bugia. Il costo di sbagliare non è
 * simmetrico: un invito mancato si recupera dalle impostazioni, un permesso
 * negato per riflesso no.
 *
 * @covers CMD-02
 */
import { describe, expect, test } from 'bun:test';
import { shouldOfferPush } from './pushAsk';

describe('shouldOfferPush', () => {
  test('dopo un gesto che crea un\'attesa, su un dispositivo che può iscriversi', () => {
    expect(shouldOfferPush({ armed: true, declined: false, canSubscribe: true })).toBe(true);
  });

  test('mai al primo avvio: senza il gesto non si chiede', () => {
    expect(shouldOfferPush({ armed: false, declined: false, canSubscribe: true })).toBe(false);
  });

  test('un «non ora» vale per sempre su questo dispositivo', () => {
    expect(shouldOfferPush({ armed: true, declined: true, canSubscribe: true })).toBe(false);
  });

  test('dove iscriversi è impossibile non si chiede — sarebbe un bottone che mente', () => {
    expect(shouldOfferPush({ armed: true, declined: false, canSubscribe: false })).toBe(false);
  });
});
