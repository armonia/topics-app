/**
 * @covers RUNTIME-16
 *
 * The PATH we hand to child processes must stay a VALID PATH on every system.
 *
 * These tests exist for a defect that is invisible on macOS and that, on Windows,
 * took the system commands out of the user's hands: `augmentPath` separated
 * entries with `:` everywhere, but on Windows `:` is the DRIVE LETTER's own
 * punctuation. Calling `split(":")` on a Windows PATH is not a failed split: it
 * CUTS EVERY ENTRY IN HALF at its drive letter, and joining the pieces back
 * produces one long string the OS reads as a single, nonexistent directory.
 *
 * Measured on Windows 11 on 2026-08-26, inside a Topics terminal: `ping` — a
 * plain system command — answered "not recognized". The child's PATH did contain
 * `C:\WINDOWS\system32`, but not as an entry of its own: it was glued inside a
 * longer fragment, so as far as the OS was concerned it did not exist.
 *
 * The tests run on macOS and Linux and still measure Windows behaviour, because
 * the separator is chosen by `process.platform`: the platform is simulated and
 * the module re-imported. Without that, this defect would only ever be visible
 * to someone installing on Windows.
 */
import { describe, expect, it } from "bun:test";

/** Re-import `path-env` with `process.platform` simulated, then restore it. */
async function withPlatform<T>(platform: string, fn: (m: typeof import("../../server/utils/path-env")) => T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    // A different query string bypasses the module cache: the separator and the
    // list are constants computed at import time, so an already-loaded module
    // would carry the previous platform with it.
    const mod = await import(`../../server/utils/path-env?platform=${platform}-${Math.random()}`);
    return fn(mod);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("augmentPath honours the platform separator", () => {
  it("does not split entries at the drive letter on Windows", async () => {
    const windowsPath = String.raw`C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd`;
    const out = await withPlatform("win32", (m) => m.augmentPath(windowsPath));
    const parts = out.split(";");

    // The check that matters: the system directories must be entries of THEIR
    // OWN, not fragments glued inside another. `includes()` on the whole string
    // would have passed with the defect in place — and by hand, it did.
    expect(parts).toContain(String.raw`C:\WINDOWS\system32`);
    expect(parts).toContain(String.raw`C:\WINDOWS`);
    expect(parts).toContain(String.raw`C:\Program Files\Git\cmd`);

    // And no entry may still carry a unix separator: if one does, something
    // joined with `:` what had to be joined with `;`.
    for (const p of parts) expect(p).not.toContain(":\\WINDOWS\\system32;");
    expect(out).not.toContain("/usr/bin");
    expect(out).not.toContain("/opt/homebrew/bin");
  });

  it("is unchanged on unix", async () => {
    const unixPath = "/usr/bin:/bin";
    const out = await withPlatform("darwin", (m) => m.augmentPath(unixPath));
    const parts = out.split(":");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(out).not.toContain(";");
  });

  it("never duplicates an entry, on either platform", async () => {
    const win = await withPlatform("win32", (m) => m.augmentPath(String.raw`C:\WINDOWS;C:\WINDOWS`));
    const winParts = win.split(";").filter((p) => p === String.raw`C:\WINDOWS`);
    expect(winParts).toHaveLength(1);

    const nix = await withPlatform("darwin", (m) => m.augmentPath("/usr/bin:/usr/bin"));
    const nixParts = nix.split(":").filter((p) => p === "/usr/bin");
    expect(nixParts).toHaveLength(1);
  });

  it("the Windows extra dirs are Windows paths, not unix ones", async () => {
    const extra = await withPlatform("win32", (m) => m.EXTRA_PATHS);
    expect(extra.length).toBeGreaterThan(0);
    for (const p of extra) {
      // The part under the home carries the HOST system's separator (the home
      // comes from `userInfo()`, which cannot be simulated): on a Mac that
      // prefix is `/Users/...`. What is measured here is the part WE choose, the
      // tail: it must be Windows-shaped, and the unix directories must be gone —
      // on Windows they do not exist and never will.
      expect(p).toContain("\\");
      expect(p).not.toContain("/opt/");
      expect(p).not.toContain("/usr/");
    }
    // The unix list must NOT have ended up here.
    expect(extra).not.toContain("/usr/bin");
    expect(extra).not.toContain("/opt/homebrew/bin");
  });
});
