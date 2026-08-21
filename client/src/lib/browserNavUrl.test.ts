import { describe, it, expect, afterEach } from 'bun:test';
import { resolveBrowserNavigateUrl, normalizeUrl, displayUrl, toNavigableUrl, httpsFirstUrl } from './browserNavUrl';

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

// ---------------------------------------------------------------------------
// HTTPS-First
//
// La promozione a https e' quella che fanno Chrome e Safari, ma qui la regola
// interessante e' l'ELENCO DELLE ECCEZIONI: questa pane apre soprattutto server
// locali effimeri, e su quelli una promozione non e' una precauzione, e' un
// guasto. Ogni caso qui sotto e' un modo diverso di dire "questo indirizzo non
// esce dalla stanza".
// ---------------------------------------------------------------------------

describe('httpsFirstUrl', () => {
  it('un host pubblico in chiaro sale a https', () => {
    expect(httpsFirstUrl('http://example.com/x')).toBe('https://example.com/x');
    expect(httpsFirstUrl('http://sub.domain.co.uk/a?b=1#c')).toBe('https://sub.domain.co.uk/a?b=1#c');
    // Maiuscole nello schema comprese.
    expect(httpsFirstUrl('HTTP://example.com/x')).toBe('https://example.com/x');
  });

  it('il :80 scritto a mano se ne va con lo schema che lo sottintendeva', () => {
    // Tenerlo darebbe `https://example.com:80`, cioe' TLS su una porta in
    // chiaro: peggio del punto di partenza.
    expect(httpsFirstUrl('http://example.com:80/x')).toBe('https://example.com/x');
    expect(httpsFirstUrl('http://example.com:80')).toBe('https://example.com');
  });

  it('non tocca il loopback in nessuna delle sue forme', () => {
    for (const u of [
      'http://localhost/',
      'http://localhost:3000/app',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::1]:5173/',
    ]) {
      expect(httpsFirstUrl(u)).toBe(u);
    }
  });

  it('non tocca gli indirizzi privati di una LAN', () => {
    for (const u of [
      'http://10.0.0.5/',
      'http://192.168.1.10/admin',
      'http://172.16.0.4/',
      'http://172.31.255.254/',
      'http://169.254.10.1/',
    ]) {
      expect(httpsFirstUrl(u)).toBe(u);
    }
  });

  it("172.32 non e' privato: il blocco privato finisce a 172.31", () => {
    expect(httpsFirstUrl('http://172.32.0.4/')).toBe('https://172.32.0.4/');
    expect(httpsFirstUrl('http://172.15.0.4/')).toBe('https://172.15.0.4/');
  });

  it('non tocca i nomi mDNS in .local', () => {
    expect(httpsFirstUrl('http://mac-di-casa.local/')).toBe('http://mac-di-casa.local/');
    expect(httpsFirstUrl('http://stampante.local/setup')).toBe('http://stampante.local/setup');
  });

  it("non tocca un host senza punto, che non e' un dominio ma una macchina", () => {
    expect(httpsFirstUrl('http://portatile/')).toBe('http://portatile/');
    expect(httpsFirstUrl('http://build-server/ci')).toBe('http://build-server/ci');
  });

  it("non tocca una porta esplicita diversa da 80: e' la firma di un dev server", () => {
    expect(httpsFirstUrl('http://qualcosa.it:8080/')).toBe('http://qualcosa.it:8080/');
    expect(httpsFirstUrl('http://example.com:3000/x')).toBe('http://example.com:3000/x');
    expect(httpsFirstUrl('http://example.com:8443/x')).toBe('http://example.com:8443/x');
  });

  it("lascia stare tutto cio' che non e' http://", () => {
    for (const u of ['https://example.com/', 'about:blank', 'file:///x', 'data:text/plain,x', 'non un url']) {
      expect(httpsFirstUrl(u)).toBe(u);
    }
  });

  it("normalizeUrl la applica: e' la stessa porta di ingresso della barra", () => {
    expect(normalizeUrl('http://example.com/x')).toBe('https://example.com/x');
    // E le eccezioni restano eccezioni anche passando di li'.
    expect(normalizeUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(normalizeUrl('http://127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
  });
});

describe('un riferimento a un file di questo server', () => {
  /**
   * `browser-bridge.ts` persists a task's local file as `/api/media?path=…` so
   * the tab survives a change of host. `normalizeUrl` had no branch for it: the
   * "looks like a domain" test saw the dot in `preview.png`, produced
   * `https:///api/media?…`, and WebKit turned `api` into the HOSTNAME. The pane
   * hung on a DNS lookup for a host that does not exist.
   */
  const MEDIA = '/api/media?path=%2FUsers%2Fzorahrel%2F.topics%2Fmedia%2Fpreview.png';

  it('non diventa un dominio inventato', () => {
    const out = normalizeUrl(MEDIA, '');
    expect(out.startsWith('https://api/')).toBe(false);
    expect(out).not.toContain('https:///');
    expect(out).toBe(MEDIA);
  });

  it('con un origine, ci resta sopra: path e query intatti', () => {
    const u = new URL(normalizeUrl(MEDIA, 'https://127.0.0.1:3333'));
    expect(u.origin).toBe('https://127.0.0.1:3333');
    expect(u.pathname).toBe('/api/media');
    expect(u.searchParams.get('path')).toBe('/Users/zorahrel/.topics/media/preview.png');
  });

  it('un vero dominio continua a essere un dominio', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('`//host` non e un path locale: e protocol-relative', () => {
    expect(normalizeUrl('//example.com/x', 'https://127.0.0.1:3333')).not.toContain('127.0.0.1');
  });
});
