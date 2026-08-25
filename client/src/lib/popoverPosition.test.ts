/**
 * @covers GESTURE-05
 */
import { describe, test, expect } from 'bun:test';
import { computeMenuPosition } from './popoverPosition';

// Fixed viewport so the math is deterministic without a DOM.
const vp = { viewportWidth: 1000, viewportHeight: 800 };

test('opens below-left, gapped, when it fits', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 200, right: 260 }, { width: 150, height: 200 }, vp);
  expect(r.placement).toBe('below');
  expect(r.top).toBe(124); // anchor.bottom + gap(4)
  expect(r.left).toBe(200); // anchor.left
});

test('flips above when there is no room below', () => {
  const r = computeMenuPosition({ top: 700, bottom: 760, left: 200, right: 260 }, { width: 150, height: 200 }, vp);
  expect(r.placement).toBe('above');
  expect(r.top).toBe(496); // anchor.top - height - gap = 700 - 200 - 4
});

test('clamps against the right viewport edge', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 950, right: 990 }, { width: 150, height: 100 }, vp);
  expect(r.left).toBe(842); // vw - width - margin = 1000 - 150 - 8
});

test('align=right pins the menu right edge to the trigger', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 500, right: 600 }, { width: 150, height: 100 }, { ...vp, align: 'right' });
  expect(r.left).toBe(450); // anchor.right - width = 600 - 150
});

test('align=right near the left edge clamps to the left margin', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 4, right: 40 }, { width: 150, height: 100 }, { ...vp, align: 'right' });
  expect(r.left).toBe(8); // right-aligned would be -110 → clamp to margin
});

test('a menu wider than the viewport pins to the left margin', () => {
  const r = computeMenuPosition({ top: 100, bottom: 120, left: 50, right: 90 }, { width: 2000, height: 100 }, vp);
  expect(r.left).toBe(8);
});

describe('il tetto d\'altezza', () => {
  // La meta' che mancava, e senza la quale il flip non basta: con poco spazio
  // da entrambi i lati, ribaltare sceglie il lato meno peggio e taglia lo
  // stesso. Il difetto vero: le tendine dei rami ricavavano il tetto dallo
  // spazio SOTTO il bottone, e con le sezioni della barra collassate sotto ne
  // restavano 33px — cioe' 21 di tetto contro un'intestazione di lista da
  // 24,5: ZERO righe visibili.
  test('sotto il trigger c\'e posto: il tetto e lo spazio che resta', () => {
    const p = computeMenuPosition({ top: 100, right: 200, bottom: 130, left: 100 }, { width: 200, height: 300 }, vp);
    expect(p.placement).toBe('below');
    // 800 - 8 (margine) - (130 + 4) = 658
    expect(p.maxHeight).toBe(658);
  });

  test('il menu non scende MAI sotto il minimo, per stretto che sia lo spazio', () => {
    // Il trigger e' a 33px dal fondo: sotto ci sono 21px. Prima era il tetto;
    // ora e' il pavimento a decidere, e il menu scorre.
    const p = computeMenuPosition({ top: 737, right: 200, bottom: 767, left: 100 }, { width: 200, height: 300 }, vp);
    expect(p.maxHeight).toBeGreaterThanOrEqual(160);
  });

  test('il minimo e un PAVIMENTO, non un tetto: sopra, vince lo spazio vero', () => {
    // Con 725px liberi sopra, `minHeight: 240` non deve rimpicciolire niente.
    const largo = computeMenuPosition(
      { top: 737, right: 200, bottom: 767, left: 100 },
      { width: 200, height: 300 },
      { ...vp, minHeight: 240 },
    );
    expect(largo.maxHeight).toBe(725);

    // In una finestra bassa lo spazio vero e' meno del minimo: li' il pavimento
    // si vede, e il menu scorre invece di ridursi a una fessura.
    const stretto = computeMenuPosition(
      { top: 130, right: 200, bottom: 160, left: 100 },
      { width: 200, height: 300 },
      { viewportWidth: 1000, viewportHeight: 300, minHeight: 240 },
    );
    expect(stretto.maxHeight).toBe(240);
  });

  test('il tetto non supera mai la finestra meno i due margini', () => {
    const p = computeMenuPosition({ top: 0, right: 200, bottom: 0, left: 100 }, { width: 200, height: 50 }, vp);
    expect(p.maxHeight).toBeLessThanOrEqual(800 - 16);
  });

  test('ribaltando, il tetto e quello del lato SCELTO', () => {
    // Poco sotto (100px) e molto sopra (600): ribalta, e il tetto e' quello
    // sopra, non quello sotto.
    const p = computeMenuPosition({ top: 692, right: 200, bottom: 700, left: 100 }, { width: 200, height: 300 }, vp);
    expect(p.placement).toBe('above');
    expect(p.maxHeight).toBeGreaterThan(300);
  });
});
