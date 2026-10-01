/**
 * THE RAIL OF MOTION-04: a floating surface is built from the shared pieces,
 * so it enters and leaves like every other one.
 *
 * The motion of a menu, a popover, a dialog or a tooltip is not written per
 * component: the entrance rides on the shared styles (`POPOVER_SURFACE`,
 * `POPOVER_PANEL`, `POPOVER_SHEET`, `MODAL_OVERLAY`, `MODAL_BACKDROP`,
 * `MODAL_PAGE_CONTAINER`, or the `popover-enter` / `modal-backdrop-enter`
 * classes they carry) and the exit is `useExitGhost` (lib/exitGhost). A
 * surface that hand-rolls its card gets neither, and nothing shows it until
 * somebody watches it pop: the file tree's context menu and the floating
 * browser window's add menu were two such cards, found by reading the source.
 *
 * Two rules, read on the SOURCE (comments stripped, so a comment naming a
 * constant does not count as using it):
 *  1. A file that puts something on top of the page (a `createPortal`, a
 *     `role="menu"`, `"tooltip"` or `"dialog"`) takes its card from the shared
 *     styles or from a shared primitive (`Menu`, `ContextMenuPortal`, ...).
 *  2. A file that uses an entering surface style directly also gives it the
 *     shared exit, `useExitGhost`.
 * What is not a floating surface (a portal that moves a pane, a drag ghost, a
 * banner slot) is named below with the reason.
 *
 * @covers MOTION-04
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** The styles that carry the shared entrance. */
const ENTERING =
  /\b(?:POPOVER_SURFACE|POPOVER_PANEL|POPOVER_SHEET|MODAL_OVERLAY|MODAL_BACKDROP|MODAL_PAGE_CONTAINER)\b|(?<![\w-])(?:popover-enter|modal-backdrop-enter|bottom-sheet)(?![\w-])/;
/** The shared primitives that own both the entrance and the exit. */
const SHARED_PRIMITIVE =
  /<(?:Menu|DropdownPortal|ContextMenuPortal|SubmenuItem|Select|SuggestionMenu|ConfirmDialog|PresencePopover)\b/;
/** Something drawn on top of the page. */
const FLOATING = /createPortal\(|role=\{?["'](?:menu|tooltip|dialog|alertdialog)["']\}?/;
const EXIT = /\buseExitGhost\(/;

/**
 * Portals and roles that are not a surface that opens and closes. Each one
 * says why; a new entry needs the same.
 */
const NOT_A_FLOATING_SURFACE: Record<string, string> = {
  'components/Layout/PaneStage.tsx': 'moves a mounted pane into its cell, nothing opens',
  'components/Sidebar/PinnedTiles.tsx': 'the drag ghost under the pointer',
  'components/Shared/SidebarUpdateBanner.tsx': 'a status row portalled into its slot, in flow',
  'components/Browser/SelectElementOverlay.tsx': 'the highlight box that follows the picked element',
  'components/Browser/RemoteBrowserPanel.tsx': 'the screencast pane; its dialog is ForgetSiteDialog (ConfirmDialog)',
  'components/Project/ProjectSidebar.tsx':
    'the rail strip portalled into the tab bar; the phone drawer is a known gap with no shared slide-out yet',
};

/** Direct users of an entering style whose exit is not theirs to play. */
const EXIT_NOT_HERE: Record<string, string> = {};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(path);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [path] : [];
  });
}

interface SurfaceViolation {
  file: string;
  rule: 'hand-rolled surface' | 'no shared exit';
}

/** The two rules on a set of sources. Pure, so the planted case below proves it bites. */
function floatingSurfaceViolations(files: Array<{ file: string; text: string }>): SurfaceViolation[] {
  const out: SurfaceViolation[] = [];
  for (const { file, text } of files) {
    const code = stripComments(text);
    const entering = ENTERING.test(code);
    if (FLOATING.test(code) && !entering && !SHARED_PRIMITIVE.test(code) && !(file in NOT_A_FLOATING_SURFACE)) {
      out.push({ file, rule: 'hand-rolled surface' });
    }
    if (entering && !EXIT.test(code) && !(file in EXIT_NOT_HERE)) {
      out.push({ file, rule: 'no shared exit' });
    }
  }
  return out;
}

function clientSources(): Array<{ file: string; text: string }> {
  return sources(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }));
}

describe('floating surfaces (MOTION-04)', () => {
  test('every floating surface in the client is built from the shared pieces', () => {
    expect(floatingSurfaceViolations(clientSources())).toEqual([]);
  });

  test('every allowlisted file still exists and still needs its entry', () => {
    const byFile = new Map(clientSources().map((s) => [s.file, stripComments(s.text)]));
    for (const file of Object.keys(NOT_A_FLOATING_SURFACE)) {
      const code = byFile.get(file);
      expect({ file, exists: code !== undefined }).toEqual({ file, exists: true });
      // Still flagged without its entry: an entry nobody needs is a hole for the next one.
      const needsEntry = FLOATING.test(code ?? '') && !ENTERING.test(code ?? '') && !SHARED_PRIMITIVE.test(code ?? '');
      expect({ file, needsEntry }).toEqual({ file, needsEntry: true });
    }
  });

  test('the rule bites: a hand-rolled menu and a surface without an exit are both named', () => {
    const planted = [
      {
        file: 'components/Planted/HandRolledMenu.tsx',
        text: `export const M = () => createPortal(<div role="menu" className="fixed rounded-md bg-surface shadow-lg" />, document.body);`,
      },
      {
        file: 'components/Planted/NoExit.tsx',
        text: `export const P = () => <div className={\`fixed \${POPOVER_PANEL}\`} />;`,
      },
      {
        file: 'components/Planted/Commented.tsx',
        // A constant named in a comment is not a constant used.
        text: `// POPOVER_SURFACE and useExitGhost(ref, open)\nexport const C = () => createPortal(<div role="tooltip" />, document.body);`,
      },
      {
        file: 'components/Planted/Fine.tsx',
        text: `useExitGhost(ref, open);\nexport const F = () => createPortal(<div ref={ref} className={POPOVER_SURFACE} role="menu" />, document.body);`,
      },
    ];
    expect(floatingSurfaceViolations(planted)).toEqual([
      { file: 'components/Planted/HandRolledMenu.tsx', rule: 'hand-rolled surface' },
      { file: 'components/Planted/NoExit.tsx', rule: 'no shared exit' },
      { file: 'components/Planted/Commented.tsx', rule: 'hand-rolled surface' },
    ]);
  });
});
