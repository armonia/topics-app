/**
 * @covers E2E-GATE-01
 */
import { describe, test, expect } from "bun:test";
import { e2eRoutesEnabled } from "./e2e";

/**
 * F57 (audit del 19/06, rimasto aperto fino al 16/08): `/api/test/seed-message`
 * era registrato INCONDIZIONATAMENTE in `topics.ts` e inseriva righe `messages`
 * arbitrarie nel DB — l'unica superficie di test che un server di produzione
 * esponeva davvero. Ora passa dallo stesso cancello di tutte le altre.
 *
 * Questi casi non provano la rotta: provano il cancello, che è la cosa che si
 * può rompere in silenzio. Una variabile letta col nome sbagliato, o un default
 * "acceso quando non so", riaprirebbe il buco senza che nessun test rosseggi.
 */
describe("il cancello delle rotte di test", () => {
  test("spento quando TOPICS_E2E non c'è, non vale 1, o c'è solo NODE_ENV=test", () => {
    expect(e2eRoutesEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ TOPICS_E2E: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ TOPICS_E2E: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("acceso solo con TOPICS_E2E=1, che è ciò che dichiara start-test-server.sh", () => {
    expect(e2eRoutesEnabled({ TOPICS_E2E: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
