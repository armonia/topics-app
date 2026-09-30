/**
 * L'ambiente con cui viene lanciata la CLI.
 *
 * Due invarianti, tutte e due nate da un guasto vero:
 *
 *  - Non passa segreti. L'allowlist è la regola, il blocklist il controllo
 *    incrociato: un `*_TOKEN` che entrasse qui finirebbe nel processo di un
 *    agente che scrive file e apre socket.
 *  - `MCP_TOOL_TIMEOUT` is the largest delay a JS timer honours. A question
 *    has no lifetime, and the CLI default (30 min) killed one under a human at
 *    lunch with "no response and no progress for 1800s". One millisecond more
 *    and the timer overflows to 1 ms, which would kill every call at once.
  * @covers CCLI-02
 */
import { describe, expect, test } from "bun:test";
import { buildSafeEnv } from "./claude-code";
import { ASK_TRANSPORT_CEILING_MS } from "../lib/ask-user-bridge";

describe("buildSafeEnv", () => {
  test("gives the CLI the longest patience a timer can hold, and not a millisecond more", () => {
    const env = buildSafeEnv();
    const timeout = Number(env.MCP_TOOL_TIMEOUT);
    expect(timeout).toBe(ASK_TRANSPORT_CEILING_MS);
    // Past 2^31 - 1 a Node/Bun timer fires after 1 ms: the "infinite" patience
    // would become none at all.
    expect(timeout).toBeLessThanOrEqual(2 ** 31 - 1);
    // Days, not hours: nothing in the transport ends a question a person could
    // still be about to answer.
    expect(timeout).toBeGreaterThan(20 * 24 * 60 * 60 * 1000);
  });

  test("non porta segreti nel processo dell'agente", () => {
    const env = buildSafeEnv();
    for (const key of Object.keys(env)) {
      if (key === "ANTHROPIC_API_KEY") continue; // eccezione esplicita: serve alla CLI
      expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i);
    }
  });

  test("non recinta i core: la quota è per-topic, non per tutti", () => {
    // Questo ambiente è di OGNI sessione, chat interattive dell'umano comprese.
    // La quota di job (`agent-job-quota.ts`) vale solo per gli agenti nati dal
    // dispatcher e si fonde qui sopra allo spawn: se comparisse già qui,
    // dimezzerebbe anche la build che l'umano lancia a mano nella sua chat.
    const env = buildSafeEnv();
    expect(env.CARGO_BUILD_JOBS).toBeUndefined();
    expect(env.MAKEFLAGS).toBeUndefined();
  });
});
