/**
 * The "Topics is a product for anybody" rule must reach the agents through the
 * kickoff envelope, and the human copy in docs/board-protocol.md must say the
 * same thing. Reads the sources, like board-protocol-parity.test.ts, so the test
 * does not need to boot the dispatcher.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_PRODUCT_RULE } from "./task-dispatcher";

const REPO = join(import.meta.dir, "..", "..");
const dispatcher = readFileSync(join(REPO, "server/services/task-dispatcher.ts"), "utf8");
const doc = readFileSync(join(REPO, "docs/board-protocol.md"), "utf8");

describe("regola Topics generica nel kickoff", () => {
  test("il testo della regola dice: niente dati di una persona nel codice, il default vuoto", () => {
    expect(GENERIC_PRODUCT_RULE).toContain("Topics is a product for ANYONE");
    expect(GENERIC_PRODUCT_RULE).toContain("never write one person's names, paths, IPs, accounts or servers");
    expect(GENERIC_PRODUCT_RULE).toContain("machines table");
    expect(GENERIC_PRODUCT_RULE).toContain("empty default that works");
  });

  test("buildKickoff la inserisce nell'envelope (riga dell'array delle regole)", () => {
    expect(dispatcher).toMatch(/^\s+GENERIC_PRODUCT_RULE,$/m);
  });

  test("docs/board-protocol.md porta la stessa regola per gli umani", () => {
    expect(doc).toContain("Topics è un prodotto per chiunque");
    expect(doc).toContain("con un default vuoto che funziona");
  });
});
