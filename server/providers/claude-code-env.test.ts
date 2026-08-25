/**
 * L'ambiente con cui viene lanciata la CLI.
 *
 * Due invarianti, tutte e due nate da un guasto vero:
 *
 *  - Non passa segreti. L'allowlist è la regola, il blocklist il controllo
 *    incrociato: un `*_TOKEN` che entrasse qui finirebbe nel processo di un
 *    agente che scrive file e apre socket.
 *  - `MCP_TOOL_TIMEOUT` deve stare SOPRA la vita massima di una domanda a
 *    schermo. Il default della CLI (30 min) è più corto dell'ask TTL (90 min),
 *    e una domanda lasciata lì mentre l'umano era a pranzo è morta con
 *    «nessuna risposta né progress per 1800s»: un pannello ucciso da un
 *    orologio che non sapeva niente di lui. Il ponte manda `notifications/
 *    progress` a ogni gamba (topics-mcp-server.ts) e quel timer si riazzera —
 *    questa è la cintura per un client che non le onori.
  * @covers CCLI-02
 */
import { describe, expect, test } from "bun:test";
import { buildSafeEnv } from "./claude-code";
import { ASK_TTL_MS } from "../lib/ask-user-bridge";

describe("buildSafeEnv", () => {
  test("dà alla CLI più pazienza di quanta ne possa consumare una domanda a schermo", () => {
    const env = buildSafeEnv();
    const timeout = Number(env.MCP_TOOL_TIMEOUT);
    expect(Number.isFinite(timeout)).toBe(true);
    // Stretto: se qualcuno alza ASK_TTL_MS senza toccare questo, il test cade
    // qui invece che in produzione dopo mezz'ora di attesa dell'umano.
    expect(timeout).toBeGreaterThan(ASK_TTL_MS);
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
