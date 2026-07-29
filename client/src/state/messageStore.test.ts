import { afterEach, describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types';
import {
  __messageStoreDebug,
  __resetMessageStore,
  getAllMessages,
  getSessionMessagesFromStore,
  replaceAllMessages,
  subscribeAllMessages,
  subscribeSession,
  updateMessages,
} from './messageStore';

/**
 * Lo store esiste per una ragione sola: un token che arriva in una chat deve
 * svegliare QUELLA chat e nessun altro. Prima viveva in `App`, quindi ogni token
 * ri-renderizzava sidebar, tab bar e ogni pane — decine di volte al secondo
 * durante uno streaming.
 *
 * Questi test guardano proprio quello: chi viene svegliato, e chi no.
 */

afterEach(() => {
  __resetMessageStore();
});

function msg(id: string): ChatMessage {
  return { id, role: 'assistant', content: id } as ChatMessage;
}

describe('lettura', () => {
  test('una sessione senza messaggi torna sempre lo STESSO array vuoto', () => {
    // `useSyncExternalStore` va in loop infinito se lo snapshot cambia identità
    // a ogni chiamata: questo non e' un dettaglio estetico.
    const a = getSessionMessagesFromStore('mai-vista');
    const b = getSessionMessagesFromStore('mai-vista');
    expect(a).toBe(b);
    expect(a).toEqual([]);
  });

  test("l'identità di una sessione regge finché non cambia", () => {
    replaceAllMessages({ s1: [msg('a')] });
    const first = getSessionMessagesFromStore('s1');
    updateMessages((p) => ({ ...p, s2: [msg('b')] }));
    // s2 e' cambiata, s1 no: chi guarda s1 non deve vedere niente di nuovo.
    expect(getSessionMessagesFromStore('s1')).toBe(first);
  });
});

describe('notifiche mirate', () => {
  test('cambia una sessione: si sveglia solo chi la guarda', () => {
    replaceAllMessages({ s1: [msg('a')], s2: [msg('b')] });
    let n1 = 0;
    let n2 = 0;
    subscribeSession('s1', () => { n1++; });
    subscribeSession('s2', () => { n2++; });

    updateMessages((p) => ({ ...p, s1: [...p.s1, msg('nuovo')] }));

    expect(n1).toBe(1);
    expect(n2).toBe(0); // <- il punto di tutto il modulo
  });

  test('un updater che non cambia niente non sveglia nessuno', () => {
    replaceAllMessages({ s1: [msg('a')] });
    let n = 0;
    subscribeSession('s1', () => { n++; });
    subscribeAllMessages(() => { n++; });
    updateMessages((p) => p);
    expect(n).toBe(0);
  });

  test('una sessione RIMOSSA sveglia chi la guardava', () => {
    // Cancellare una chat deve arrivare a chi la sta mostrando, o resta a
    // guardare messaggi che non esistono piu'.
    replaceAllMessages({ s1: [msg('a')], s2: [msg('b')] });
    let n = 0;
    subscribeSession('s1', () => { n++; });
    updateMessages(() => ({ s2: [msg('b')] }));
    expect(n).toBe(1);
    expect(getSessionMessagesFromStore('s1')).toEqual([]);
  });

  test('una sessione NUOVA sveglia chi la aspettava', () => {
    let n = 0;
    subscribeSession('futura', () => { n++; });
    updateMessages((p) => ({ ...p, futura: [msg('primo')] }));
    expect(n).toBe(1);
  });

  test('i globali si svegliano una volta sola per aggiornamento', () => {
    let g = 0;
    subscribeAllMessages(() => { g++; });
    updateMessages(() => ({ a: [msg('1')], b: [msg('2')], c: [msg('3')] }));
    expect(g).toBe(1);
  });
});

describe('igiene delle sottoscrizioni', () => {
  test('disiscriversi ferma le notifiche', () => {
    replaceAllMessages({ s1: [] });
    let n = 0;
    const off = subscribeSession('s1', () => { n++; });
    updateMessages((p) => ({ ...p, s1: [msg('a')] }));
    expect(n).toBe(1);
    off();
    updateMessages((p) => ({ ...p, s1: [msg('b')] }));
    expect(n).toBe(1);
  });

  test("l'ultimo che se ne va porta via il Set", () => {
    // Senza potatura la mappa crescerebbe quanto il numero di sessioni mai
    // aperte, e resterebbe piena di Set vuoti per sempre.
    const off1 = subscribeSession('s1', () => {});
    const off2 = subscribeSession('s1', () => {});
    expect(__messageStoreDebug().iscritti).toBe(2);
    off1();
    off2();
    expect(__messageStoreDebug().iscritti).toBe(0);
  });

  test('disiscriversi due volte non rompe niente', () => {
    const off = subscribeSession('s1', () => {});
    off();
    off();
    expect(__messageStoreDebug().iscritti).toBe(0);
  });
});

describe('la firma resta quella di useState', () => {
  test("l'updater riceve lo stato precedente e ne torna uno nuovo", () => {
    // E' cio' che ha permesso di spostare i messaggi fuori da `App` senza
    // toccare nessuno dei venticinque `setMessages` di `useChat`.
    replaceAllMessages({ s1: [msg('a')] });
    updateMessages((prev) => {
      expect(prev.s1).toHaveLength(1);
      return { ...prev, s1: [...prev.s1, msg('b')] };
    });
    expect(getAllMessages().s1).toHaveLength(2);
  });
});
