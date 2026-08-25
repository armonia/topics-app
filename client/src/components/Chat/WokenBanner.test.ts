/**
 * «MA QUESTO DA DOVE ARRIVA?»
 *
 * Un `Monitor` armato consegna il suo evento risvegliando la sessione: la
 * risposta compare in chat minuti dopo, sotto un messaggio che non c'entra e
 * senza che nessuno l'abbia chiesta. Il 20/08, provando dal vivo, e' comparso
 * un «Risveglio arrivato: …» indistinguibile da una risposta qualunque — e la
 * domanda successiva e' stata esattamente questa.
 *
 * Il cartello risponde a due cose: CHE non l'hai chiesta tu, e COSA era sotto
 * sorveglianza (la `description` che l'agente ha dato al Monitor). Si rende in
 * cima alla bolla, come il verdetto d'errore, non nella cronologia dei blocchi.
 * @covers MONITOR-03
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../MessageContent';
import type { ContentBlock } from '../../types';

const render = (blocks: ContentBlock[], content = 'Il build e\' fallito.') =>
  renderToStaticMarkup(createElement(MessageContent, { content, role: 'assistant', blocks } as never));

describe('il cartello del risveglio', () => {
  test('con la label dice COSA e' + "' arrivato", () => {
    const html = render([{ kind: 'woken', label: 'esito build' }, { kind: 'text', text: "Il build e' fallito." }]);
    expect(html).toContain('woken-banner');
    expect(html).toContain('esito build');
    // E il corpo della risposta resta, sotto il cartello. L'apostrofo arriva
    // HTML-escaped (`&#x27;`), che e' corretto: si cerca cio' che lo circonda.
    expect(html).toContain('Il build e');
    expect(html).toContain('fallito.');
  });

  test('senza label dice almeno CHE non l\'hai chiesta tu', () => {
    // La `description` puo' mancare (Monitor armato prima che il server la
    // vedesse, o riga vecchia): il cartello vale comunque, perche' la cosa
    // davvero mancante e' la provenienza, non il dettaglio.
    const html = render([{ kind: 'woken' }, { kind: 'text', text: 'ok' }]);
    expect(html).toContain('woken-banner');
    expect(html.toLowerCase()).toMatch(/mentre eri via|background watch/);
  });

  test('una risposta normale non ha nessun cartello', () => {
    const html = render([{ kind: 'text', text: 'ciao' }]);
    expect(html).not.toContain('woken-banner');
  });

  test('il cartello non finisce anche nella cronologia', () => {
    // Si rende in cima, una volta: se comparisse anche come blocco della
    // timeline l'utente lo leggerebbe due volte.
    const html = render([{ kind: 'woken', label: 'esito build' }, { kind: 'text', text: 'ok' }]);
    expect(html.split('esito build').length - 1).toBe(1);
  });
});
