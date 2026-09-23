/**
 * THE FULL BODY OF A TRIMMED ROW SAYS WHETHER IT IS COMING.
 *
 * A closed tool row ships trimmed (output blank, long strings cut) and the
 * first opening fetches the rest. That fetch used to be silent both ways:
 * while it ran the card showed the command with no output, and when it failed
 * (a 404 on a coalesced run, 990 calls measured) the error was swallowed and
 * the card stayed like that forever. An empty output and a lost output looked
 * the same.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolDetailFetchStatus } from './ToolDetailFetchStatus';
import { t, ensureLocaleLoaded } from '../../lib/i18n';

/** The catalogue string as React writes it in markup (apostrophes escaped). */
const inMarkup = (text: string) => text.replace(/'/g, '&#x27;');

describe('the lazy-fetch status line of a tool row', () => {
  test('says it is loading while the full body is on its way', () => {
    const html = renderToStaticMarkup(<ToolDetailFetchStatus state="loading" />);
    expect(html).toContain('data-testid="tool-detail-loading"');
    expect(html).toContain(inMarkup(t('chat.tool.detailLoading', 'it')));
  });

  test('says it failed, with the reason, when the fetch fails', () => {
    const html = renderToStaticMarkup(<ToolDetailFetchStatus state="error" error="tool call not found" />);
    expect(html).toContain('data-testid="tool-detail-error"');
    expect(html).toContain(inMarkup(t('chat.tool.detailFailed', 'it')));
    expect(html).toContain('tool call not found');
  });

  test('draws nothing once the body is there', () => {
    expect(renderToStaticMarkup(<ToolDetailFetchStatus state="done" />)).toBe('');
    expect(renderToStaticMarkup(<ToolDetailFetchStatus state="idle" />)).toBe('');
  });

  test('both catalogues carry the two strings', async () => {
    await ensureLocaleLoaded('en');
    for (const key of ['chat.tool.detailLoading', 'chat.tool.detailFailed']) {
      expect(t(key, 'it')).not.toBe(key);
      expect(t(key, 'en')).not.toBe(key);
      expect(t(key, 'it')).not.toBe(t(key, 'en'));
    }
  });
});
