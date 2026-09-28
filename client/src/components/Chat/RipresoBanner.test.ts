/**
 * "THIS IS THE REDONE ANSWER" SITS ON THE ANSWER THE SERVER REDID, AND NOWHERE
 * ELSE (card edf3c4db).
 *
 * Two writers put a `ripreso` block on a row. The chat route opens a resent
 * turn with one: that bubble is the redone answer, and the banner says so. The
 * resume sweep appends one to the row it resends FROM, after that row's cut,
 * to count the chain: when the route refuses the resend (503
 * `provider_unavailable`) no redone answer exists, and the banner drawn there
 * told the person a sentence about an answer nobody redid.
 *
 * Rendered through `MessageContent`, the component that draws the banner, so
 * the rule is checked where it is applied and not only in its helper.
 *
 * @covers RESUME-02
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../MessageContent';
import type { ContentBlock } from '../../types';

const render = (blocks: ContentBlock[], content: string) =>
  renderToStaticMarkup(createElement(MessageContent, { content, role: 'assistant', blocks } as never));

/** The boot's restart notice, which asks for Retry. */
const NOTICE = "⚠️ Turno interrotto da un riavvio del server. Il messaggio che hai inviato e' ancora qui: premi Riprova per inviarlo di nuovo.";
const CUT = 'Turno interrotto: il server si è riavviato mentre la risposta era in corso.';

describe('the redone-answer banner', () => {
  test('the turn the route resent carries it', () => {
    const html = render([{ kind: 'ripreso', attempt: 1 }, { kind: 'text', text: 'Rifatto.' }], 'Rifatto.');
    expect(html).toContain('ripreso-banner');
  });

  test('a restart notice the sweep traced does not: its resend was refused and nothing was redone', () => {
    const html = render([{ kind: 'error', text: NOTICE }, { kind: 'ripreso', attempt: 1 }], NOTICE);
    expect(html).not.toContain('ripreso-banner');
  });

  test('a cut answer the sweep traced does not either', () => {
    const html = render(
      [{ kind: 'text', text: 'sto misurando' }, { kind: 'error', text: CUT }, { kind: 'ripreso', attempt: 2 }],
      'sto misurando',
    );
    expect(html).not.toContain('ripreso-banner');
  });

  test('a redone answer that was cut in turn and traced keeps it: the route opened it', () => {
    const html = render(
      [{ kind: 'ripreso', attempt: 1 }, { kind: 'text', text: 'rifaccio' }, { kind: 'error', text: CUT }, { kind: 'ripreso', attempt: 2 }],
      'rifaccio',
    );
    expect(html).toContain('ripreso-banner');
  });
});
