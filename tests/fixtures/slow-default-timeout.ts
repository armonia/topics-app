/**
 * A test that sleeps past bun's 5s default WITHOUT asking for a timeout of its
 * own. It is not run by the suite: `tests/unit/test-default-timeout.test.ts`
 * spawns it as a CHILD `bun test`, and reads its exit code.
 *
 * Why a child and not an inline sleep. The preload raises the default for the
 * ONE file bun is loading when it runs, not for the whole run (measured, see
 * `tests/setup/bun-test-preload.ts`). An inline sleep therefore passes when
 * this file happens to be that one and dies "after 5000ms" when it is not —
 * which is a fact about bun's file ordering, not about the repo. In a child
 * run this fixture IS the only file, so the pose is fixed and the answer is
 * about the lever alone.
 *
 * Deliberately NOT named `*.test.ts`: `test:unit` passes explicit directories
 * and this one is outside them, but a bare `bun test` walks the tree, and this
 * file dying inside somebody else's run would be exactly the noise it exists
 * to remove.
 */
import { it, expect } from "bun:test";

const BUN_DEFAULT_MS = 5_000;

it("dorme oltre il default di bun senza chiedere un timeout suo", async () => {
  const partenza = Date.now();
  await Bun.sleep(BUN_DEFAULT_MS + 100);
  expect(Date.now() - partenza).toBeGreaterThanOrEqual(BUN_DEFAULT_MS);
});
