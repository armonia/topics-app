#!/usr/bin/env bun
/**
 * ASSERT-SIG: the signatures the updater checks exist, were made with OUR key,
 * and say the same thing as `latest.json`.
 *
 * WHY. A client verifies every update against the public key in
 * `tauri.conf.json` and, when that fails, refuses in silence: the toast says
 * "error", nobody sees a stack trace, and the next release is just as dead.
 * `check-release-assets` counts file NAMES and `compose-release-manifest` copies
 * whatever each `.sig` holds into `latest.json`; neither asks whose signature it
 * is. Three ways to ship a release that looks whole and updates nobody:
 *
 *   - it was signed with ANOTHER key (a secret that was rotated, or pasted from
 *     a different keypair): every file is there, every name matches;
 *   - a `.sig` is empty, truncated, or not a minisign signature at all;
 *   - `latest.json` carries a signature that is not the one on the release: a
 *     build job re-run after the manifest was composed replaces the bundle and
 *     its `.sig` and leaves the old signature in the manifest.
 *
 * And one that is loud today and is kept loud on purpose: NO `.sig` at all. The
 * tauri CLI source fails `tauri build` when the key is unset, so a missing
 * signature already stops the release through the red build and the asset gate;
 * this keeps it stopped if that ever changes (a `--no-sign` in the args, a CLI
 * that downgrades the error to a warning).
 *
 * WHAT IT DOES NOT DO: verify the signature over the bundle bytes. That needs
 * the ~100 MB artifacts and a hash pass, for a failure the key id already names:
 * a different id is proof of a different key. The id is a label, so a match
 * proves who the file CLAIMS to be signed by; the cryptographic check stays in
 * the client, which is where it has to be.
 *
 * TWO CALLS from `tauri-release.yml`, same script:
 *   --sigs-only  before the manifest is composed: the inputs compose will trust;
 *   (default)    after it is uploaded: the state the clients will actually fetch.
 * The first one ignores `latest.json` because on a re-run it is the PREVIOUS
 * attempt's, and would fail against the signatures just rebuilt.
 *
 * Exit 0 sound, 1 problems (each one named), 2 could not measure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_SUFFIXES } from "./check-release-assets";

/** `*.sig` of every bundle the updater downloads; the list is owned by the asset gate. */
const SIG_SUFFIXES = ASSET_SUFFIXES.filter((s) => s.endsWith(".sig"));

export interface SigInput {
  /** Names of every asset on the release. */
  assetNames: readonly string[];
  /** Content of each `.sig` asset, by asset name. */
  sigs: Readonly<Record<string, string>>;
  /** `plugins.updater.pubkey` as it sits in tauri.conf.json. */
  pubkey: string;
  /** `latest.json` as text. Left out when the manifest is not composed yet. */
  manifest?: string;
}

/**
 * Key id (hex) of a minisign file as Tauri stores it: base64 of a text whose
 * second line is base64(2-byte algorithm + 8-byte key id + payload). The public
 * key and a `.sig` share the shape and differ in the payload (32 vs 64 bytes),
 * and a signature has a trailer as well (trusted comment, then the global
 * signature over it): without it the client cannot verify, so a signature cut
 * short is not one.
 */
export function keyIdOf(encoded: string, kind: "pubkey" | "signature"): string | null {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").split("\n");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const alg = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== (kind === "pubkey" ? 42 : 74) || (alg !== "Ed" && alg !== "ED")) return null;
  const trailer = lines[2]?.startsWith("trusted comment: ") && Buffer.from(lines[3] ?? "", "base64").length === 64;
  if (kind === "signature" && !trailer) return null;
  return raw.subarray(2, 10).toString("hex");
}

function manifestProblems(raw: string, sigs: Readonly<Record<string, string>>): string[] {
  let platforms: Record<string, { signature?: unknown; url?: unknown }> | undefined;
  try {
    platforms = (JSON.parse(raw) as { platforms?: typeof platforms }).platforms;
  } catch {
    platforms = undefined;
  }
  if (!platforms || typeof platforms !== "object") return ["latest.json is not an updater manifest"];
  const problems: string[] = [];
  for (const [platform, entry] of Object.entries(platforms)) {
    const file = String(entry?.url ?? "").split("/").pop() ?? "";
    const published = sigs[`${file}.sig`];
    if (published === undefined) {
      problems.push(`latest.json[${platform}] points at ${file}, which has no .sig on the release`);
    } else if (published.trim() !== String(entry.signature ?? "").trim()) {
      problems.push(`latest.json[${platform}] carries a signature that is not the one in ${file}.sig`);
    }
  }
  return problems;
}

/** Every problem found, one sentence each. Empty means the release can go out. */
export function sigProblems({ assetNames, sigs, pubkey, manifest }: SigInput): string[] {
  const ours = keyIdOf(pubkey, "pubkey");
  if (!ours) return ["tauri.conf.json: plugins.updater.pubkey is not a minisign public key"];
  const problems: string[] = [];
  const missing = SIG_SUFFIXES.filter((s) => !assetNames.some((n) => n.endsWith(s)));
  if (missing.length === SIG_SUFFIXES.length) {
    problems.push("no .sig on the release at all: the build ran without TAURI_SIGNING_PRIVATE_KEY, or with --no-sign");
  } else {
    for (const s of missing) problems.push(`missing *${s}`);
  }
  for (const name of assetNames.filter((n) => n.endsWith(".sig"))) {
    const content = sigs[name] ?? "";
    const id = keyIdOf(content, "signature");
    if (!content.trim()) problems.push(`${name} is empty`);
    else if (!id) problems.push(`${name} is not a minisign signature`);
    else if (id !== ours) problems.push(`${name} was signed with key ${id}, the app trusts ${ours}`);
  }
  if (manifest !== undefined) problems.push(...manifestProblems(manifest, sigs));
  return problems;
}

function gh(args: string[]): string {
  const proc = Bun.spawnSync(["gh", "api", ...args]);
  if (proc.exitCode !== 0) {
    console.error(`[sig] could not measure: gh api ${args[0]} exited ${proc.exitCode}`);
    console.error(new TextDecoder().decode(proc.stderr));
    process.exit(2);
  }
  return new TextDecoder().decode(proc.stdout);
}

if (import.meta.main) {
  const sigsOnly = process.argv.includes("--sigs-only");
  const id = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const repo = process.env.REPO;
  if (!id || !repo) {
    console.error("usage: REPO=owner/name bun run scripts/assert-sig.ts [--sigs-only] <release-id>");
    process.exit(2);
  }
  const release = JSON.parse(gh([`repos/${repo}/releases/${id}`])) as { assets: { name: string; url: string }[] };
  const fetchAsset = (a: { url: string }) => gh([a.url, "-H", "Accept: application/octet-stream"]);
  const sigs = Object.fromEntries(
    release.assets.filter((a) => a.name.endsWith(".sig")).map((a) => [a.name, fetchAsset(a)]),
  );
  const latest = release.assets.find((a) => a.name === "latest.json");
  const conf = JSON.parse(readFileSync(join(import.meta.dir, "../desktop-tauri/src-tauri/tauri.conf.json"), "utf8"));
  const problems = sigProblems({
    assetNames: release.assets.map((a) => a.name),
    sigs,
    pubkey: conf.plugins.updater.pubkey,
    manifest: sigsOnly ? undefined : latest ? fetchAsset(latest) : "",
  });
  if (problems.length > 0) {
    console.error(`[sig] ${problems.length} problem(s), the release does not go out:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[sig] ${Object.keys(sigs).length} signatures, all made with the app's key${sigsOnly ? "" : ", and latest.json repeats them"}.`);
}
