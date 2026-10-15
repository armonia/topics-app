/**
 * The machine's relay key on disk: a restart keeps the name, and the previous scheme's file is left
 * as it was.
 *
 * @covers RELAY-E2E-12
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leggiRelayConfig, leggiRelaySegreto } from "./relay-config";

describe("relay identity on disk", () => {
  test("the previous scheme's relay-secret stays as it was, and the new identity survives a reboot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
    try {
      const legacy = "legacy-shared-secret-abcdefghijklmnop\n";
      writeFileSync(join(dir, "relay-secret"), legacy);
      const first = await leggiRelayConfig({}, dir);
      expect(readFileSync(join(dir, "relay-secret"), "utf8")).toBe(legacy);
      const file = join(dir, "relay-identity.json");
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // The next boot reads the same identity: the links keep their meeting point.
      expect((await leggiRelayConfig({}, dir)).relayId).toBe(first.relayId);
      expect(await leggiRelaySegreto(dir)).toBe((JSON.parse(readFileSync(file, "utf8")) as { segreto: string }).segreto);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
