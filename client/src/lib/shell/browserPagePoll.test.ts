import { describe, it, expect } from 'bun:test';
import { buildReadJs, META_JS, parsePageState, isPageLoading } from './browserPagePoll';

const READ_JS = buildReadJs('/*focus-hook*/');

describe('the two polls agree on what they read', () => {
  // The regression these guard: READ and META used to be two hand-written
  // strings, and they had drifted apart. Only READ carried `readyState`. Since
  // READ is gated on the pane being VISIBLE, a pane sent to a background tab
  // while a page was loading lost the only poll that could ever clear the flag:
  // its tab spinner turned for the rest of the session, and the pane was
  // reported as busy into the project rollup forever.

  it('both carry readyState — the field whose absence stuck a pane on "loading"', () => {
    expect(READ_JS).toContain('r:document.readyState');
    expect(META_JS).toContain('r:document.readyState');
  });

  it('both carry the document zoom — a background pane keeps navigating too', () => {
    expect(READ_JS).toContain('z:document.documentElement.style.zoom');
    expect(META_JS).toContain('z:document.documentElement.style.zoom');
  });

  it('both read url, title and favicon', () => {
    for (const js of [READ_JS, META_JS]) {
      expect(js).toContain('u:location.href');
      expect(js).toContain('t:document.title');
      expect(js).toContain("link[rel~='icon']");
    }
  });

  it('both survive a page that throws mid-read', () => {
    // Without this, one bad property access rejected the eval and threw away the
    // state that WAS readable. META always had it; READ did not.
    for (const js of [READ_JS, META_JS]) {
      expect(js).toContain('try{');
      expect(js).toContain("catch(e){return ''}");
    }
  });

  it('only the foreground poll drains the console and the click counter', () => {
    // The drain SPLICES the page-side buffer, so running it from both polls
    // would let one steal lines from the other; and nobody clicks in a pane
    // they cannot see.
    expect(READ_JS).toContain('__topicsFocusBump');
    expect(READ_JS).toContain('__topicsConsole');
    expect(META_JS).not.toContain('__topicsFocusBump');
    expect(META_JS).not.toContain('__topicsConsole');
  });

  it('the foreground poll installs the focus hook verbatim', () => {
    expect(buildReadJs('SENTINEL;')).toContain('SENTINEL;');
  });
});

describe('parsePageState', () => {
  it('reads a full foreground payload', () => {
    const s = parsePageState(JSON.stringify({
      u: 'https://example.com/a', t: 'Example', r: 'complete', z: '1.5',
      f: 'https://example.com/favicon.ico', k: 7,
      c: [{ level: 'error', text: 'boom' }],
    }));
    expect(s).toEqual({
      url: 'https://example.com/a',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
      readyState: 'complete',
      zoomStyle: '1.5',
      focusBump: 7,
      console: [{ level: 'error', text: 'boom' }],
    });
  });

  it('reads a background payload, defaulting the fields it does not carry', () => {
    const s = parsePageState(JSON.stringify({
      u: 'https://example.com/', t: 'X', r: 'loading', z: '', f: '',
    }));
    expect(s?.focusBump).toBe(0);
    expect(s?.console).toEqual([]);
    expect(s?.readyState).toBe('loading');
  });

  it('maps about:blank to an empty url', () => {
    // A freshly-created webview reports about:blank before its first real
    // navigation; writing that into the address bar would wipe what the user
    // just typed.
    expect(parsePageState(JSON.stringify({ u: 'about:blank', t: '', r: 'complete' }))?.url).toBe('');
  });

  it('returns null for everything unusable, so callers have ONE empty case', () => {
    expect(parsePageState('')).toBeNull();
    expect(parsePageState(null)).toBeNull();
    expect(parsePageState(undefined)).toBeNull();
    expect(parsePageState('not json')).toBeNull();
    expect(parsePageState('null')).toBeNull();
    expect(parsePageState('42')).toBeNull();
  });

  it('drops console lines that carry no text instead of rendering blanks', () => {
    const s = parsePageState(JSON.stringify({
      u: 'https://e.com/', r: 'complete', c: [{ level: 'log', text: 'ok' }, { level: 'log' }, null],
    }));
    expect(s?.console).toEqual([{ level: 'log', text: 'ok' }]);
  });
});

describe('isPageLoading', () => {
  it('is the ONLY authority on the progress bar', () => {
    expect(isPageLoading('loading')).toBe(true);
    expect(isPageLoading('interactive')).toBe(true);
    expect(isPageLoading('complete')).toBe(false);
  });

  it('a poll that could not read the document is "do not know", not "loading"', () => {
    // Otherwise a pane whose eval fails lights an indeterminate progress bar
    // that nothing will ever turn off.
    expect(isPageLoading('')).toBe(false);
  });
});
