/**
 * @covers TINT-01
 */
import { describe, expect, test } from 'bun:test';
import {
  pickSectorPalette, contrastRatio, fromHex, pickDominantColor, relativeLuminance, toHex, type RGB,
} from './iconTint';

/** Costruisce un blocco RGBA da una lista di pixel `[r,g,b,a]`. */
function pixels(...px: Array<[number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(px.flat());
}

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

describe('pickDominantColor', () => {
  test('trova il colore del marchio anche sepolto nel bianco', () => {
    // Un logo tipico: quasi tutto sfondo bianco, un accento rosso.
    const white: [number, number, number, number] = [255, 255, 255, 255];
    const red: [number, number, number, number] = [220, 38, 38, 255];
    const data = pixels(...Array(60).fill(white), ...Array(4).fill(red));
    const got = pickDominantColor(data);
    expect(got).not.toBeNull();
    expect(got!.r).toBeGreaterThan(180);
    expect(got!.g).toBeLessThan(80);
  });

  test('ignora i pixel trasparenti', () => {
    const ghost: [number, number, number, number] = [0, 200, 0, 10]; // verde ma invisibile
    const blue: [number, number, number, number] = [40, 90, 220, 255];
    const got = pickDominantColor(pixels(...Array(20).fill(ghost), blue));
    expect(got).not.toBeNull();
    expect(got!.b).toBeGreaterThan(got!.g);
  });

  test('icona monocroma (solo bianco e nero) → nessuna tinta', () => {
    const data = pixels(
      [255, 255, 255, 255], [0, 0, 0, 255], [250, 250, 250, 255], [10, 10, 10, 255],
    );
    expect(pickDominantColor(data)).toBeNull();
  });

  test('icona vuota o tutta trasparente → nessuna tinta', () => {
    expect(pickDominantColor(new Uint8ClampedArray(0))).toBeNull();
    expect(pickDominantColor(pixels([200, 30, 30, 0], [30, 200, 30, 0]))).toBeNull();
  });

  test('i grigi non contano come identità', () => {
    expect(pickDominantColor(pixels(...Array(30).fill([128, 130, 132, 255] as [number, number, number, number])))).toBeNull();
  });

  test('lo spicchio più pesante vince, non il primo che passa', () => {
    const orange: [number, number, number, number] = [240, 140, 20, 255];
    const violet: [number, number, number, number] = [140, 60, 220, 255];
    const got = pickDominantColor(pixels(violet, ...Array(15).fill(orange)));
    expect(got).not.toBeNull();
    expect(got!.r).toBeGreaterThan(got!.b); // arancio, non viola
  });

  test('è deterministico', () => {
    const data = pixels([220, 38, 38, 255], [255, 255, 255, 255], [40, 90, 220, 255], [220, 38, 38, 255]);
    expect(pickDominantColor(data)).toEqual(pickDominantColor(data));
  });
});

describe('hex round-trip', () => {
  test('toHex/fromHex si annullano', () => {
    for (const hex of ['#000000', '#ffffff', '#0066ff', '#8b5cf6']) {
      expect(toHex(fromHex(hex)!)).toBe(hex);
    }
  });

  test('forma corta e input storti', () => {
    expect(fromHex('#0af')).toEqual(rgb(0, 170, 255));
    expect(fromHex('non-un-colore')).toBeNull();
    expect(fromHex('#12345')).toBeNull();
  });

  test('toHex satura invece di sbordare', () => {
    expect(toHex(rgb(-20, 300, 128.6))).toBe('#00ff81');
  });
});

describe('luminanza e contrasto', () => {
  test('usa la spezzata sRGB, non pow(2.2)', () => {
    // A #808080 la spezzata dà ~0.2159; pow(2.2) darebbe ~0.2158... la differenza
    // che conta è più in basso: a #0a0a0a la spezzata è ~0.00304, pow(2.2) ~0.00133.
    const dark = relativeLuminance(rgb(10, 10, 10));
    const naive = Math.pow(10 / 255, 2.2);
    expect(dark).toBeGreaterThan(naive * 2);
  });

  test('bianco e nero sono i due estremi', () => {
    expect(relativeLuminance(rgb(255, 255, 255))).toBeCloseTo(1, 6);
    expect(relativeLuminance(rgb(0, 0, 0))).toBeCloseTo(0, 6);
    expect(contrastRatio(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 4);
  });

  test('il contrasto è simmetrico', () => {
    const a = rgb(0x18, 0x1b, 0x21);
    const b = rgb(0xff, 0xff, 0xff);
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 9);
  });
});

describe('pickSectorPalette — il colore va dove sta', () => {
  /** Un'icona `size`×`size` dipinta da una funzione (x,y) → [r,g,b,a]. */
  function paint(size: number, f: (x: number, y: number) => [number, number, number, number]) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b, a] = f(x, y);
        const i = (y * size + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
      }
    }
    return data;
  }

  test('metà sinistra blu, metà destra rossa → gli spicchi lo rispecchiano', () => {
    const size = 16;
    const data = paint(size, (x) => (x < size / 2 ? [40, 90, 220, 255] : [220, 40, 40, 255]));
    const pal = pickSectorPalette(data, size, 8);
    expect(pal).not.toBeNull();
    expect(pal!.length).toBe(8);
    // Spicchio 2 = ore 3 (destra) → rosso. Spicchio 6 = ore 9 (sinistra) → blu.
    const right = fromHex(pal![2])!;
    const left = fromHex(pal![6])!;
    expect(right.r).toBeGreaterThan(right.b);
    expect(left.b).toBeGreaterThan(left.r);
  });

  test('metà alta verde, metà bassa gialla → sopra e sotto si distinguono', () => {
    const size = 16;
    const data = paint(size, (_x, y) => (y < size / 2 ? [30, 190, 90, 255] : [240, 200, 40, 255]));
    const pal = pickSectorPalette(data, size, 8)!;
    const top = fromHex(pal[0])!;      // ore 12
    const bottom = fromHex(pal[4])!;   // ore 6
    expect(top.g).toBeGreaterThan(top.r);
    expect(bottom.r).toBeGreaterThan(bottom.b);
  });

  test('icona monocroma o trasparente → nessuna palette', () => {
    const size = 8;
    expect(pickSectorPalette(paint(size, () => [255, 255, 255, 255]), size)).toBeNull();
    expect(pickSectorPalette(paint(size, () => [200, 30, 30, 0]), size)).toBeNull();
  });

  test('uno spicchio vuoto eredita il vicino invece di spegnersi', () => {
    // Un solo pixel colorato: tutti gli spicchi devono comunque avere un colore.
    const size = 16;
    const data = paint(size, (x, y) => (x === 2 && y === 2 ? [220, 40, 40, 255] : [255, 255, 255, 255]));
    const pal = pickSectorPalette(data, size, 8);
    expect(pal).not.toBeNull();
    expect(pal!.length).toBe(8);
    for (const c of pal!) expect(fromHex(c)).not.toBeNull();
  });

  test('è deterministica', () => {
    const size = 16;
    const data = paint(size, (x) => (x < 8 ? [40, 90, 220, 255] : [220, 40, 40, 255]));
    expect(pickSectorPalette(data, size, 8)).toEqual(pickSectorPalette(data, size, 8));
  });
});
