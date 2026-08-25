/**
 * The keyboard-shortcut registry, and the Rust module generated from it.
 *
 * @covers CMD-01
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORTCUT_GROUPS, renderRustModule } from './shortcuts';

const GENERATED_RS = join(
  import.meta.dir,
  '..',
  'desktop-tauri',
  'src-tauri',
  'src',
  'shortcuts_generated.rs',
);

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
});
