import type { ComponentType, ComponentProps } from 'react';

type CommandPaletteComponent = typeof import('../components/Shared/CommandPalette').CommandPalette;

// Shared factory so the idle prefetch (App mount) and the `lazy()` boundary
// resolve the SAME module, a first ⌘K then finds the chunk already parsed
// instead of paying a ~25-40ms synchronous fetch+eval on the opening frame
// (measured: cold open worst 41.7ms/1 frame >33ms; warmed open worst 9.4ms,
// 0 frames >16.7ms).
// The destructuring inside the `await` is not style: it is the only form in
// which the dead-code gate sees WHICH exports you use. An `import()` whose
// result does not end up in a `const { … } =` is opaque to knip, which assumes
// you use all of them and can no longer flag any of them as dead.
// Guard: `bun run check:deadcode-blindspots`.
export const importCommandPalette = async () => {
  const { CommandPalette: Component } = await import('../components/Shared/CommandPalette');
  loadedCommandPalette = Component;
  return { default: Component };
};

let loadedCommandPalette: ComponentType<ComponentProps<CommandPaletteComponent>> | null = null;

/** The palette component once the warm-up (or a first open) has loaded its chunk, else null. */
export const getLoadedCommandPalette = (): ComponentType<ComponentProps<CommandPaletteComponent>> | null => loadedCommandPalette;
