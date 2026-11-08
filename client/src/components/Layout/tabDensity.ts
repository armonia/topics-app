export type TabDensityMode = 'full' | 'compact' | 'square' | 'scroll';

export interface TabDensityTab {
  naturalPx: number;
  active: boolean;
}

export interface TabDensityResult {
  mode: TabDensityMode;
  widths: number[];
}

const COMPACT_INACTIVE_MIN_PX = 76;
const COMPACT_ACTIVE_MIN_PX = 120;
const SQUARE_ACTIVE_MIN_PX = 96;

/** Choose stable tab widths from the strip's available space. */
export function tabDensity(
  availablePx: number,
  gapPx: number,
  tabHeightPx: number,
  tabs: readonly TabDensityTab[],
): TabDensityResult {
  if (tabs.length === 0) return { mode: 'full', widths: [] };

  const available = Math.max(0, Number.isFinite(availablePx) ? availablePx : 0);
  const gap = Math.max(0, Number.isFinite(gapPx) ? gapPx : 0);
  const height = Math.max(0, Number.isFinite(tabHeightPx) ? tabHeightPx : 0);
  const gapsTotal = gap * Math.max(0, tabs.length - 1);
  const natural = tabs.map(({ naturalPx }) => Math.max(0, Number.isFinite(naturalPx) ? naturalPx : 0));
  const totalNatural = natural.reduce((sum, width) => sum + width, 0);

  if (totalNatural + gapsTotal <= available) {
    if (tabs.length === 1) {
      return { mode: 'full', widths: [Math.min(available, Math.max(natural[0]!, height))] };
    }
    return { mode: 'full', widths: natural };
  }

  // One tab has nowhere else to give up space: let its active width continue
  // down to the square height instead of forcing an invisible overflow strip.
  if (tabs.length === 1) {
    const width = Math.min(natural[0]!, available);
    const mode = width < COMPACT_ACTIVE_MIN_PX ? 'square' : 'compact';
    return { mode, widths: [width] };
  }

  const floors = tabs.map(({ active }) => active ? COMPACT_ACTIVE_MIN_PX : COMPACT_INACTIVE_MIN_PX);
  const compactMinimum = floors.reduce((sum, width) => sum + width, 0) + gapsTotal;

  if (compactMinimum <= available) {
    const widths = natural.map((width, index) => Math.max(width, floors[index]!));
    let remainingShrink = widths.reduce((sum, width) => sum + width, 0) - (available - gapsTotal);
    let shrinkable = widths
      .map((_, index) => index)
      .filter((index) => widths[index]! > floors[index]!);

    while (remainingShrink > 0.001 && shrinkable.length > 0) {
      const equalShare = remainingShrink / shrinkable.length;
      let applied = 0;
      const next: number[] = [];
      for (const index of shrinkable) {
        const reduction = Math.min(equalShare, widths[index]! - floors[index]!);
        widths[index] = roundWidth(widths[index]! - reduction);
        applied += reduction;
        if (widths[index]! > floors[index]! + 0.001) next.push(index);
      }
      remainingShrink -= applied;
      shrinkable = next;
      if (applied <= 0.001) break;
    }

    return { mode: 'compact', widths };
  }

  const activeIndex = tabs.findIndex(({ active }) => active);
  const squareWidths = tabs.map((_, index) => index === activeIndex
    ? SQUARE_ACTIVE_MIN_PX
    : height);
  const squareMinimum = squareWidths.reduce((sum, width) => sum + width, 0) + gapsTotal;

  if (squareMinimum > available) return { mode: 'scroll', widths: squareWidths };

  const inactiveSquares = squareWidths.reduce((sum, width, index) => sum + (index === activeIndex ? 0 : width), 0);
  if (activeIndex >= 0) {
    const activeWidth = Math.min(
      Math.max(natural[activeIndex]!, SQUARE_ACTIVE_MIN_PX),
      Math.max(SQUARE_ACTIVE_MIN_PX, available - gapsTotal - inactiveSquares),
    );
    squareWidths[activeIndex] = activeWidth;
  }
  return { mode: 'square', widths: squareWidths };
}

function roundWidth(width: number): number {
  return Math.round(width * 100) / 100;
}
