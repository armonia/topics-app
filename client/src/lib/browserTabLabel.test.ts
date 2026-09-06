/**
 * How a browser tab labels itself, and what its subtitle says.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { browserTabLabel, browserTabSubtitle } from './browserTabLabel';

describe('browserTabLabel', () => {
  it('writes the page title, like any other browser', () => {
    expect(browserTabLabel({
      title: 'Vite + React',
      titleSource: 'auto',
      url: 'https://www.example.com/docs/',
    })).toBe('Vite + React');
  });

  it('writes the page title on the ACTIVE tab too: the state does not change the answer', () => {
    // The old rule swapped in the address here, so the tab you were working in
    // was the one tab in the bar that did not say what page it was.
    const input = { title: 'Vite + React', titleSource: 'auto' as const, url: 'https://www.example.com/docs/' };
    expect(browserTabLabel(input)).toBe('Vite + React');
    expect(browserTabSubtitle(input)).toBe('example.com/docs/');
  });

  it('a decided name beats the page title', () => {
    expect(browserTabLabel({
      title: 'Fatturazione', // allow-italian: a user-chosen tab name, the value under test
      titleSource: 'user',
      url: 'https://example.com/very/long/path',
    })).toBe('Fatturazione'); // allow-italian: same
    expect(browserTabLabel({
      title: 'Task preview',
      titleSource: 'agent',
      url: 'https://example.com/x',
    })).toBe('Task preview');
  });

  it('a page with no title falls back to the address', () => {
    expect(browserTabLabel({ url: 'https://example.com/x' })).toBe('example.com/x');
  });

  it('keeps the port, which is what tells two dev servers apart', () => {
    const a = browserTabLabel({ url: 'http://localhost:3333/board' });
    const b = browserTabLabel({ url: 'http://localhost:5173/board' });
    expect(a).toBe('http://localhost:3333/board');
    expect(b).toBe('http://localhost:5173/board');
    expect(a).not.toBe(b);
  });

  it('a pane with neither is a New tab, not a "Browser"', () => {
    expect(browserTabLabel({ url: 'about:blank' })).toBe('New tab');
    expect(browserTabLabel({ url: '' })).toBe('New tab');
    expect(browserTabLabel({})).toBe('New tab');
  });

  it('the empty page keeps the page title when it has one', () => {
    expect(browserTabLabel({ title: 'Report', titleSource: 'auto', url: 'about:blank' })).toBe('Report');
  });
});

describe('browserTabSubtitle', () => {
  it('is the address when the label is the page title', () => {
    expect(browserTabSubtitle({
      title: 'Example Domain',
      titleSource: 'auto',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
  });

  it('is the address when the label is a decided name', () => {
    expect(browserTabSubtitle({
      title: 'Fatturazione', // allow-italian: a user-chosen tab name, the value under test
      titleSource: 'user',
      url: 'https://example.com/x',
    })).toBe('example.com/x');
  });

  it('says nothing when it would repeat the label', () => {
    expect(browserTabSubtitle({ url: 'https://example.com/x' })).toBe('');
  });

  it('says nothing on a pane that has neither', () => {
    expect(browserTabSubtitle({ url: 'about:blank' })).toBe('');
  });
});
