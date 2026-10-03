/**
 * THE BODY OF THE MODEL SELECTOR, LOADED WHEN SOMEBODY ASKS FOR IT.
 *
 * It is the content of a popover that opens on a click of the composer's model
 * chip, so nothing of it is on screen at first paint; as a static import of
 * `ProviderModelPicker` it sat in the eager entry with the runtime catalog
 * behind it (measured 2026-09-13: 5.9 KB raw of the entry chunk, arrived with
 * the two-level selector), paid by every session, including the ones that
 * never open the chip. The board already reaches the same module through its
 * own lazy chunks, so the split costs the task side nothing.
 *
 * `lazyWarm`, NOT `React.lazy`, and the chip opens only once the chunk is warm
 * (`loadModelList`): the shared `Menu` focuses its panel as soon as it is
 * placed, and a panel that holds a Suspense fallback at that moment has no rows
 * for the arrow keys to reach. `tests/e2e/picker-keyboard-nav.spec.ts` presses
 * ArrowDown right after the panel takes the focus. Warmed on hover and on focus
 * of the chip, the wait is normally already over by the click.
 *
 * WHY A MODULE OF ITS OWN: a file that exports both components and plain
 * functions loses fast refresh (`react-refresh/only-export-components`).
 */
import type { ComponentProps, ComponentType } from 'react';
import { lazyWarm, warm, warmed } from '@/lib/lazyWarm';
import { reimportChunk } from '@/lib/chunkReloadGuard';
// Type-only: erased from the output, so the module stays out of this chunk.
import type { ModelList as Body } from './ModelList';

type MenuModule = typeof import('./ModelList');

// Destructured on purpose, not `() => import('./ModelList')`:
// knip reads a bare `import()` as opaque and every export of the module counts
// as used, so a dead export there would go blind (`check:deadcode-blindspots`).
// The second import is what makes "the next click tries again" true on WebKit,
// which otherwise keeps answering a failed chunk from memory: see
// `reimportChunk`. It must name the chunk file, i.e. this module's file name.
//
// Once the plain import has failed, every later call goes straight to the fresh
// URL. The plain one would only reject again from WebKit's memory, and Vite's
// preload helper announces that rejection (`vite:preloadError`) as a missing
// chunk: the reload prompt came back on the very click that then opened the
// menu, even after it had been dismissed.
let firstFailure: { error: unknown } | null = null;
const importModelList = async () => {
  if (!firstFailure) {
    try {
      const { ModelList: Component } = await import('./ModelList');
      return { ModelList: Component };
    } catch (error) {
      firstFailure = { error };
    }
  }
  const { ModelList: Component } = await reimportChunk<MenuModule>('ModelList', firstFailure.error);
  return { ModelList: Component };
};

export const ModelList: ComponentType<ComponentProps<typeof Body>> = lazyWarm(
  importModelList,
  (m) => m.ModelList,
);

let pending: Promise<unknown> | null = null;

/** Start loading the menu chunk; the same promise for every caller. A failed
 *  load is reported by `warm` (the reload prompt) and forgotten, so the next
 *  hover or click tries again. */
export function loadModelList(): Promise<unknown> {
  pending ??= warm(importModelList).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** True once the chunk has settled: the menu can then open in the same pass. */
export function modelListReady(): boolean {
  return warmed(importModelList) !== undefined;
}
