#!/usr/bin/env bun
/**
 * Regenerate `desktop-tauri/src-tauri/src/shortcuts_generated.rs` from the
 * shortcut registry (`shared/shortcuts.ts`). Run after editing the registry:
 *
 *     bun run gen:shortcuts
 *
 * `shared/shortcuts.test.ts` fails if the committed file drifts from the
 * registry, so CI catches a forgotten regen.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRustModule } from '../shared/shortcuts';

const out = join(import.meta.dir, '..', 'desktop-tauri', 'src-tauri', 'src', 'shortcuts_generated.rs');
writeFileSync(out, renderRustModule());
console.log(`wrote ${out}`);
