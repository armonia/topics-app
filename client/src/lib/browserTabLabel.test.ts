/**
 * How a browser tab labels itself, and what its subtitle says.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { browserTabLabel, browserTabSubtitle } from './browserTabLabel';

const base = { fallback: 'Browser' } as const;

describe('browserTabLabel', () => {
  it('at rest writes the page title, like any other browser', () => {
    expect(browserTabLabel({
      ...base,
      title: 'Vite + React',
      titleSource: 'auto',
      url: 'https://www.example.com/docs/',
    })).toBe('Vite + React');
  });

  it('the ACTIVE tab writes the address instead: it is the one you navigate', () => {
    expect(browserTabLabel({
      ...base,
      title: 'Vite + React',
      titleSource: 'auto',
      url: 'https://www.example.com/docs/',
      prefer: 'address',
    })).toBe('example.com/docs/');
  });

  it('keeps the port, which is what tells two dev servers apart', () => {
    const a = browserTabLabel({ ...base, url: 'http://localhost:3333/board', prefer: 'address' });
    const b = browserTabLabel({ ...base, url: 'http://localhost:5173/board', prefer: 'address' });
    expect(a).toBe('http://localhost:3333/board');
    expect(b).toBe('http://localhost:5173/board');
    expect(a).not.toBe(b);
  });

  it('a decided name beats both, in either state', () => {
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
      prefer: 'address',
    })).toBe('Anteprima task');
  });

  it('a page with no title falls back to the address', () => {
    expect(browserTabLabel({ ...base, url: 'https://example.com/x' })).toBe('example.com/x');
  });

  it('the empty page is not an address', () => {
    expect(browserTabLabel({ ...base, url: 'about:blank' })).toBe('Browser');
    expect(browserTabLabel({ ...base, url: '', prefer: 'address' })).toBe('Browser');
  });

  it('the active tab falls back to the page title when there is no parsable address', () => {
    expect(browserTabLabel({ ...base, title: 'Report', titleSource: 'auto', url: 'about:blank', prefer: 'address' }))
      .toBe('Report');
  });
});

describe('browserTabSubtitle', () => {
  it('is the address when the label is the page title', () => {
    expect(browserTabSubtitle({
      ...base,
      title: 'Example Domain',
      titleSource: 'auto',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
  });

  it('is the page title when the label is the address', () => {
    expect(browserTabSubtitle({
      ...base,
      title: 'Example Domain',
      titleSource: 'auto',
      url: 'https://example.com/x',
      prefer: 'address',
    })).toBe('Example Domain');
  });

  it('is the address when the label is a decided name', () => {
    expect(browserTabSubtitle({
      ...base,
      title: 'Fatturazione',
      titleSource: 'user',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
    expect(browserTabSubtitle({
      ...base,
      title: 'Fatturazione',
      titleSource: 'user',
      url: 'https://example.com/x',
      prefer: 'address',
    })).toBe('example.com/x');
  });

  it('says nothing when it would repeat the label', () => {
    expect(browserTabSubtitle({ ...base, url: 'about:blank' })).toBe('');
    expect(browserTabSubtitle({ ...base, url: 'https://example.com/x' })).toBe('');
  });
});
