/**
 * Which listening addresses other devices can open: every interface, or an
 * address that is not the loopback. The chat's server row and the sidebar's
 * server sign warn on these (BGVIS-08).
 *
 * @covers BGVIS-08
 */
import { describe, expect, test } from "bun:test";
import { reachableFromNetwork } from "./background-work";

describe("reachableFromNetwork", () => {
  test.each([
    ["*", true],
    ["192.168.1.20", true],
    ["100.101.102.103", true],
    ["[fe80::1]", true],
    ["127.0.0.1", false],
    ["127.0.0.53", false],
    ["[::1]", false],
    ["[::ffff:127.0.0.1]", false],
    ["localhost", false],
  ])("%s → %p", (host, open) => {
    expect(reachableFromNetwork({ host, port: 8777 })).toBe(open);
  });
});
