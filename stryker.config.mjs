// @ts-check
// Mutation testing: misura se i test PRENDONO gli errori, non solo se eseguono le righe.
// Stryker cambia il codice apposta (un `>` in `>=`, un `true` in `false`, un ramo tolto) e
// rilancia i test che coprono quel punto: un mutante che sopravvive è un bug che la suite
// lascerebbe passare. Lo score per file sta in `scripts/mutation-baseline.json` e può solo
// salire: lo legge `scripts/check-mutation.ts`.
//
// Il recinto è l'elenco CRITICAL in `scripts/mutation-critical.ts`, non tutto il repo: una
// campagna sull'intero server costa giorni (26k mutanti su una suite da 3 minuti, misura di
// my-little-software-factory#157). Si allarga aggiungendo moduli lì, uno alla volta.
import { CRITICAL } from "./scripts/mutation-critical.ts";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: CRITICAL.map((m) => m.source),
  bun: {
    testFiles: [...new Set(CRITICAL.flatMap((m) => m.tests))],
    timeout: 300_000,
  },
  reporters: ["clear-text", "json", "progress"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  thresholds: { high: 90, low: 70, break: null },
  timeoutMS: 10_000,
  concurrency: 8,
  tempDirName: ".stryker-tmp",
};
