/**
 * How a browser tab labels itself, and what its subtitle says.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { browserTabLabel, browserTabSubtitle } from './browserTabLabel';

const base = { fallback: 'Browser' } as const;

describe('browserTabLabel', () => {
  it('writes the address, not the page title', () => {
    expect(browserTabLabel({
      ...base,
      title: 'Vite + React',
      titleSource: 'auto',
      url: 'https://www.example.com/docs/',
    })).toBe('example.com/docs/');
  });

  it('keeps the port, which is what tells two dev servers apart', () => {
    const a = browserTabLabel({ ...base, url: 'http://localhost:3333/board' });
    const b = browserTabLabel({ ...base, url: 'http://localhost:5173/board' });
    expect(a).toBe('http://localhost:3333/board');
    expect(b).toBe('http://localhost:5173/board');
    expect(a).not.toBe(b);
  });

  it('a decided name beats the address', () => {
    expect(browserTabLabel({
      ...base,
      title: 'Fatturazione',
      titleSource: 'user',
      url: 'https://example.com/very/long/path',
    })).toBe('Fatturazione');
    expect(browserTabLabel({
      ...base,
      title: 'Anteprima task',
      titleSource: 'agent',
      url: 'https://example.com/x',
    })).toBe('Anteprima task');
  });

  it('an automatic title does NOT beat the address', () => {
    expect(browserTabLabel({
      ...base,
      title: 'Example Domain',
      titleSource: 'auto',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
  });

  it('the empty page is not an address', () => {
    expect(browserTabLabel({ ...base, url: 'about:blank' })).toBe('Browser');
    expect(browserTabLabel({ ...base, url: '' })).toBe('Browser');
  });

  it('falls back to the page title when there is no parsable address', () => {
    expect(browserTabLabel({ ...base, title: 'Report', titleSource: 'auto', url: 'about:blank' }))
      .toBe('Report');
  });
});

describe('browserTabSubtitle', () => {
  it('is the page title when the label is the address', () => {
    expect(browserTabSubtitle({
      ...base,
      title: 'Example Domain',
      titleSource: 'auto',
      url: 'https://example.com/x',
    })).toBe('Example Domain');
  });

  it('is the address when the label is a decided name', () => {
    expect(browserTabSubtitle({
      ...base,
      title: 'Fatturazione',
      titleSource: 'user',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
  });

  it('says nothing when it would repeat the label', () => {
    expect(browserTabSubtitle({ ...base, url: 'about:blank' })).toBe('');
  });
});
