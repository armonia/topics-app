/**
 * ZERO CHANGES IS NOT A SURFACE.
 *
 * The two conditions that decide whether a git surface exists at all, read
 * apart from the components that use them: the sidebar section
 * (`hasGitStateToShow`) and the board card chip (`showsGitChangesChip`). The
 * asymmetry between them is the whole point and is what this file pins down: a
 * counted zero hides, an uncounted turn does not.
 *
 * @covers PROJECT-12
 */
import { describe, it, expect } from 'bun:test';
import { hasGitStateToShow, showsGitChangesChip } from '../../client/src/lib/gitVisibility';

describe('sidebar git section visibility', () => {
  it('hides a clean repository aligned with its upstream', () => {
    expect(hasGitStateToShow({ fileCount: 0, ahead: 0, behind: 0 })).toBe(false);
  });

  it('hides when there is no repository at all, or nothing read yet', () => {
    expect(hasGitStateToShow(null)).toBe(false);
    expect(hasGitStateToShow(undefined)).toBe(false);
  });

  it('shows as soon as one file changed', () => {
    expect(hasGitStateToShow({ fileCount: 1, ahead: 0, behind: 0 })).toBe(true);
  });

  it('shows on a divergence with no changed file: unpushed work is work', () => {
    expect(hasGitStateToShow({ fileCount: 0, ahead: 2, behind: 0 })).toBe(true);
    expect(hasGitStateToShow({ fileCount: 0, behind: 3, ahead: 0 })).toBe(true);
  });
});

describe('board card git chip visibility', () => {
  it('hides a delivery measured at zero files', () => {
    expect(showsGitChangesChip({ files: 0 })).toBe(false);
  });

  it('keeps the chip while nothing has been counted yet', () => {
    expect(showsGitChangesChip(null)).toBe(true);
  });

  it('keeps the chip on any non empty measure', () => {
    expect(showsGitChangesChip({ files: 1 })).toBe(true);
  });
});
