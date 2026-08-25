/**
 * @covers BROWSER-FAVICON-01
 */
import { describe, expect, it } from 'bun:test';
import { faviconHost, faviconPlaceholder, faviconPlaceholderColor } from './faviconPlaceholder';

describe('faviconHost', () => {
  it('toglie il www e abbassa le maiuscole', () => {
    expect(faviconHost('https://WWW.GitHub.com/topics')).toBe('github.com');
  });

  it('accetta una riga scritta a mano nella barra', () => {
    expect(faviconHost('github.com/topics')).toBe('github.com');
  });

  it('non inventa un host per gli schemi che non ne hanno uno', () => {
    expect(faviconHost('about:blank')).toBe('');
    expect(faviconHost('data:text/html,<p>ciao</p>')).toBe('');
    expect(faviconHost('chrome-error://chromewebdata/')).toBe('');
    expect(faviconHost('')).toBe('');
  });

  it('un file locale non ha host', () => {
    expect(faviconHost('file:///tmp/contratto.pdf')).toBe('');
  });
});

describe('faviconPlaceholder', () => {
  it('dà il monogramma dell host', () => {
    const p = faviconPlaceholder('https://www.example.com/x?y=1');
    expect(p.kind).toBe('monogram');
    expect(p.letter).toBe('E');
    expect(p.host).toBe('example.com');
  });

  it('la tinta è deterministica e dipende dall host', () => {
    const a = faviconPlaceholder('https://example.com');
    const b = faviconPlaceholder('https://example.com/altra/pagina');
    expect(a.hue).toBe(b.hue);
    expect(a.hue).not.toBe(faviconPlaceholder('https://elgoog.com').hue);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
  });

  it('senza host disegna il globo', () => {
    for (const url of ['about:blank', '', 'file:///tmp/x.pdf']) {
      const p = faviconPlaceholder(url);
      expect(p.kind).toBe('globe');
      expect(p.letter).toBe('');
    }
  });

  it('un IP nudo non ha iniziale, quindi globo', () => {
    expect(faviconPlaceholder('http://127.0.0.1:3000').kind).toBe('globe');
    expect(faviconPlaceholder('http://192.168.1.4/admin').kind).toBe('globe');
  });

  it('localhost invece una lettera ce l ha', () => {
    const p = faviconPlaceholder('http://localhost:5173');
    expect(p.kind).toBe('monogram');
    expect(p.letter).toBe('L');
  });

  it('il colore è una stringa hsl valida', () => {
    expect(faviconPlaceholderColor(200)).toBe('hsl(200 48% 42%)');
  });
});
