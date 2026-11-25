/**
 * Loads `playwright-core` for the server-side browser, installing it on first
 * use when the running server cannot resolve it.
 *
 * WHY: the compiled server sidecar marks `playwright-core` EXTERNAL (see
 * scripts/build-server-sidecar.sh), so a machine running the installed app has
 * no copy next to the binary. Every browser op there failed with "Cannot find
 * package 'playwright-core'" and an agent on such a node could not capture
 * anything. A checkout with `bun install` done resolves it the normal way and
 * never reaches the install branch.
 *
 * The package lives in `<app data>/browser-deps`, a folder the app owns, never
 * in the user's project. The install is single-flight and its failure is not
 * cached forever: the next call tries again.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAppDataDir } from "./data-dir";

/** Kept equal to the `playwright-core` range in package.json (a unit test checks it). */
export const PLAYWRIGHT_CORE_RANGE = "^1.59.1";

type PlaywrightCore = typeof import("playwright-core");

export interface PlaywrightLoaderDeps {
  /** The plain import, resolved from the server's own location. */
  importDefault: () => Promise<PlaywrightCore>;
  /** Import by absolute file URL, for the copy installed under the data dir. */
  importFrom: (fileUrl: string) => Promise<PlaywrightCore>;
  /** Installs the package into `dir`; resolves to the exit code. */
  install: (dir: string) => Promise<number>;
  depsDir: string;
  log: (msg: string) => void;
}

/** Entry file of the installed copy, or null when it is not there. */
function installedEntry(depsDir: string): string | null {
  const pkgDir = join(depsDir, "node_modules", "playwright-core");
  for (const file of ["index.mjs", "index.js"]) {
    const full = join(pkgDir, file);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * The package manager to run the install with. The compiled server IS bun, and
 * `BUN_BE_BUN=1` makes it behave as the bun CLI, so a node with nothing else
 * installed can still bootstrap itself. A `bun` or `npm` on PATH is the fallback.
 */
async function defaultInstall(dir: string): Promise<number> {
  const candidates: Array<{ argv: string[]; env: Record<string, string> }> = [
    { argv: [process.execPath, "add", `playwright-core@${PLAYWRIGHT_CORE_RANGE}`], env: { BUN_BE_BUN: "1" } },
    { argv: ["bun", "add", `playwright-core@${PLAYWRIGHT_CORE_RANGE}`], env: {} },
    { argv: ["npm", "install", "--no-audit", "--no-fund", `playwright-core@${PLAYWRIGHT_CORE_RANGE}`], env: {} },
  ];
  for (const { argv, env } of candidates) {
    try {
      const proc = Bun.spawn(argv, { // runtime-dep-ok: bootstrap of the server's own browser dependency
        cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
      });
      if ((await proc.exited) === 0) return 0;
    } catch {
      // Binary not found: try the next manager.
    }
  }
  return 1;
}

export function createPlaywrightLoader(overrides: Partial<PlaywrightLoaderDeps> = {}): () => Promise<PlaywrightCore> {
  const deps: PlaywrightLoaderDeps = {
    importDefault: () => import("playwright-core"),
    importFrom: (fileUrl) => import(/* @vite-ignore */ fileUrl),
    install: defaultInstall,
    depsDir: join(resolveAppDataDir(), "browser-deps"),
    log: (msg) => console.log(`[playwright-loader] ${msg}`),
    ...overrides,
  };
  let installing: Promise<PlaywrightCore> | null = null;

  async function installAndLoad(): Promise<PlaywrightCore> {
    let entry = installedEntry(deps.depsDir);
    if (!entry) {
      mkdirSync(deps.depsDir, { recursive: true });
      const manifest = join(deps.depsDir, "package.json");
      if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "topics-browser-deps", private: true }));
      deps.log(`playwright-core not resolvable, installing into ${deps.depsDir}`);
      const code = await deps.install(deps.depsDir);
      entry = installedEntry(deps.depsDir);
      if (code !== 0 || !entry) throw new Error(`playwright-core is missing and the automatic install failed (exit ${code}, dir ${deps.depsDir})`);
    }
    return deps.importFrom(pathToFileURL(entry).href);
  }

  return async () => {
    try {
      return await deps.importDefault();
    } catch (err) {
      if (!/playwright-core/.test(String((err as Error)?.message ?? err))) throw err;
    }
    installing ??= installAndLoad().finally(() => { installing = null; });
    return installing;
  };
}

/** Process-wide loader used by the browser services. */
export const loadPlaywrightCore = createPlaywrightLoader();
