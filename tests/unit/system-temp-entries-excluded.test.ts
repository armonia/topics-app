/**
 * A self-hosted CI runner is a whole server, not a quiet folder: systemd's
 * own `PrivateTmp` units leave entries like `systemd-private-...` in the real
 * temp root during a run. Those must not count as a test writing outside its
 * `TMPDIR`; an entry a test actually leaves there must still count.
 *
 * @covers GATE-13
 */
import { describe, expect, test } from "bun:test";
import { isSystemTempEntry } from "../../scripts/test-unit-shards.ts";

describe("isSystemTempEntry", () => {
  test("a systemd PrivateTmp entry is a known system entry, not a leak", () => {
    expect(isSystemTempEntry("systemd-private-abc-systemd-timedated.service-xyz")).toBe(true);
  });

  test("a snap private tmp entry is a known system entry, not a leak", () => {
    expect(isSystemTempEntry("snap-private-tmp")).toBe(true);
  });

  test("an entry a test leaves still counts", () => {
    expect(isSystemTempEntry("topics-test-leak")).toBe(false);
  });
});
