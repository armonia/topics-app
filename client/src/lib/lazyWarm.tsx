/**
 * A lazy component that renders SYNCHRONOUSLY once its chunk is warm.
 *
 * `React.lazy` suspends on the first mount no matter what: even when the chunk
 * is already in the module cache, the factory's `import()` settles in a
 * microtask, the boundary commits its fallback, and the real body only lands on
 * the retry. Measured 2026-09-05 on the desktop's real state: every pane chunk
 * had been requested at 110 ms and was cached, the shell painted at 224 ms, and
 * the three tiles of the project windows still drew a spinner for 136 ms - the
 * length of the boot's own render work, not of any download.
 *
 * `warm` runs a loader and remembers the module it resolved to. `lazyWarm`
 * reads that memory at mount: a warm module renders in the same pass as its
 * parent, with no boundary in between; a cold one falls back to `React.lazy`,
 * which is exactly what a pane you had never opened did before. The decision
 * is taken ONCE per mounted instance, so a chunk that warms while an instance
 * is on the lazy path never swaps component type under it (that would remount
 * the pane and lose its state).
 */
import { lazy, useState, type ComponentType } from 'react';

type Loader<M> = () => Promise<M>;

/** Loader -> the module it resolved to. Keyed by identity: share the loader. */
const resolved = new WeakMap<Loader<unknown>, unknown>();

/** Run `loader` and remember its module, so `lazyWarm` can skip the boundary. */
export function warm<M>(loader: Loader<M>): Promise<M> {
  const pending = loader();
  pending.then((module) => { resolved.set(loader as Loader<unknown>, module); }).catch(() => {});
  return pending;
}

/** The module `loader` resolved to, if `warm` has already seen it settle. */
export function warmed<M>(loader: Loader<M>): M | undefined {
  return resolved.get(loader as Loader<unknown>) as M | undefined;
}

/**
 * `lazy(() => loader().then(m => ({ default: pick(m) })))`, except that an
 * instance mounted AFTER the chunk warmed renders `pick(module)` directly.
 */
export function lazyWarm<M, P extends object>(loader: Loader<M>, pick: (module: M) => ComponentType<P>): ComponentType<P> {
  const Lazy = lazy(() => loader().then((module) => ({ default: pick(module) })));
  function Warmed(props: P) {
    const [Body] = useState<ComponentType<P>>(() => {
      const module = warmed(loader);
      return module ? pick(module) : Lazy;
    });
    return <Body {...props} />;
  }
  return Warmed;
}
