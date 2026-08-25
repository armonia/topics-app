/**
 * Reading an address must not be a skill the owner is required to have.
 *
 * The approval card used to show `192.168.1.7` and `95.253.69.40` in the same
 * grey line. One is somebody already in the house, the other is anybody on the
 * internet, and telling them apart meant knowing what `192.168.` means. That
 * is the deduction this module removes.
 *
 * The direction that matters most is the cautious one: what we cannot classify
 * must NOT become "internet". Saying "this comes from outside" when we do not
 * know is inventing the scariest of the possible facts.
 *
 * @covers PAIRING-01
 */
import { describe, test, expect } from "bun:test";

import { provenienzaDi } from "./provenienza";

describe("provenienza · la rete di casa non si confonde con Internet", () => {
  test("gli intervalli privati sono LAN", () => {
    for (const ip of [
      "192.168.1.7", "10.0.0.9", "10.255.255.254",
      "172.16.0.1", "172.31.255.254", "172.20.10.3",
      "169.254.1.1",
      "fe80::1", "fd00::1",
    ]) {
      expect(`${ip} → ${provenienzaDi(ip)}`).toBe(`${ip} → lan`);
    }
  });

  test("un indirizzo pubblico è Internet", () => {
    for (const ip of ["95.253.69.40", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2001:db8::1"]) {
      expect(`${ip} → ${provenienzaDi(ip)}`).toBe(`${ip} → internet`);
    }
  });

  test("`172.16/12` si legge sul secondo ottetto, non come prefisso di testo", () => {
    // THE case a `startsWith("172.1")` would get wrong in BOTH directions:
    // `172.16` is private, `172.1` and `172.199` are not.
    expect(provenienzaDi("172.16.0.1")).toBe("lan");
    expect(provenienzaDi("172.31.0.1")).toBe("lan");
    expect(provenienzaDi("172.15.0.1")).toBe("internet");
    expect(provenienzaDi("172.32.0.1")).toBe("internet");
    expect(provenienzaDi("172.199.0.1")).toBe("internet");
  });

  test("questa macchina è locale, anche vestita da IPv6", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "localhost"]) {
      expect(`${ip} → ${provenienzaDi(ip)}`).toBe(`${ip} → locale`);
    }
  });

  test("il rivestimento `::ffff:` non cambia la risposta", () => {
    // This is how an IPv4 address arrives on an IPv6 socket. Without stripping
    // it, every device on the home network would read as coming from the internet.
    expect(provenienzaDi("::ffff:192.168.1.7")).toBe("lan");
    expect(provenienzaDi("::ffff:95.253.69.40")).toBe("internet");
  });

  test("ciò che non sappiamo resta IGNOTO, e non diventa «Internet»", () => {
    // The cautious direction, and it is the one that matters: a fact we do not
    // have is not told at all, least of all in the version that alarms.
    for (const v of [null, undefined, "", "   ", "non-un-indirizzo", "chi.sono.io"]) {
      expect(`${JSON.stringify(v)} → ${provenienzaDi(v)}`).toBe(`${JSON.stringify(v)} → ignota`);
    }
  });
});
