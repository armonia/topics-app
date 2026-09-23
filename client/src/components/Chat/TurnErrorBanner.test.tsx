/**
 * THE BANNER SHOWS A SENTENCE, AND KEEPS THE PAYLOAD.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo): the assertion is
 * on the markup, which is also what the E2E locator `turn-error-details` looks
 * for.
 *
 * @covers CHAT-REL-07
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnErrorBanner } from './TurnErrorBanner';

const API_401 = 'API 401: {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}. The token could not be renewed either: run `claude` then /login once, then retry.';

describe('the turn verdict banner', () => {
  test('prints the sentence and not the payload', () => {
    const html = renderToStaticMarkup(<TurnErrorBanner text={API_401} />);
    // What is read at a glance is everything before the fold.
    const visible = html.slice(0, html.indexOf('<details'));
    expect(visible).toContain('OAuth access token has been revoked');
    expect(visible).not.toContain('authentication_error');
    expect(visible).not.toContain('&quot;');
  });

  test('keeps the payload behind a fold that starts closed', () => {
    const html = renderToStaticMarkup(<TurnErrorBanner text={API_401} />);
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(html).toContain('data-testid="turn-error-details"');
    expect(html).toContain('authentication_error');
  });

  // A payload stored cut off still folds, and the fold says it is partial:
  // somebody about to paste it into a bug report should not believe it is the
  // whole envelope the provider sent.
  test('a truncated payload reads as a sentence and labels its fold', () => {
    const cut = 'API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.112: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6."},"request_id":"req_011C';
    const html = renderToStaticMarkup(<TurnErrorBanner text={cut} />);
    const visible = html.slice(0, html.indexOf('<details'));
    expect(visible).toContain('tool_use');
    expect(visible).not.toContain('invalid_request_error');
    expect(html).toContain('data-testid="turn-error-details"');

    // The fold carries the payload exactly as it was stored, cut included,
    // and its label is not the one a whole payload gets. Compared instead of
    // spelled out, so the assertion survives the translation being reworded.
    expect(html).toContain('&quot;request_id&quot;:&quot;req_011C</pre>');
    const summaryOf = (h: string) => h.slice(h.indexOf('<summary'), h.indexOf('</summary>'));
    const whole = renderToStaticMarkup(<TurnErrorBanner text={API_401} />);
    expect(summaryOf(html)).not.toBe(summaryOf(whole));
  });

  test('a prose verdict gets no fold at all', () => {
    const html = renderToStaticMarkup(<TurnErrorBanner text="The connection dropped. Your message is still here." />);
    expect(html).toContain('The connection dropped');
    expect(html).not.toContain('<details');
  });
});
