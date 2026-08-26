/**
 * La riscrittura del meta viewport.
 *
 * È l'unico comando che Safari accetta per riportare a 1 una pagina rimasta
 * scalata after il focus su un campo. Il rischio non è lo zoom: è tutto il
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
  // DUE garanzie diverse, e servono tutte e due.
  //
  // La before e' sul HELPER: qualunque direttiva ci sia sulla riga vera, deve
  // ritrovarsi identica after la riscrittura. Si DERIVA da `REAL`, cosi' una
  // direttiva aggiunta domani e' presidiata senza che nessuno tocchi questo file.
  //
  // La seconda e' su `index.html`: le due directives che decidono come l'app si
  // dispone sotto il notch e sotto la tastiera sono scritte a mano, perche' qui
  // il punto NON e' che l'helper le conservi — e' che ci siano. Derivarle
  // renderebbe il controllo cieco proprio al guasto che deve prendere.
  //
  // `user-scalable=no` stava nel secondo elenco e ne e' uscito il 26/08
  // (`d4bcd2771`): axe-core lo segnala perche' impedire lo zoom e' una
  // violazione di accessibilita', e toglierlo e' stato giusto. Con lui e'
  // sparito anche `maximum-scale` dalla riga di partenza, quindi l'helper ora
  // lo AGGIUNGE invece di sostituirlo — ed e' il ramo che gia' prevedeva.
  const directives = (c: string) => c.split(',').map((p) => p.trim()).filter(Boolean);

  test('non perde nessuna direttiva di quelle che ci sono davvero', () => {
    const out = withMaximumScale(REAL, '10.0');
    expect(out).toContain('maximum-scale=10.0');
    for (const keep of directives(REAL)) {
      if (/^maximum-scale\s*=/.test(keep)) continue;
      expect(out).toContain(keep);
    }
  });

  test('index.html tiene le directives che decidono il layout', () => {
    for (const keep of ['width=device-width', 'initial-scale=1.0', 'interactive-widget=overlays-content', 'viewport-fit=cover']) {
      expect(REAL, `client/index.html ha perso ${keep}: non e' zoom, e' come l'app si dispone`).toContain(keep);
    }
  });

  test('l\'ordine delle directives di partenza resta quello, e la nuova va in coda', () => {
    const out = withMaximumScale(REAL, '10.0');
    const before = directives(REAL).map((p) => p.split('=')[0]!.trim());
    const after = directives(out).map((p) => p.split('=')[0]!.trim());
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(before.includes('maximum-scale') ? [] : ['maximum-scale']);
  });

  test('andata e ritorno lasciano intatto tutto quello che c\'era', () => {
    const roundTrip = withMaximumScale(withMaximumScale(REAL, '10.0'), '1.0');
    // La riga non torna IDENTICA, e non deve: `maximum-scale` non c'e' piu' sul
    // meta vero, quindi il primo giro lo aggiunge. Cio' che deve tornare intatto
    // e' tutto il resto, nell'ordine.
    expect(directives(roundTrip).filter((p) => !/^maximum-scale\s*=/.test(p))).toEqual(
      directives(REAL).filter((p) => !/^maximum-scale\s*=/.test(p)),
    );
    expect(roundTrip).toContain('maximum-scale=1.0');
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
