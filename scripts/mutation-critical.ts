/**
 * I moduli su cui si misura il mutation score: quelli dove un errore che i test non
 * prendono costa davvero (un land che fonde il ramo sbagliato, una card lanciata a spese
 * di chi non doveva, un permesso concesso). Ogni voce: il sorgente da mutare e i file di
 * test che lo esercitano. Un modulo entra qui con il suo score di partenza nella baseline
 * (`bun run check:mutation --update-baseline`), e da lì può solo salire.
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
