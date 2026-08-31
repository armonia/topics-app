/**
 * A RELEASE CAN BE COMPLETE AND STILL NOT REACH HALF ITS USERS.
 *
 * Measured on 2026-08-31: `tauri-v2.2.256` passed this gate 12/12 and its
 * `latest.json` listed SEVEN platforms out of ten, none of them Windows. Every
 * installer was on the release — the gate had counted the file NAMES, and the
 * name `latest.json` was there. Whoever was on Windows got no update and
 * nothing said a word until somebody compared two manifests by hand.
 *
 * The shape of the pipeline is why it can happen again: the three matrix builds
 * each upload their OWN `latest.json` and the last one wins, so a race won by a
 * runner that never saw Windows publishes a manifest that is present and
 * truncated.
 *
 * Pure on purpose, like `assetVerdict`: the case that matters is proven without
 * waiting for a real release to go wrong.
 *
 * @covers RELEASE-03
 */
import { describe, expect, test } from "bun:test";
import { assetVerdict, manifestVerdict, UPDATER_PLATFORMS } from "./check-release-assets";

/** The real manifest of 2.2.259, reduced to its keys: this is what "whole" is. */
const WHOLE = JSON.stringify({
  version: "2.2.259",
  platforms: Object.fromEntries(UPDATER_PLATFORMS.map((k) => [k, { url: "https://x", signature: "s" }])),
});

/** The real manifest of 2.2.256: everything but the three Windows entries. */
const TRUNCATED_256 = JSON.stringify({
  version: "2.2.256",
  platforms: Object.fromEntries(
    UPDATER_PLATFORMS.filter((k) => !k.startsWith("windows-")).map((k) => [k, { url: "https://x", signature: "s" }]),
  ),
});

describe("the manifest is read, not just counted", () => {
  test("a whole manifest passes and says how many platforms it covers", () => {
    const v = manifestVerdict(WHOLE);
    expect(v.ok).toBe(true);
    expect(v.found).toBe(UPDATER_PLATFORMS.length);
  });

  test("THE REAL 2.2.256 IS REJECTED, and the three Windows keys are named", () => {
    const v = manifestVerdict(TRUNCATED_256);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toBe("platforms");
    expect(v.found).toBe(7);
    expect(v.missing).toEqual(["windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"]);
  });

  test("an unreadable manifest is a DIFFERENT fault from a missing build", () => {
    // "Zero platforms" and "this is not a manifest" have different cures, and a
    // gate that flattened them would send somebody to re-run a build that ran.
    for (const raw of ["not json at all", "{}", '{"version":"1.0.0"}', '{"platforms":null}']) {
      const v = manifestVerdict(raw);
      expect(v.ok).toBe(false);
      if (v.ok) throw new Error("unreachable");
      expect(v.reason).toBe("unreadable");
    }
  });

  test("extra platforms do not fail it: the list is a floor, not a straitjacket", () => {
    // A new target (say linux-aarch64) must not turn every release red on the
    // day it is added.
    const withExtra = JSON.stringify({
      version: "9.9.9",
      platforms: {
        ...JSON.parse(WHOLE).platforms,
        "linux-aarch64": { url: "https://x", signature: "s" },
      },
    });
    expect(manifestVerdict(withExtra).ok).toBe(true);
  });
});

describe("the two halves of the gate answer different questions", () => {
  test("the names alone said the 2.2.256 release was complete: that is the hole", () => {
    // This is the state that shipped. `assetVerdict` is right — every file was
    // uploaded — and the release was still broken for Windows.
    const namesOf256 = [
      "Topics_2.2.256_universal.app.tar.gz", "Topics_2.2.256_universal.app.tar.gz.sig",
      "Topics_2.2.256_universal.dmg", "Topics_2.2.256_universal.dmg.sig",
      "Topics_2.2.256_x64-setup.exe", "Topics_2.2.256_x64-setup.exe.sig",
      "Topics_2.2.256_x64_en-US.msi", "Topics_2.2.256_x64_en-US.msi.sig",
      "Topics_2.2.256_amd64.deb", "Topics_2.2.256_amd64.deb.sig",
      "Topics-2.2.256-1.x86_64.rpm", "Topics-2.2.256-1.x86_64.rpm.sig",
      "latest.json",
    ];
    expect(assetVerdict(namesOf256).complete).toBe(true);
    // …and the manifest that came with those very names does not pass.
    expect(manifestVerdict(TRUNCATED_256).ok).toBe(false);
  });
});
