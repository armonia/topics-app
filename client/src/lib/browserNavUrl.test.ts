import { describe, it, expect, afterEach } from 'bun:test';
import { resolveBrowserNavigateUrl, normalizeUrl, displayUrl, toNavigableUrl } from './browserNavUrl';

// Stub the parts of `window` the resolver reads. Each case sets its own.
function setWindow(opts: {
  hostname: string;
  protocol?: string;
  origin?: string;
}) {
  (globalThis as { window?: unknown }).window = {
    location: {
      hostname: opts.hostname,
      protocol: opts.protocol ?? 'https:',
      origin: opts.origin ?? `${opts.protocol ?? 'https:'}//${opts.hostname}`,
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('resolveBrowserNavigateUrl', () => {
  it('does not rewrite localhost when the client host is itself local (127.0.0.1)', () => {
    // The white-screen guard: an agent opens a freshly started http dev server.
    // On a host that can reach localhost directly this must stay http://localhost —
    // forcing https made it an unreachable URL → chrome-error blank page.
    setWindow({ hostname: '127.0.0.1', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(resolveBrowserNavigateUrl('http://127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
  });

  it('does not rewrite when the web client is itself local', () => {
    setWindow({ hostname: 'localhost', protocol: 'http:' });
    expect(resolveBrowserNavigateUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
  });

  it('rewrites localhost for a remote web client (Tailscale/LAN)', () => {
    setWindow({ hostname: '100.64.0.5', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('http://localhost:3000/x')).toBe('https://100.64.0.5:3000/x');
  });

  it('leaves non-local URLs untouched in every mode', () => {
    setWindow({ hostname: '100.64.0.5', protocol: 'https:' });
    expect(resolveBrowserNavigateUrl('https://example.com/page')).toBe('https://example.com/page');
    setWindow({ hostname: '127.0.0.1' });
    expect(resolveBrowserNavigateUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('returns non-URL strings unchanged', () => {
    setWindow({ hostname: '100.64.0.5' });
    expect(resolveBrowserNavigateUrl('about:blank')).toBe('about:blank');
    expect(resolveBrowserNavigateUrl('not a url')).toBe('not a url');
  });
});

describe('normalizeUrl (address-bar omnibox)', () => {
  it('passes full URLs through untouched', () => {
    expect(normalizeUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(normalizeUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
    expect(normalizeUrl('file:///Users/me/x.html')).toBe('file:///Users/me/x.html');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('gives a bare host https:// (not http://, the old downgrade)', () => {
    expect(normalizeUrl('github.com')).toBe('https://github.com');
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(normalizeUrl('sub.domain.co.uk')).toBe('https://sub.domain.co.uk');
  });

  it('searches anything that is not a URL (the bug: this used to become http://<query>)', () => {
    expect(normalizeUrl('come fare la pasta')).toBe('https://www.google.com/search?q=come%20fare%20la%20pasta');
    // A single word with no dot is a search, not a host.
    expect(normalizeUrl('openai')).toBe('https://www.google.com/search?q=openai');
    // A dotted phrase WITH spaces is still a search, not a host.
    expect(normalizeUrl('weather tomorrow. rain?')).toBe(
      'https://www.google.com/search?q=weather%20tomorrow.%20rain%3F',
    );
  });

  it('maps empty/whitespace input to about:blank', () => {
    expect(normalizeUrl('')).toBe('about:blank');
    expect(normalizeUrl('   ')).toBe('about:blank');
  });
});


// ---------------------------------------------------------------------------
// La barra dell'indirizzo di un file locale
//
// Il documento viaggia come `/api/media?path=…` perché è così che lo si serve
// senza aprire `file://` a chi non è fidato — ma quello è il TRASPORTO. Nella
// barra ci va il file, come in Chrome quando apre un PDF locale. `displayUrl` e
// `toNavigableUrl` sono i due versi della stessa traduzione e vanno provati in
// coppia: se si scollano, premere Invio sulla riga che si sta leggendo porta
// altrove — o su un divieto.
// ---------------------------------------------------------------------------

describe('barra indirizzo di un file locale', () => {
  const PDF = '/Users/x/Documents/contratto firmato.pdf';
  const REF = `/api/media?path=${encodeURIComponent(PDF)}`;

  it('mostra il file, non la rotta che lo serve', () => {
    expect(displayUrl(`http://127.0.0.1:13333${REF}`)).toBe(`file://${PDF}`);
    expect(displayUrl(REF)).toBe(`file://${PDF}`);
  });

  it('lascia stare gli indirizzi veri', () => {
    for (const u of ['https://example.com/', 'about:blank', 'https://x.com/api/mediaset']) {
      expect(displayUrl(u)).toBe(u);
    }
  });

  it('non si fa ingannare da un sito che ci somiglia nella query', () => {
    const u = 'https://tizio.it/x?u=/api/media?path=%2Fetc%2Fpasswd';
    expect(displayUrl(u)).toBe(u);
  });

  it('Invio sulla riga mostrata riporta allo stesso documento', () => {
    setWindow({ hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:13333' });
    const shown = displayUrl(`http://127.0.0.1:13333${REF}`);
    expect(toNavigableUrl(shown)).toBe(`http://127.0.0.1:13333${REF}`);
    // Andata e ritorno: quello che si naviga si rilegge com'era.
    expect(displayUrl(toNavigableUrl(shown))).toBe(shown);
  });

  it('accetta anche un percorso incollato senza schema', () => {
    setWindow({ hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:13333' });
    expect(toNavigableUrl(PDF)).toBe(`http://127.0.0.1:13333${REF}`);
  });

  it('una ricerca resta una ricerca, un host resta un host', () => {
    setWindow({ hostname: '127.0.0.1', protocol: 'http:', origin: 'http://127.0.0.1:13333' });
    expect(toNavigableUrl('come fare la pasta')).toContain('google.com/search');
    expect(toNavigableUrl('github.com')).toBe('https://github.com');
  });
});
