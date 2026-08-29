/**
 * @covers LAYOUT-25
 */
import { describe, expect, it } from 'bun:test';
import { PANE_TYPES, type PaneType } from '../state/pane/types';
import {
  AA_TEXT,
  CHROME_BAR_SURFACES,
  paneTypesWithoutSurface,
  surfaceForPaneType,
} from './chromeBarSurfaces';
import { paneCellBg } from './paneCellBg';

/**
 * THE INVENTORY IS THE SOURCE, AND THESE ARE THE PROPERTIES THAT KEEP IT ONE.
 *
 * The table replaced a paragraph. A paragraph rots quietly; a table rots the
 * moment somebody adds a pane type and forgets it, and that is what these cases
 * are for. They check three things a comment could never check: that the list
 * COVERS every pane type, that a pane belongs to exactly ONE family, and that an
 * exception carries either a measurement or a written reason why it cannot have
 * one - never a silent null.
 */
describe('CHROME_BAR_SURFACES', () => {
  it('covers every pane type, so a new one cannot inherit a backdrop by accident', () => {
    expect(paneTypesWithoutSurface()).toEqual([]);
  });

  it('assigns each pane type to exactly one family', () => {
    const seen = new Map<PaneType, string>();
    const doubles: string[] = [];
    for (const surface of CHROME_BAR_SURFACES) {
      for (const type of surface.paneTypes) {
        const owner = seen.get(type);
        if (owner) doubles.push(`${type}: ${owner} + ${surface.id}`);
        else seen.set(type, surface.id);
      }
    }
    expect(doubles).toEqual([]);
  });

  it('lists no pane type that does not exist', () => {
    const known = new Set<string>(PANE_TYPES);
    const ghosts = CHROME_BAR_SURFACES.flatMap((s) => s.paneTypes.filter((t) => !known.has(t)));
    expect(ghosts).toEqual([]);
  });

  /**
   * ONE surface passes under the glass, and the count is the assertion. The
   * overlay effect belongs to the transcript alone (`.chat-under-chrome`); a
   * second family claiming it here without the CSS to back it would be the
   * table describing an app that does not exist.
   */
  it('has the chat as the only surface whose content rises behind the glass', () => {
    const under = CHROME_BAR_SURFACES.filter((s) => s.scrollsUnderChrome).map((s) => s.id);
    expect(under).toEqual(['chat']);
  });

  /**
   * The point of the whole card: an exception is a row with a NUMBER next to
   * it, or a row that says out loud why the number cannot exist. "Where
   * possible" stops being an adjective exactly here.
   */
  it('never declares an exception without either a measurement or a stated reason', () => {
    const silent = CHROME_BAR_SURFACES.filter((s) => !s.contrast && !s.unmeasurable).map((s) => s.id);
    expect(silent).toEqual([]);
  });

  it('measures every surface the e2e sweep can actually open', () => {
    const missing = CHROME_BAR_SURFACES.filter((s) => s.probe && !s.contrast).map((s) => s.id);
    expect(missing).toEqual([]);
  });

  it('holds WCAG AA in both themes wherever it has a reading', () => {
    for (const surface of CHROME_BAR_SURFACES) {
      if (!surface.contrast) continue;
      expect(surface.contrast.dark, `${surface.id} dark`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(surface.contrast.light, `${surface.id} light`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  /**
   * The recorded spread is the numeric form of the flag right above it, so the
   * two cannot be allowed to disagree in the table itself: a row that claims
   * nothing passes under and records a moving backdrop is a row somebody edited
   * halfway. The live check is the e2e sweep; this one stops the table from
   * shipping self-contradictory.
   */
  it('records a backdrop spread that agrees with its own passes-under flag', () => {
    for (const surface of CHROME_BAR_SURFACES) {
      if (!surface.contrast) continue;
      const moved = surface.contrast.spreadDark > 0 || surface.contrast.spreadLight > 0;
      expect(moved, `${surface.id} spread vs scrollsUnderChrome`).toBe(surface.scrollsUnderChrome);
    }
  });

  it('carries a reason and a dated source for each row', () => {
    for (const surface of CHROME_BAR_SURFACES) {
      expect(surface.why.length, `${surface.id} why`).toBeGreaterThan(40);
      if (surface.contrast) {
        expect(surface.contrast.measuredOn, `${surface.id} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(surface.contrast.measuredBy, `${surface.id} spec`).toContain('.spec.ts');
      }
    }
  });
});

/**
 * The tier a cell paints is now READ from the table, so this is the case that
 * proves the move changed nothing: the same answers as before, type by type.
 */
describe('paneCellBg reads the inventory', () => {
  it('keeps the browser pane in the frosted tier, with chat and kanban', () => {
    expect(paneCellBg('browser')).toBe('pane-frost');
    expect(paneCellBg('chat')).toBe('pane-frost');
    expect(paneCellBg('kanban')).toBe('pane-frost');
    expect(paneCellBg('board')).toBe('pane-frost');
  });

  it('leaves transparent the panes that paint their own chrome', () => {
    expect(paneCellBg('project')).toBe('');
    expect(paneCellBg('terminal')).toBe('');
  });

  it('keeps the opaque backdrop where the text is dense', () => {
    expect(paneCellBg('files')).toBe('bg-surface');
    expect(paneCellBg('dashboard')).toBe('bg-surface');
  });

  it('answers for every pane type, and always with the family tier', () => {
    for (const type of PANE_TYPES) {
      expect(paneCellBg(type)).toBe(surfaceForPaneType(type).cellBg);
    }
  });
});
