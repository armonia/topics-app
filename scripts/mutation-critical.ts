/**
 * The modules whose mutation score is measured: the ones where a bug the tests miss
 * really costs (a land that merges the wrong branch, a card launched at the wrong
 * account's expense, a permission granted). Each entry: the source to mutate and the
 * test files that exercise it. A module enters with its starting score in the baseline
 * (`bun run check:mutation --update-baseline`), and from there it can only go up.
 */
export type CriticalModule = { source: string; tests: string[] };

export const CRITICAL: CriticalModule[] = [
  { source: "server/services/landing-verdict.ts", tests: ["server/services/landing-verdict.test.ts"] },
  { source: "server/services/landing-files.ts", tests: ["server/services/landing-files.test.ts"] },
  { source: "server/services/dispatch-card-price.ts", tests: ["server/services/dispatch-card-price.test.ts"] },
  { source: "server/services/dispatch-card-weight.ts", tests: ["server/services/dispatch-card-weight.test.ts"] },
  {
    source: "server/services/dispatch-topic-identity.ts",
    tests: ["server/services/dispatch-topic-identity.test.ts"],
  },
  { source: "server/providers/native/permissions.ts", tests: ["server/providers/native/permissions.test.ts"] },
];
