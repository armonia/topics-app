/**
 * THE RAIL OF CTXMENU-01: whoever takes the right-click away from the system
 * gives back the app's menu, built on the shared cursor menu.
 *
 * Taking the right-click is `preventDefault()` on a `contextmenu`. Done next to
 * an ad-hoc card, it buys a menu without the contract every other one has: no
 * flip at the edges (the file tree placed a GUESSED 200x320 box), no `role`
 * (the space menu was a loose div), no focus to go back to, and a right-click
 * on it opening the system menu on top. Four such menus were found by reading
 * the source; this file is what stops the fifth.
 *
 * The rule, read on the SOURCE with comments stripped: a file that takes the
 * gesture renders `<ContextMenuPortal` (components/Shared/ContextMenuPortal),
 * or names below the file that renders its menu (and that file must), or says
 * why it takes the gesture without opening a menu at all.
 *
 * "Takes the gesture" is any of:
 *  - an inline `onContextMenu={...}` whose body calls `preventDefault`;
 *  - a function whose name says context menu (`handleContextMenu`,
 *    `onContextMenu`, `handleTopicContextMenu`) and whose body does;
 *  - an `addEventListener('contextmenu', ...)` in a file that does.
 *
 * @covers CTXMENU-01
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');

const SHARED_MENU = /<ContextMenuPortal\b/;

/** Files that take the gesture and whose menu is rendered by another file. */
const MENU_RENDERED_BY: Record<string, string> = {
  // The topic row's handler lives in the panel hook; the menu App mounts is this one.
  'hooks/usePanelLifecycle.ts': 'components/Modals/ContextMenu.tsx',
  // The script injected into the embedded page answers the page's right-click;
  // what it saw comes back to the chrome as this menu.
  'components/Browser/paneContextModel.ts': 'components/Browser/PaneContextMenu.tsx',
};

/** Files that take the gesture on purpose and open no menu. Each says why. */
const NO_MENU_ON_PURPOSE: Record<string, string> = {
  'components/Browser/DomCoBrowse.tsx':
    'the right-click is forwarded to the shared remote page, which opens its own',
  'hooks/useTalkGesture.ts':
    'press-and-hold to talk: a long press on touch would otherwise raise the system callout under the finger',
  'lib/contextMenuOrigin.ts':
    'the shared mechanism itself: keyboard opening and the guard on open panels',
};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The text of the balanced `{...}` block that starts at `open` (an index of `{`). */
function block(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

/** Does this source take the right-click away from the system? */
function takesTheRightClick(code: string): boolean {
  // Inline attribute handlers.
  for (const m of code.matchAll(/onContextMenu=\{/g)) {
    const expr = block(code, m.index! + 'onContextMenu='.length);
    if (expr.includes('=>') && /\bpreventDefault\s*\(/.test(expr)) return true;
  }
  // Named handlers.
  for (const m of code.matchAll(/(?:const|let|function)\s+(\w*[Cc]ontext[Mm]enu\w*)\b/g)) {
    const open = code.indexOf('{', m.index!);
    if (open >= 0 && /\bpreventDefault\s*\(/.test(block(code, open))) return true;
  }
  // DOM listeners.
  return /addEventListener\(\s*['"]contextmenu['"]/.test(code) && /\bpreventDefault\s*\(/.test(code);
}

interface Violation {
  file: string;
  rule: 'takes the right-click without the shared menu' | 'its menu file does not use the shared menu';
}

/** The rule on a set of sources. Pure, so the planted case below proves it bites. */
function rightClickViolations(
  files: Array<{ file: string; text: string }>,
  renderedBy: Record<string, string> = MENU_RENDERED_BY,
  noMenu: Record<string, string> = NO_MENU_ON_PURPOSE,
): Violation[] {
  const byFile = new Map(files.map((f) => [f.file, stripComments(f.text)]));
  const out: Violation[] = [];
  for (const [file, code] of byFile) {
    if (!takesTheRightClick(code) || file in noMenu) continue;
    const menuFile = renderedBy[file];
    if (menuFile !== undefined) {
      if (!SHARED_MENU.test(byFile.get(menuFile) ?? '')) out.push({ file, rule: 'its menu file does not use the shared menu' });
      continue;
    }
    if (!SHARED_MENU.test(code)) out.push({ file, rule: 'takes the right-click without the shared menu' });
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path] : [];
  });
}

function clientSources(): Array<{ file: string; text: string }> {
  return sources(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }));
}

describe('right-click surfaces (CTXMENU-01)', () => {
  test('every file that takes the right-click opens the shared cursor menu', () => {
    expect(rightClickViolations(clientSources())).toEqual([]);
  });

  test('every listed file still exists and still takes the gesture', () => {
    const byFile = new Map(clientSources().map((s) => [s.file, stripComments(s.text)]));
    for (const file of [...Object.keys(MENU_RENDERED_BY), ...Object.keys(NO_MENU_ON_PURPOSE)]) {
      const code = byFile.get(file);
      // An entry nobody needs is a hole for the next one.
      expect({ file, exists: code !== undefined, takes: takesTheRightClick(code ?? '') }).toEqual({ file, exists: true, takes: true });
    }
    for (const menuFile of Object.values(MENU_RENDERED_BY)) {
      expect({ menuFile, exists: byFile.has(menuFile) }).toEqual({ menuFile, exists: true });
    }
  });

  test('the rule bites: hand-rolled menus are named, the shared one and the pass-through are not', () => {
    const planted = [
      {
        // An inline handler next to a hand-rolled card.
        file: 'components/Planted/InlineHandRolled.tsx',
        text: `export function R() { const [m, setM] = useState(null);
          return <div onContextMenu={(e) => { e.preventDefault(); setM({ x: e.clientX, y: e.clientY }); }}>
            {m && createPortal(<div role="menu" className="fixed glass-surface" />, document.body)}</div>; }`,
      },
      {
        // A named handler, the shape of the old file tree.
        file: 'components/Planted/NamedHandRolled.tsx',
        text: `const handleContextMenu = useCallback((e: React.MouseEvent, path: string) => {
            e.preventDefault(); setPos({ x: e.clientX, y: e.clientY }); }, []);
          export const T = () => <Row onContextMenu={e => handleContextMenu(e, 'a')} />;`,
      },
      {
        // A DOM listener.
        file: 'components/Planted/Listener.tsx',
        text: `useEffect(() => { el.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e); }); }, []);`,
      },
      {
        // A comment naming the shared menu does not count as using it.
        file: 'components/Planted/Commented.tsx',
        text: `// <ContextMenuPortal open />\nexport const C = () => <div onContextMenu={(e) => { e.preventDefault(); show(); }} />;`,
      },
      {
        // Delegated to a menu file that is hand-rolled.
        file: 'hooks/usePlanted.ts',
        text: `const handlePlantedContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); set(e); }, []);`,
      },
      { file: 'components/Planted/PlantedMenu.tsx', text: `export const P = () => createPortal(<div role="menu" />, document.body);` },
      {
        file: 'components/Planted/Fine.tsx',
        text: `export function F() { return <div onContextMenu={(e) => { e.preventDefault(); setM({ x: e.clientX, y: e.clientY }); }}>
          {m && <ContextMenuPortal open x={m.x} y={m.y} onClose={close} />}</div>; }`,
      },
      {
        // Passes the event up without taking it: the native menu is not touched here.
        file: 'components/Planted/PassThrough.tsx',
        text: `export const P = ({ onContextMenu }) => <div onContextMenu={onContextMenu} />;`,
      },
    ];
    expect(rightClickViolations(planted, { 'hooks/usePlanted.ts': 'components/Planted/PlantedMenu.tsx' }, {})).toEqual([
      { file: 'components/Planted/InlineHandRolled.tsx', rule: 'takes the right-click without the shared menu' },
      { file: 'components/Planted/NamedHandRolled.tsx', rule: 'takes the right-click without the shared menu' },
      { file: 'components/Planted/Listener.tsx', rule: 'takes the right-click without the shared menu' },
      { file: 'components/Planted/Commented.tsx', rule: 'takes the right-click without the shared menu' },
      { file: 'hooks/usePlanted.ts', rule: 'its menu file does not use the shared menu' },
    ]);
  });
});
