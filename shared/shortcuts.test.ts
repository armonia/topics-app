/**
 * The keyboard-shortcut registry, and the Rust module generated from it.
 *
 * @covers CMD-01, LAYOUT-41
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, MODIFIER_TOKENS, SHORTCUT_GROUPS, renderRustModule } from './shortcuts';

const GENERATED_RS = join(
  import.meta.dir,
  '..',
  'desktop-tauri',
  'src-tauri',
  'src',
  'shortcuts_generated.rs',
);

/** The two arms of the generated `match`, read back as the chars each lists.
 *  Reading the RENDERED module (not the registry) is the point: it is the shape
 *  the native monitor and the Windows table actually consult. */
function generatedArms(): { always: string[]; shiftOnly: string[] } {
  const lines = renderRustModule().split('\n');
  const arm = (suffix: string) => lines.find(l => l.trimEnd().endsWith(suffix)) ?? '';
  const chars = (line: string) => [...line.matchAll(/"(.)"/g)].map(m => m[1]);
  return { always: chars(arm('=> true,')), shiftOnly: chars(arm('=> shift,')) };
}

describe('shortcut registry', () => {
  // THE divergence guard. The user-facing list (rendered from SHORTCUT_GROUPS)
  // and the native forwarding allowlist both come from this registry; the Rust
  // side is generated. If someone edits the registry and forgets
  // `bun run gen:shortcuts`, or hand-edits the generated file, this fails in CI
  // instead of the desktop silently swallowing (or the window lying about) a
  // chord.
  it('committed shortcuts_generated.rs matches the registry', () => {
    const onDisk = readFileSync(GENERATED_RS, 'utf8');
    expect(onDisk).toBe(renderRustModule());
  });

  it('has no duplicate descriptions (each row is a stable React key)', () => {
    const seen = new Set<string>();
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.shortcuts) {
        expect(seen.has(s.description)).toBe(false);
        seen.add(s.description);
      }
    }
  });


  it('no key is written as a Mac glyph: the registry speaks in tokens', () => {
    // The defect this guards: a glyph written here is printed VERBATIM by the
    // shortcuts window on every system, so on Windows the list names keys that
    // are not on the keyboard. Tokens are resolved per platform at render time
    // (`client/src/lib/shortcutLabel.ts`).
    const GLYPHS = ['\u2318', '\u21e7', '\u2325', '\u2303'];
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.shortcuts) {
        for (const k of [...s.keys, ...(s.alias ?? [])]) {
          for (const glyph of GLYPHS) expect(k.includes(glyph)).toBe(false);
        }
        // Same for the prose: an alias belongs in `alias`, not in the sentence.
        for (const glyph of GLYPHS) expect(s.description.includes(glyph)).toBe(false);
      }
    }
  });

  it('every modifier token is one the renderer knows', () => {
    const KNOWN = new Set<string>(MODIFIER_TOKENS);
    // A token the renderer does not know would pass through and be PRINTED as
    // itself: `Mod` on the screen instead of the key.
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.shortcuts) {
        for (const k of [...s.keys, ...(s.alias ?? [])]) {
          if (k === k.toUpperCase() && k.length > 2 && !KNOWN.has(k)) {
            expect(['Tab', 'Esc', '1-9']).toContain(k);
          }
        }
      }
    }
  });

  it('every shortcut has keys and a description', () => {
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.shortcuts) {
        expect(s.keys.length).toBeGreaterThan(0);
        expect(s.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('native chords are single lowercase chars (what the forwarder sees)', () => {
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.shortcuts) {
        if (!s.native) continue;
        expect(s.native.chars.length).toBeGreaterThan(0);
        for (const c of s.native.chars) {
          expect(c).toBe(c.toLowerCase());
          expect([...c].length).toBe(1);
        }
      }
    }
  });

  it('renders a valid Rust match with the generated header', () => {
    const rs = renderRustModule();
    expect(rs).toContain('// @generated');
    expect(rs).toContain('pub fn is_forwarded_cmd_chord');
    expect(rs).toContain('_ => false,');
  });

  // LAYOUT-41. The two tests above prove COHERENCE between the registry and the
  // committed `.rs`, never COVERAGE: drop `native` from the ⌘E rows and the
  // generator stops emitting 'e', the committed file matches again, and both
  // stay green while the chord dies exactly where it is needed — with focus
  // inside a native browser pane, i.e. "chat plus the browser the agent opened".
  // This case is the only one in the tree that names the chord, and the only
  // channel that DECLARES the requirement, since the coverage gate does not walk
  // `desktop-tauri/` and no `#[test]` there colours anything.
  it('the zoom chord is forwarded past a focused browser pane', () => {
    const { always, shiftOnly } = generatedArms();
    expect(always).toContain('e');
    // Not Shift-only: ⌘E carries no Shift, so a `requireShift` row would forward
    // nothing at all for the chord people actually type.
    expect(shiftOnly).not.toContain('e');
  });

  it('both zoom chords are declared, and both carry the forwarding flag', () => {
    const rows = SHORTCUT_GROUPS.flatMap(g => g.shortcuts).filter(
      s => s.keys.includes('E') && s.keys.includes(MOD),
    );
    // ⌘E and ⌥⌘E. The modifier twin stays in the registry (and therefore in the
    // window that lists the shortcuts) on every platform, even where the native
    // side cannot deliver it — that asymmetry is admitted in LAYOUT-40, not
    // papered over by dropping the row.
    expect(rows.map(r => r.keys.join('+')).sort()).toEqual(['Alt+Mod+E', 'Mod+E']);
    for (const r of rows) expect(r.native?.chars).toEqual(['e']);
  });
});
