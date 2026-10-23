/**
 * A RELEASE CAN BE WHOLE, WELL NAMED, AND SIGNED WITH THE WRONG KEY.
 *
 * The updater checks each bundle against the public key in `tauri.conf.json`
 * and refuses in silence when it does not fit. `assetVerdict` counts names and
 * `composeManifest` copies whatever a `.sig` holds, so neither would notice a
 * release signed by another keypair, an empty signature, or a `latest.json`
 * that repeats a signature the release no longer carries.
 *
 * The fixtures are the five REAL signatures of tauri-v2.3.13 (public data, read
 * from its `latest.json`), checked against the REAL `pubkey` of this checkout:
 * if the key in the repo is not the one that signs the releases, the first test
 * is the one that goes red.
 *
 * The last block runs the CLI itself with a fake `gh`, because "exits non-zero
 * on a release without signatures" is a statement about the process, not about
 * a function.
 *
 * @covers RELEASE-03
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyIdOf, sigProblems } from "./assert-sig";

const ROOT = join(import.meta.dir, "..");
const PUBKEY: string = JSON.parse(
  readFileSync(join(ROOT, "desktop-tauri/src-tauri/tauri.conf.json"), "utf8"),
).plugins.updater.pubkey;
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/tauri-release.yml"), "utf8");

/** [asset suffix, signature] for the five bundles the updater downloads. */
const REAL: ReadonlyArray<readonly [string, string]> = [
  ["_universal.app.tar.gz", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTd0s4a3pOUW9iV3ZMR0YwNG1JU1lWWVpvL0lVTWs2KzhvenlTTS9lNXhIZVBUS1pPTjR4TFZSbm05ZU1YMHBENEJvL0tRMFRoVFNrcHBEQ2pZVXVySEdHemNjcWdQa2dRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzYwOTI0CWZpbGU6VG9waWNzLmFwcC50YXIuZ3oJdmVyc2lvbjoyLjMuMTMKTzRBQWJVcGpGOGVWcjdUczNyQmEyNk9jNmlSTnp6RjFpRGwwbDNTQUxBbmwwZVJHbnZHMldubWVmMjhGNzJGTFBnNGplS3NZLzJMVG9rallNaWdLQ2c9PQo="],
  ["_x64_en-US.msi", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTd0s4a3pOUW9iV29acnRtamprSjk2WXZXQ3V5ZnBwZnBDeEZhcE43UW9MTTRVR2RDVkoxdW4yei9Id29SSHBldVZrYW1OcVFwR25MN2hLWnhtb0pzSlN0TzVZK3RFSmdJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzYwNjMwCWZpbGU6VG9waWNzXzIuMy4xM194NjRfZW4tVVMubXNpCXZlcnNpb246Mi4zLjEzCm41eGlKYllpdGhSaDhCVHd5dXJoM3FJSnZ1elBwbnlTWU91S1l3UnFXSVcrc1ozdXI4L0hWS2JqbTh0cEFBMmdPdWxXYjFwNzNUMUJYK0k4VVFlTURnPT0K"],
  ["_x64-setup.exe", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTd0s4a3pOUW9iV3VTcUZBcCtUTU9QMzVKWWVsZ0pXUHBBc1JpQW1TSG1LZ3lVTVJjTzc5OWFRUVQvcVRHdWZNMkRyNk13NS8zNkFsUkpxL04zWU5YbHgxUlZDSWRpK3dBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzYwNjMwCWZpbGU6VG9waWNzXzIuMy4xM194NjQtc2V0dXAuZXhlCXZlcnNpb246Mi4zLjEzCkxBRTF4ci9ON1FjVUt2MEpmeFRzNjM5U1g0V0hBSFJ1MURmZUtjSXJVWGFnbTRqTWNoVDNSbXRXdEE0ZkQrTGgrY2NEUS9hOGpQUFE5K0xnOW9hREJBPT0K"],
  ["_amd64.deb", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTd0s4a3pOUW9iV2xLZkRLNXpaeGRJczYrTmVzaVlMOVIrR1V2WUR3Zzk5L1Z3dnJYbC9pVE5FWEtMbWZmVmx0S1lHWmVQY0puNGEyKzJXZ1JRVkcrSWVaY3hmZTJ6S1FFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzYxODg2CWZpbGU6VG9waWNzXzIuMy4xM19hbWQ2NC5kZWIJdmVyc2lvbjoyLjMuMTMKV1I4UzdoUFlSVlRVODRmZ0ozcmxibHUvbHgwSDJiUDh3Mzd6UlJWNXFMY0t2R3JRamZZT0xJQWQ5YXRxaDF2R01uQ3QrVURMQmExM3JaVmR1MEEvQWc9PQo="],
  [".x86_64.rpm", "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTd0s4a3pOUW9iV2xocWRDeGxPWEFIMzhObjd0YUNJSm53ZDFuakpoOUx4OGZSelJUMnBaUWRYQkE3QUhhWE1haEM2R2ppcXVBMkNBbzRQTVNlUTRMN0NZTitzYzZPOUFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzYxODg2CWZpbGU6VG9waWNzLTIuMy4xMy0xLng4Nl82NC5ycG0JdmVyc2lvbjoyLjMuMTMKYWozYjA0Q216T0xGeE1sU3BMZnNYTG9HVEJkY1Y4MWw1Qzl0d3MwQWcvaitlNnB3MWVXKy92bDR4RWhPQ2JtbS9CZEtrZE42ZGlIRmtiRjZTNzZrQWc9PQo="],
];

const TAG = "tauri-v2.3.13";
const bundleName = (suffix: string) => `Topics_2.3.13${suffix}`;

/** A release as the publish job sees it: bundles, their `.sig`, the dmg, `latest.json`. */
function release(sigs: Readonly<Record<string, string>> = Object.fromEntries(REAL.map(([s, sig]) => [`${bundleName(s)}.sig`, sig]))) {
  const bundles = REAL.map(([s]) => bundleName(s));
  return {
    assetNames: [...bundles, ...Object.keys(sigs), "Topics_2.3.13_universal.dmg", "latest.json"],
    sigs,
    pubkey: PUBKEY,
    manifest: manifestFor(sigs),
  };
}

/** The manifest compose would write for these signatures: one platform per bundle. */
function manifestFor(sigs: Readonly<Record<string, string>>): string {
  const platforms = Object.fromEntries(
    REAL.map(([s]) => [
      `platform-${s}`,
      { signature: sigs[`${bundleName(s)}.sig`] ?? "", url: `https://github.com/armonia/topics-app/releases/download/${TAG}/${bundleName(s)}` },
    ]),
  );
  return JSON.stringify({ version: "2.3.13", platforms });
}

/** The same signature, but claiming another key: swaps the 8 key-id bytes. */
function withKeyId(sig: string, hex: string): string {
  const lines = Buffer.from(sig, "base64").toString("utf8").split("\n");
  const raw = Buffer.from(lines[1], "base64");
  Buffer.from(hex, "hex").copy(raw, 2);
  lines[1] = raw.toString("base64");
  return Buffer.from(lines.join("\n")).toString("base64");
}

const only = (suffix: string, sig: string) =>
  Object.fromEntries(REAL.map(([s, own]) => [`${bundleName(s)}.sig`, s === suffix ? sig : own]));

describe("assert-sig: the signatures of a release", () => {
  test("the real 2.3.13 release is sound against the key in this checkout", () => {
    expect(sigProblems(release())).toEqual([]);
  });

  test("key id: the public key and a real signature name the same key", () => {
    expect(keyIdOf(PUBKEY, "pubkey")).toBe(keyIdOf(REAL[0][1], "signature")!);
    expect(keyIdOf(PUBKEY, "pubkey")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("no .sig at all: says the key was missing from the build", () => {
    const problems = sigProblems({ ...release({}), manifest: undefined });
    expect(problems).toEqual(["no .sig on the release at all: the build ran without TAURI_SIGNING_PRIVATE_KEY, or with --no-sign"]);
  });

  test("one .sig missing: names the one", () => {
    const sigs = Object.fromEntries(REAL.filter(([s]) => s !== "_x64-setup.exe").map(([s, sig]) => [`${bundleName(s)}.sig`, sig]));
    const problems = sigProblems({ ...release(sigs), manifest: undefined });
    expect(problems).toEqual(["missing *_x64-setup.exe.sig"]);
  });

  test("an empty .sig", () => {
    const problems = sigProblems(release(only("_amd64.deb", "")));
    expect(problems.some((p) => p.startsWith("Topics_2.3.13_amd64.deb.sig is empty"))).toBe(true);
  });

  test("something that is not a signature, and a truncated one", () => {
    const garbage = sigProblems(release(only("_amd64.deb", "not a signature")));
    expect(garbage.some((p) => p.includes("is not a minisign signature"))).toBe(true);
    const truncated = sigProblems(release(only("_amd64.deb", REAL[3][1].slice(0, 300))));
    expect(truncated.some((p) => p.includes("is not a minisign signature"))).toBe(true);
  });

  test("signed with ANOTHER key: names both ids", () => {
    const other = withKeyId(REAL[1][1], "0123456789abcdef");
    const problems = sigProblems(release(only("_x64_en-US.msi", other)));
    const wrong = problems.find((p) => p.includes("0123456789abcdef"));
    expect(wrong).toContain(keyIdOf(PUBKEY, "pubkey")!);
    expect(wrong).toContain("Topics_2.3.13_x64_en-US.msi.sig");
  });

  test("latest.json repeating a signature the release does not carry: names the platform", () => {
    const r = release();
    const stale = JSON.parse(r.manifest);
    stale.platforms["platform-_x64-setup.exe"].signature = REAL[1][1];
    const problems = sigProblems({ ...r, manifest: JSON.stringify(stale) });
    expect(problems).toEqual(["latest.json[platform-_x64-setup.exe] carries a signature that is not the one in Topics_2.3.13_x64-setup.exe.sig"]);
  });

  test("latest.json pointing at a bundle that has no .sig", () => {
    const r = release();
    const dangling = JSON.parse(r.manifest);
    dangling.platforms["windows-x86_64"] = { signature: REAL[1][1], url: `https://x/download/${TAG}/Topics_2.3.13_arm64.msi` };
    const problems = sigProblems({ ...r, manifest: JSON.stringify(dangling) });
    expect(problems).toEqual(["latest.json[windows-x86_64] points at Topics_2.3.13_arm64.msi, which has no .sig on the release"]);
  });

  test("latest.json that is not a manifest", () => {
    expect(sigProblems({ ...release(), manifest: "<html>502</html>" })).toEqual(["latest.json is not an updater manifest"]);
    expect(sigProblems({ ...release(), manifest: "{}" })).toEqual(["latest.json is not an updater manifest"]);
  });

  test("before the manifest exists it is not read at all", () => {
    const stale = JSON.stringify({ platforms: { x: { signature: "old", url: "https://x/y.msi" } } });
    expect(sigProblems({ ...release(), manifest: stale }).length).toBeGreaterThan(0);
    expect(sigProblems({ ...release(), manifest: undefined })).toEqual([]);
  });

  test("a pubkey that is not a minisign key stops everything with its own sentence", () => {
    expect(sigProblems({ ...release(), pubkey: "garbage" })).toEqual([
      "tauri.conf.json: plugins.updater.pubkey is not a minisign public key",
    ]);
  });
});

describe("the publish job runs it, in the right places", () => {
  test("once before the manifest is composed (signatures only) and once before publishing", () => {
    const before = WORKFLOW.indexOf("scripts/assert-sig.ts --sigs-only");
    const compose = WORKFLOW.indexOf("Compose and upload the single updater manifest");
    const after = WORKFLOW.indexOf("scripts/assert-sig.ts \"$ID\"");
    const publish = WORKFLOW.indexOf("name: Publish the release");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(compose);
    expect(after).toBeGreaterThan(compose);
    expect(after).toBeLessThan(publish);
  });
});

/** Runs the real CLI with a `gh` that answers from `assets`: a name -> body map. */
function runCli(assets: Record<string, string>, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "assert-sig-"));
  try {
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bun
const target = process.argv[3];
const assets = JSON.parse(process.env.FAKE_ASSETS!);
if (target.startsWith("repos/")) console.log(JSON.stringify({ assets: Object.keys(assets).map((name) => ({ name, url: "asset:" + name })) }));
else process.stdout.write(assets[target.slice("asset:".length)]);
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    const proc = Bun.spawnSync(["bun", join(ROOT, "scripts/assert-sig.ts"), ...args, "123"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO: "armonia/topics-app", FAKE_ASSETS: JSON.stringify(assets) },
    });
    return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout), err: new TextDecoder().decode(proc.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the CLI, end to end with a fake gh", () => {
  const whole = () => {
    const r = release();
    return { ...r.sigs, "latest.json": r.manifest, ...Object.fromEntries(REAL.map(([s]) => [bundleName(s), "bundle"])) };
  };

  test("a whole release exits 0", () => {
    const run = runCli(whole());
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
  });

  test("a release without signatures exits non-zero and says why", () => {
    const run = runCli(Object.fromEntries(Object.entries(whole()).filter(([n]) => !n.endsWith(".sig"))));
    expect(run.code).toBe(1);
    expect(run.err).toContain("no .sig on the release at all");
  });

  test("a signature that differs from latest.json exits non-zero", () => {
    const assets = whole();
    assets["Topics_2.3.13_amd64.deb.sig"] = REAL[1][1];
    const run = runCli(assets);
    expect(run.code).toBe(1);
    expect(run.err).toContain("carries a signature that is not the one in Topics_2.3.13_amd64.deb.sig");
  });

  test("--sigs-only ignores a stale latest.json", () => {
    const assets = whole();
    assets["latest.json"] = "stale";
    expect(runCli(assets, ["--sigs-only"]).code).toBe(0);
    expect(runCli(assets).code).toBe(1);
  });

  test("without a release id it does not guess: exit 2", () => {
    const proc = Bun.spawnSync(["bun", join(ROOT, "scripts/assert-sig.ts")], { env: { ...process.env, REPO: "x/y" } });
    expect(proc.exitCode).toBe(2);
  });
});
