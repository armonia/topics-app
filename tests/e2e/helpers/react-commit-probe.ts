/**
 * The React commit probe of split-reorg-budget.spec.ts (SPLITPERF-01): commits,
 * component renders per pane, and pane shells mounted again, per gesture.
 *
 * HOW REACT IS OBSERVED WITHOUT A SPECIAL BUILD. React calls
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` on every commit, in the
 * production bundle too: it is how the DevTools attach to any site. The init
 * script installs a minimal hook BEFORE the bundle, counts the commits and walks
 * the part of the fiber tree each commit actually touched (the same rule the
 * DevTools use: a fiber whose `child` is still its alternate's child was not
 * reconciled). No code of the app is compiled in for the test.
 */
import type { Page } from "@playwright/test";

interface ProbeWindow {
  __reorg: {
    on: boolean;
    commits: number;
    surfaceCommits: number;
    mounts: string[];
    renders: Record<string, number>;
    names: Record<string, number>;
  };
}

/**
 * The React commit probe. Installed before the bundle so React finds the hook
 * when it boots; everything it records is gated on `on`, so the boot costs
 * nothing and every number belongs to one gesture.
 */
export async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = {
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedProps: Record<string, unknown> | null;
    };
    const probe = {
      on: false,
      commits: 0,
      surfaceCommits: 0,
      mounts: [] as string[],
      renders: {} as Record<string, number>,
      names: {} as Record<string, number>,
    };
    (window as unknown as ProbeWindow).__reorg = probe;
    // Fiber tags of the components whose render function runs: function,
    // class, forwardRef, memo, simple memo.
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
    const HOST_COMPONENT = 5;
    const PERFORMED_WORK = 1;
    // Returns whether anything rendered INSIDE a tiling surface: a commit that
    // only touched the sidebar or the status bar is not the layout's.
    const walk = (rootFiber: Fiber): boolean => {
      let touchedSurface = false;
      const stack: Array<[Fiber, string, boolean]> = [[rootFiber, "layout", false]];
      while (stack.length > 0) {
        const [fiber, owner, underSurface] = stack.pop()!;
        const fresh = fiber.alternate === null;
        let key = owner;
        let inSurface = underSurface;
        if (fiber.tag === HOST_COMPONENT && fiber.memoizedProps?.["data-split-surface"] !== undefined) inSurface = true;
        if (fiber.tag === HOST_COMPONENT) {
          const shell = fiber.memoizedProps?.["data-pane-shell"];
          if (typeof shell === "string") {
            key = shell;
            if (fresh) probe.mounts.push(shell);
          }
        }
        if (COMPONENT_TAGS.has(fiber.tag) && (fresh || (fiber.flags & PERFORMED_WORK) !== 0)) {
          if (inSurface) touchedSurface = true;
          probe.renders[key] = (probe.renders[key] ?? 0) + 1;
          // The component's name, for the report only: minified in a release
          // bundle, readable in a build with `keepNames`.
          const t = (fiber as unknown as { type?: { displayName?: string; name?: string; type?: { name?: string }; render?: { name?: string } } }).type;
          const name = t?.displayName || t?.name || t?.type?.name || t?.render?.name || "?";
          const nk = `${key.split(":")[0]}|${name}`;
          probe.names[nk] = (probe.names[nk] ?? 0) + 1;
        }
        // A fiber whose children are still its alternate's children was not
        // reconciled in this commit: nothing under it rendered.
        if (fresh || fiber.child !== fiber.alternate!.child) {
          for (let c = fiber.child; c; c = c.sibling) stack.push([c, key, inSurface]);
        }
      }
      return touchedSurface;
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
        if (walk(root.current)) probe.surfaceCommits += 1;
      },
    };
  });
}

export interface GestureMarks {
  shells: string[];
}

/** Start counting, and mark every mounted pane shell so a replacement is visible in the DOM. */
export async function beginGesture(page: Page): Promise<GestureMarks> {
  return page.evaluate(() => {
    const p = (window as unknown as ProbeWindow).__reorg;
    p.commits = 0;
    p.surfaceCommits = 0;
    p.mounts = [];
    p.renders = {};
    p.names = {};
    p.on = true;
    const shells: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-pane-shell]"))) {
      (el as unknown as { __reorgMark?: boolean }).__reorgMark = true;
      shells.push(el.getAttribute("data-pane-shell") ?? "");
    }
    return { shells };
  });
}

export interface GestureResult {
  commits: number;
  /** Commits in which something inside a tiling surface rendered. */
  surfaceCommits: number;
  layoutRenders: number;
  paneRenders: number;
  /** Keys that existed before and were mounted again, as React saw it. */
  reactRemounts: string[];
  /** Keys whose shell node is no longer the one marked before, as the DOM sees it. */
  domRemounts: string[];
  /** Component renders per owner (pane shell key, or `layout`). */
  byOwner: Record<string, number>;
  /** The most rendered components, `<owner kind>|<name>` (diagnostic). */
  topNames: string;
}

export async function endGesture(page: Page, marks: GestureMarks): Promise<GestureResult> {
  return page.evaluate((before) => {
    const p = (window as unknown as ProbeWindow).__reorg;
    p.on = false;
    const existed = new Set(before);
    const reactRemounts = [...new Set(p.mounts.filter((k) => existed.has(k)))];
    const domRemounts: string[] = [];
    for (const key of before) {
      const el = document.querySelector(`[data-pane-shell="${CSS.escape(key)}"]`);
      // A pane that is gone was closed or evicted, not rebuilt: the gestures
      // below never close a pane they then count.
      if (el && !(el as unknown as { __reorgMark?: boolean }).__reorgMark) domRemounts.push(key);
    }
    let layoutRenders = 0;
    let paneRenders = 0;
    // A shell that HOSTS other shells (the project window inside the outer
    // grid) is layout: what renders in it is the project's own tiling.
    const hosts = new Set(
      Array.from(document.querySelectorAll("[data-pane-shell]"))
        .filter((el) => el.querySelector("[data-pane-shell]"))
        .map((el) => el.getAttribute("data-pane-shell")),
    );
    for (const [k, n] of Object.entries(p.renders)) {
      if (k === "layout" || hosts.has(k)) layoutRenders += n;
      else paneRenders += n;
    }
    return { commits: p.commits, surfaceCommits: p.surfaceCommits, layoutRenders, paneRenders, reactRemounts, domRemounts, byOwner: { ...p.renders },
      topNames: Object.entries(p.names)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k, n]) => `${k}:${n}`)
        .join(" "),
    };
  }, marks.shells);
}

/** How long no pane body may render before a measurement starts. */
export const QUIET_MS = 1000;

/**
 * Wait until no pane body has rendered for `QUIET_MS`, and return how long that
 * took and what rendered meanwhile. A gesture's window must hold only that
 * gesture's renders, and the gestures before the drag leave work in flight:
 * the chat's composer renders once more (22 components, ChatInput and its
 * menus, named in a `keepNames` build) about half a second after them. On an
 * idle Mac that echo landed before the drag started; on a loaded one it fell
 * inside it, and a drag that caused none of those renders was charged with
 * all 22. Rejects if the bodies never go quiet: a pane that renders non-stop
 * at rest is a failure of its own (IDLE-01).
 */
export async function settlePanes(page: Page): Promise<{ ms: number; renders: number; names: string }> {
  return page.evaluate(async (quietMs) => {
    const p = (window as unknown as ProbeWindow).__reorg;
    const hosts = new Set(
      Array.from(document.querySelectorAll("[data-pane-shell]"))
        .filter((el) => el.querySelector("[data-pane-shell]"))
        .map((el) => el.getAttribute("data-pane-shell")),
    );
    const bodyRenders = () =>
      Object.entries(p.renders).reduce((n, [k, v]) => (k === "layout" || hosts.has(k) ? n : n + v), 0);
    p.renders = {};
    p.names = {};
    p.on = true;
    const start = performance.now();
    let seen = 0;
    let quietSince = start;
    try {
      for (;;) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        const now = performance.now();
        const n = bodyRenders();
        if (n !== seen) {
          seen = n;
          quietSince = now;
        } else if (now - quietSince >= quietMs) {
          const names = Object.entries(p.names)
            .filter(([k]) => !k.startsWith("layout|") && !k.startsWith("project|"))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, v]) => `${k}:${v}`)
            .join(" ");
          return { ms: Math.round(now - start), renders: seen, names };
        }
        if (now - start > 30_000) throw new Error(`pane bodies still rendering after 30 s (${seen} renders)`);
      }
    } finally {
      p.on = false;
    }
  }, QUIET_MS);
}
