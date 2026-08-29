#!/usr/bin/env bun
/**
 * Build the client WITHOUT ever leaving `public/` empty.
 *
 * `vite build` runs with `emptyOutDir`: it wipes first and writes after. On
 * 29/08, after three back-to-back lands, it died between the two (the server
 * restarted at 04:37, which a land itself can trigger) and `public/` stayed
 * wiped: `assets/` empty, `index.html` gone. Everything else was green - clean
 * tree, no build running, no error anywhere - and the only broken thing was
 * what people see.
 *
 * So the build never writes into the directory it is serving from: vite builds
 * into a private staging dir, the result is VERIFIED there, and only a whole
 * bundle gets published (see `build-client-publish.ts` for the flip). A build
 * that dies at any point leaves the previous bundle exactly where it was.
 *
 * Usage:
 *   bun run build:client                 build and publish to public/
 *   bun run build:client --out <dir>     build THERE and leave public/ alone
 *                                        (what TOPICS_E2E_BUNDLE_DIR wants)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { missingBundleAssets } from "../server/lib/client-bundle";
import { publishBundle } from "./build-client-publish";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLIENT_DIR = join(REPO_ROOT, "client");
const PUBLIC_DIR = join(REPO_ROOT, "public");
const STAGING_ROOT = join(REPO_ROOT, ".build-client");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function run(cmd: string[], cwd: string): number {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit", env: process.env });
  return r.status ?? 1;
}

function buildInto(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // `tsc -b` first, exactly as client/package.json did: a type error must stop
  // the build before anything is published. Both binaries are launched THROUGH
  // BUN: their shebang says `node`, and the node on this machine can be older
  // than what vite 7 requires (measured here: node 18, and the build died on
  // `crypto.hash is not a function`).
  const tsc = run(["bun", join(CLIENT_DIR, "node_modules", ".bin", "tsc"), "-b"], CLIENT_DIR);
  if (tsc !== 0) fail(`tsc -b failed (exit ${tsc}) - public/ untouched.`);
  // `--emptyOutDir` is the confirmation vite wants for an outDir outside its
  // root. It empties the STAGING dir, which is ours and already empty.
  const vite = run(
    ["bun", join(CLIENT_DIR, "node_modules", ".bin", "vite"), "build", "--outDir", outDir, "--emptyOutDir"],
    CLIENT_DIR,
  );
  if (vite !== 0) fail(`vite build failed (exit ${vite}) - public/ untouched.`);
  // Exit code 0 is not the artifact. This is the check the land was missing.
  const missing = missingBundleAssets(outDir);
  if (missing.length > 0) {
    fail(`the build ended 0 but produced no servable bundle (${missing.slice(0, 5).join(", ")}) - public/ untouched.`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outside = outIdx >= 0 ? resolve(argv[outIdx + 1] ?? "") : null;
  if (outIdx >= 0 && !outside) fail("--out wants a directory.");

  if (outside) {
    buildInto(outside);
    console.log(`✓ bundle built in ${outside} (public/ untouched)`);
    return;
  }

  mkdirSync(STAGING_ROOT, { recursive: true });
  markStagingRoot();
  // One staging dir per run: two builds in the same checkout must never write
  // into the same directory.
  const staging = join(STAGING_ROOT, `${process.pid}-${Date.now()}`);
  try {
    buildInto(staging);
    const res = publishBundle(staging, PUBLIC_DIR);
    if (res.broken) fail(`published bundle incomplete: ${res.broken}`);
    if (res.swept > 0) console.log(`  swept ${res.swept} stale asset${res.swept === 1 ? "" : "s"}`);
    const rev = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8").match(/\/assets\/(index-[^"]+\.js)/)?.[1];
    console.log(`✓ client published to public/${rev ? ` (${rev})` : ""}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** A marker file makes `.build-client/` self-explanatory in a listing. */
function markStagingRoot(): void {
  const readme = join(STAGING_ROOT, "README");
  if (existsSync(readme)) return;
  try {
    writeFileSync(readme, "Staging dir of `bun run build:client`. Safe to delete.\n");
  } catch {
    // Cosmetic only.
  }
}

main();
