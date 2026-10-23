/**
 * What one streamed chunk makes React do, counted in WORK and not in time.
 *
 * Milliseconds depend on the machine and on what else it is running; the work
 * does not. Two numbers per chunk:
 *   - `fibers`       components whose render function ran
 *   - `parsedChars`  characters handed to a markdown parser (a `<ReactMarkdown>`
 *                    that rendered, summed over its `children`)
 * A client that parses the whole message for every token reports a number that
 * grows with the message; one that parses only the block being written reports
 * the same number on a short message and on a long one.
 *
 * HOW REACT IS OBSERVED, as in `react-commit-probe.ts`: a minimal
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` installed before the bundle, which React
 * calls on every commit, in the production bundle too. A fiber rendered when it
 * is new or carries `PerformedWork`; a fiber whose `child` is still its
 * alternate's child was not reconciled, so nothing under it rendered. Markdown
 * is found by the shape of its props (`remarkPlugins` and a string `children`),
 * because a release bundle has no component names.
 */
import type { Page } from "@playwright/test";

/** How long without a commit means the chunk has been absorbed. */
const QUIET_MS = 200;

export interface ChunkWork {
  commits: number;
  fibers: number;
  parsedChars: number;
}

interface ProbeWindow {
  __streamWork: ChunkWork & { on: boolean };
}

export async function installStreamWorkProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = {
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedProps: Record<string, unknown> | null;
    };
    const probe = { on: false, commits: 0, fibers: 0, parsedChars: 0 };
    (window as unknown as ProbeWindow).__streamWork = probe;
    // Function, class, forwardRef, memo, simple memo: the tags whose render function runs.
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
    const PERFORMED_WORK = 1;
    const walk = (rootFiber: Fiber): void => {
      const stack: Fiber[] = [rootFiber];
      while (stack.length > 0) {
        const fiber = stack.pop()!;
        const fresh = fiber.alternate === null;
        if (COMPONENT_TAGS.has(fiber.tag) && (fresh || (fiber.flags & PERFORMED_WORK) !== 0)) {
          probe.fibers += 1;
          const props = fiber.memoizedProps;
          if (props !== null && "remarkPlugins" in props && typeof props["children"] === "string") {
            probe.parsedChars += props["children"].length;
          }
        }
        if (fresh || fiber.child !== fiber.alternate!.child) {
          for (let c = fiber.child; c; c = c.sibling) stack.push(c);
        }
      }
    };
    const renderers = new Map<number, unknown>();
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: unknown) {
        const id = renderers.size + 1;
        renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        if (!probe.on) return;
        probe.commits += 1;
        walk(root.current);
      },
    };
  });
}

/** Start counting from zero. */
export async function beginChunk(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = (window as unknown as ProbeWindow).__streamWork;
    p.commits = 0;
    p.fibers = 0;
    p.parsedChars = 0;
    p.on = true;
  });
}

/**
 * Stop counting once the chunk has been absorbed: at least one commit, and then
 * no commit for `QUIET_MS`, so the trailing renders of the same chunk (a
 * deferred value catching up) are inside the window and the next chunk's are not.
 */
export async function endChunk(page: Page): Promise<ChunkWork> {
  return page.evaluate(async (quietMs) => {
    const p = (window as unknown as ProbeWindow).__streamWork;
    const started = performance.now();
    let seen = -1;
    let quietSince = started;
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const now = performance.now();
      if (p.commits !== seen) {
        seen = p.commits;
        quietSince = now;
      } else if (p.commits > 0 && now - quietSince >= quietMs) break;
      if (now - started > 15_000) throw new Error("stream probe: the chunk never produced a commit that settled");
    }
    p.on = false;
    return { commits: p.commits, fibers: p.fibers, parsedChars: p.parsedChars };
  }, QUIET_MS);
}
