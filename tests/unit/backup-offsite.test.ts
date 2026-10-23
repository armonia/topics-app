/**
 * The off-disk copy of the daily snapshot, proved without a database.
 *
 * @covers DBMAINT-04
 *
 * The fake `Transfer` below stands in for `scp`: an upload (destination arg
 * holds a `:`) copies bytes into a temp dir acting as the remote host, a
 * download (source arg holds a `:`) copies them back out. Every red test is a
 * way a broken off-disk copy would pass for a good one:
 *  - the remote flips a byte: the read-back must see it, and no receipt stays;
 *  - scp itself fails: its stderr must surface, and no receipt stays;
 *  - the receipt covers another snapshot, the local file changed since the
 *    copy, the receipt is older than 2 days, or there is no receipt at all:
 *    `verifyOffsite` must refuse each of them;
 *  - the destination IS this machine (or a plain local path): no byte may
 *    move before the throw.
 *
 * Each red test fails if its check is removed: the throw it expects comes
 * from exactly that check, and the good path beside it proves the test can
 * reach the check at all.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECEIPT_FILE,
  copyOffsite,
  loadOffsiteConfig,
  offsiteSlot,
  verifyOffsite,
  type OffsiteConfig,
  type Transfer,
} from "../../scripts/backup-offsite";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fresh scratch dir, removed after the file is over. */
function freshDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `topics-${label}-`));
  roots.push(dir);
  return dir;
}

const DEST = "backup@host.example.test:backups";
const cfg: OffsiteConfig = { dest: DEST };
const SNAPSHOT = "topics-2026-10-23.db.zst";
const SNAPSHOT_BYTES = Buffer.from(`fake-snapshot-${"x".repeat(1000)}`);

/** A backups dir holding one snapshot file. */
function backupsWithSnapshot(name: string = SNAPSHOT): string {
  const dir = freshDir("offsite-backups");
  writeFileSync(join(dir, name), SNAPSHOT_BYTES);
  return dir;
}

interface FakeRemote {
  transfer: Transfer;
  calls: string[][];
  corruptUpload: boolean;
  failWith: { status: number; stderr: string } | null;
}

/**
 * An `scp` stand-in: uploads land in a temp dir (the "remote host"),
 * downloads read them back out. The last two args decide the direction,
 * exactly as the copy code calls it.
 */
function fakeRemote(): FakeRemote {
  const dir = freshDir("offsite-remote");
  const fake: FakeRemote = {
    transfer: (args) => {
      fake.calls.push(args);
      if (fake.failWith) return { ...fake.failWith };
      const src = args[args.length - 2]!;
      const dest = args[args.length - 1]!;
      const slotOf = (remote: string) => remote.slice(remote.lastIndexOf("/") + 1);
      if (dest.includes(":")) {
        const bytes = Buffer.from(readFileSync(src));
        if (fake.corruptUpload) bytes[0] = ~bytes[0] & 0xff;
        writeFileSync(join(dir, slotOf(dest)), bytes);
      } else if (src.includes(":")) {
        writeFileSync(dest, readFileSync(join(dir, slotOf(src))));
      } else {
        throw new Error("fake scp called with no remote side");
      }
      return { status: 0, stderr: "" };
    },
    calls: [],
    corruptUpload: false,
    failWith: null,
  };
  return fake;
}

describe("copyOffsite", () => {
  test("copies, reads back, and writes a receipt that verifies", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    const now = new Date();
    const receipt = copyOffsite(dir, SNAPSHOT, cfg, now, fake.transfer);
    expect(receipt).toEqual({
      name: SNAPSHOT,
      slot: offsiteSlot(now),
      bytes: SNAPSHOT_BYTES.length,
      sha256: receipt.sha256,
      at: now.toISOString(),
    });
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(dir, RECEIPT_FILE), "utf8"))).toEqual(receipt);
    expect(verifyOffsite(dir, SNAPSHOT, now)).toEqual(receipt);
  });

  test("a corrupted remote fails the read-back and leaves no receipt", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    fake.corruptUpload = true;
    expect(() => copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer)).toThrow(/differs after read-back/);
    expect(existsSync(join(dir, RECEIPT_FILE))).toBe(false);
  });

  test("a failed scp surfaces its stderr and leaves no receipt", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    fake.failWith = { status: 1, stderr: "unreachable" };
    expect(() => copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer)).toThrow(/unreachable/);
    expect(existsSync(join(dir, RECEIPT_FILE))).toBe(false);
  });

  test("an upload that fails after a good copy takes the old receipt with it", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer);
    expect(existsSync(join(dir, RECEIPT_FILE))).toBe(true);
    // The same slot is rewritten the next time its weekday comes round: if that upload dies
    // half way, the remote file is not what the old receipt says.
    fake.failWith = { status: 1, stderr: "connection lost" };
    expect(() => copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer)).toThrow(/connection lost/);
    expect(existsSync(join(dir, RECEIPT_FILE))).toBe(false);
  });

  test("a same-machine destination throws before any transfer", () => {
    for (const dest of ["backup@localhost:backups", "backup@127.0.0.1:backups", "backups/local-only"]) {
      const dir = backupsWithSnapshot();
      const fake = fakeRemote();
      expect(() => copyOffsite(dir, SNAPSHOT, { dest }, new Date(), fake.transfer)).toThrow(/this machine/);
      expect(fake.calls).toEqual([]);
      expect(existsSync(join(dir, RECEIPT_FILE))).toBe(false);
    }
  });
});

describe("verifyOffsite", () => {
  test("a receipt for another snapshot does not verify", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer);
    const next = "topics-2026-10-24.db.zst";
    writeFileSync(join(dir, next), SNAPSHOT_BYTES);
    expect(() => verifyOffsite(dir, next)).toThrow(/another day/);
  });

  test("a snapshot modified after the copy does not verify", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    copyOffsite(dir, SNAPSHOT, cfg, new Date(), fake.transfer);
    writeFileSync(join(dir, SNAPSHOT), Buffer.concat([SNAPSHOT_BYTES, Buffer.from("late write")]));
    expect(() => verifyOffsite(dir, SNAPSHOT)).toThrow(/no longer matches/);
  });

  test("a receipt older than 2 days does not verify", () => {
    const dir = backupsWithSnapshot();
    const fake = fakeRemote();
    copyOffsite(dir, SNAPSHOT, cfg, new Date(Date.now() - 3 * 86_400_000), fake.transfer);
    expect(() => verifyOffsite(dir, SNAPSHOT)).toThrow(/days old/);
  });

  test("a missing receipt names the config file", () => {
    const dir = freshDir("offsite-no-receipt");
    expect(() => verifyOffsite(dir, SNAPSHOT)).toThrow(/\.topics\/backup-offsite\.json/);
  });
});

describe("offsiteSlot", () => {
  test("seven consecutive local days give seven names, the eighth repeats", () => {
    const base = new Date(2026, 2, 2, 12, 0, 0);
    const names = Array.from({ length: 7 }, (_, i) => offsiteSlot(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
    expect(new Set(names).size).toBe(7);
    for (const n of names) expect(n).toMatch(/^topics-(sun|mon|tue|wed|thu|fri|sat)\.db\.zst$/);
    const weekLater = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7);
    expect(offsiteSlot(weekLater)).toBe(names[0]);
  });
});

describe("loadOffsiteConfig", () => {
  const writeConfig = (home: string, body: string): string => {
    const dir = join(home, ".topics");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "backup-offsite.json");
    writeFileSync(path, body);
    return path;
  };

  test("a missing file means no destination, not an error", () => {
    expect(loadOffsiteConfig(freshDir("offsite-no-config"))).toBeNull();
  });

  test("a valid file parses, wake stays optional", () => {
    const home = freshDir("offsite-config");
    writeConfig(home, JSON.stringify({ dest: DEST, wake: "wake-command" }));
    expect(loadOffsiteConfig(home)).toEqual({ dest: DEST, wake: "wake-command" });
    const bare = freshDir("offsite-config-bare");
    writeConfig(bare, JSON.stringify({ dest: DEST }));
    expect(loadOffsiteConfig(bare)).toEqual({ dest: DEST });
  });

  test("malformed JSON or a missing dest throws", () => {
    const broken = freshDir("offsite-config-broken");
    writeConfig(broken, "{not json");
    expect(() => loadOffsiteConfig(broken)).toThrow(/not valid JSON/);
    for (const body of [`{}`, `{"dest":""}`, `{"dest":"   "}`]) {
      const home = freshDir("offsite-config-empty");
      writeConfig(home, body);
      expect(() => loadOffsiteConfig(home)).toThrow(/non-empty "dest"/);
    }
  });
});
