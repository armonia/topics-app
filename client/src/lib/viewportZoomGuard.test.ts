/**
 * La riscrittura del meta viewport.
 *
 * È l'unico comando che Safari accetta per riportare a 1 una pagina rimasta
 * scalata dopo il focus su un campo. Il rischio non è lo zoom: è tutto il
 * RESTO della riga — `viewport-fit=cover` e `interactive-widget` decidono come
 * l'app si dispone sotto il notch e sotto la tastiera, e perderli mentre si
 * corregge lo zoom sarebbe un guasto peggiore di quello che si sta chiudendo.
 *
 * Quindi qui si presidia che la sostituzione sia chirurgica. Il comportamento
 * vero di iOS (la scala che torna a 1) non è simulabile: si misura sul telefono.
  * @covers GESTURE-04
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { withMaximumScale } from './viewportZoomGuard';

/**
 * La riga vera, LETTA da client/index.html invece che ricopiata: è quella su cui
 * la guardia opera sul telefono, e una copia si sarebbe scollata al primo
 * ritocco del meta senza che nessun test se ne accorgesse.
 */
const REAL = (() => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf-8');
  const m = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
  if (!m) throw new Error('client/index.html non ha più un meta viewport: la guardia non ha su cosa agire');
  return m[1];
})();

describe('withMaximumScale', () => {
  test('cambia SOLO maximum-scale e non perde nessuna altra direttiva', () => {
    const out = withMaximumScale(REAL, '10.0');
    expect(out).toContain('maximum-scale=10.0');
    expect(out).not.toContain('maximum-scale=1.0');
    for (const keep of ['width=device-width', 'initial-scale=1.0', 'user-scalable=no', 'interactive-widget=overlays-content', 'viewport-fit=cover']) {
      expect(out).toContain(keep);
    }
  });

  test('l\'ordine delle direttive resta quello di partenza', () => {
    const out = withMaximumScale(REAL, '10.0');
    expect(out.split(', ').map((p) => p.split('=')[0])).toEqual(
      REAL.split(', ').map((p) => p.split('=')[0]),
    );
  });

  test('andata e ritorno riportano esattamente la riga originale', () => {
    expect(withMaximumScale(withMaximumScale(REAL, '10.0'), '1.0')).toBe(REAL);
  });

  test('se maximum-scale non c\'è, lo aggiunge invece di non fare niente', () => {
    const out = withMaximumScale('width=device-width, initial-scale=1.0', '1.0');
    expect(out).toBe('width=device-width, initial-scale=1.0, maximum-scale=1.0');
  });

  test('tollera spazi storti e una virgola finale senza generare pezzi vuoti', () => {
    const out = withMaximumScale('width=device-width ,  maximum-scale = 2 ,', '1.0');
    expect(out).toBe('width=device-width, maximum-scale=1.0');
  });

  test('non confonde initial-scale con maximum-scale', () => {
    const out = withMaximumScale('initial-scale=1.0, minimum-scale=1.0', '1.0');
    expect(out).toContain('initial-scale=1.0');
    expect(out).toContain('minimum-scale=1.0');
    expect(out).toContain('maximum-scale=1.0');
  });
});
