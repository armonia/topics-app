/**
 * bundleDrift — "the version you read is not the code you see".
 *
 * The status-bar chip prefers `/api/version`: the server re-reads the root
 * package.json fresh, so a bump shows up instantly instead of waiting for a
 * rebuild. That cured one lie and created its mirror. `public/` is a deploy
 * artefact that only moves when somebody runs `bun run build:client` (the
 * measured decision in `docs/build-watch-decision.md`), so when the bundle is
 * older than the repo the chip keeps reading the REPO number while the screen
 * runs old code, and nothing says so.
 *
 * Measured on 2026-08-29: the bundle on disk was frozen at 2.2.211 with the
 * repo at 2.2.215. Four versions of fixes looked shipped and were not on
 * screen. The two facts were both already in the client and nobody compared
 * them: `__APP_VERSION__` is baked into the bundle at `vite build`, and
 * `/api/version` is read live off disk by the server.
 *
 * This function is that comparison, and it is the whole signal.
 */

export interface BundleDrift {
  /** Version baked into the bundle that is actually running on screen. */
  bundle: string;
  /** Version the repository is at right now, read live by the server. */
  repo: string;
}

export function bundleDrift(
  bundleVersion: string | undefined,
  repoVersion: string | undefined,
  opts: { hmr?: boolean } = {},
): BundleDrift | null {
  // Under the Vite dev server the code on screen is patched in place by HMR
  // while the baked define stays frozen at dev-server start. The two numbers
  // diverge there for a reason that is not staleness, and claiming otherwise
  // would make the signal cry wolf exactly where the fast path lives.
  if (opts.hmr) return null;

  const bundle = (bundleVersion ?? '').trim();
  const repo = (repoVersion ?? '').trim();

  // A missing fact is not a drift. A standalone bundle with no reachable server
  // has no repo version to compare against, and `0.0.0` is the server saying it
  // could not read one (see the BAKED_VERSION note in server/routes/status.ts).
  if (!bundle || !repo || repo === '0.0.0' || bundle === '0.0.0') return null;

  return bundle === repo ? null : { bundle, repo };
}
