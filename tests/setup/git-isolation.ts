/**
 * The git config a test run imposes on itself, in one place.
 *
 * WHY IT IS NOT JUST INSIDE THE PRELOAD. Bun does not give a spawned child the
 * variables added to `process.env` at RUNTIME: measured on 2026-10-22, a
 * variable written by the preload reaches `process.env` and the child still
 * sees it empty, and that holds for `Bun.spawnSync`, for node's `spawnSync`
 * and for `execFileSync` alike (real node does pass the last one through, Bun
 * does not). So the preload alone can only work if every single call also
 * spells out `env`, and the eighteenth call written tomorrow will not.
 *
 * A variable that is already in the environment when `bun test` STARTS, on the
 * other hand, is inherited by every child for free. That is what
 * `scripts/slot.ts` does with this function: it wraps every `test:unit`, in CI
 * too, so the isolation is in place before the first test file is loaded and a
 * forgotten `env` cannot let the machine's hooks back in.
 *
 * The preload keeps applying it as well, for whoever runs `bun test <file>` by
 * hand without the wrapper. `tests/unit/git-env-nei-test.test.ts` guards that  allow-italian: the gate's own file name is Italian
 * second path, which is the only one left where `env` still has to be passed.
 */

/** Set once the keys are in: applying this twice would only duplicate them. */
export const GIT_ISOLATION_MARKER = "TOPICS_GIT_ISOLATED";

/**
 * What gets taken out of the way, and nothing else.
 *
 * `core.hooksPath` is the one that cost a day: on a development machine it
 * points at a third-party `prepare-commit-msg` that fires two
 * `curl --max-time 2` at localhost on every commit (380ms per commit against
 * 160ms), and under load the tests overran their timeout with a red that named
 * a different test every time.
 *
 * NOT the empty string: git resolves that as a path relative to the repo and
 * ends up at `<repo>/.git/hooks`, i.e. exactly the hooks we wanted gone. It
 * takes an absolute path that does not exist.
 *
 * `commit.gpgsign=false` so that whoever signs their commits is not asked for
 * a passphrase by a test suite, which then hangs until the timeout.
 *
 * The identity (`user.name` / `user.email`) deliberately stays OUT:
 * `server/lib/git-identity.test.ts` has to be able to simulate a machine
 * without one, and keys passed through `GIT_CONFIG_*` beat the config file it
 * fakes. Whoever needs an identity passes it on the call.
 */
export const GIT_ISOLATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/nonexistent/topics-test-hooks"],
  ["commit.gpgsign", "false"],
];

/**
 * `base` plus the isolation, as a new object: `GIT_CONFIG_COUNT` and the
 * numbered key/value pairs, which is the official way to impose config on git
 * without writing to any file.
 *
 * It APPENDS to a count that is already there instead of overwriting it, so
 * the keys of whoever launched us are not thrown away, and it does nothing at
 * all if the marker says the isolation is already in place — otherwise the
 * preload running inside a wrapped run would write the same two keys a second
 * time.
 */
export function gitIsolationEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  if (out[GIT_ISOLATION_MARKER] === "1") return out;
  const already = Number(out.GIT_CONFIG_COUNT ?? "0");
  const start = Number.isFinite(already) && already > 0 ? already : 0;
  GIT_ISOLATION_PAIRS.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = k;
    out[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  out.GIT_CONFIG_COUNT = String(start + GIT_ISOLATION_PAIRS.length);
  out[GIT_ISOLATION_MARKER] = "1";
  return out;
}
