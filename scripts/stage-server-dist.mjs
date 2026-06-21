#!/usr/bin/env node
// Stage everything the bundled server needs into electron-app/server-dist/,
// which electron-builder copies to <App>/Resources/server/ (extraResources).
//
// Produces, for the CURRENT OS/arch (run this on each target's CI runner):
//   server-dist/bin/{bun,node}[.exe]   — runtimes (node is for the node-pty bridge)
//   server-dist/server.ts, server/, public/, package.json
//   server-dist/node_modules/          — server deps incl. node-pty prebuilds
//   server-dist/certs/{key,fullchain}.pem — fresh self-signed localhost cert
//
// All commands run via execFileSync (no shell) with a static argv.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const root = join(here, '..');                        // repo root
const out = join(root, 'electron-app', 'server-dist');
const isWin = process.platform === 'win32';
// macOS Universal build: ship ONE app that runs natively on both Apple Silicon
// and Intel. node_modules already carries both node-pty prebuilds (darwin-arm64
// + darwin-x64), so only the bun + node runtimes need to be fat (lipo) binaries.
// Set by the release workflow's `--mac --universal` job. (GitHub retired the
// macos-13 Intel runner, so we can no longer build x64 natively on its own box.)
const universalMac = process.env.STAGE_UNIVERSAL === '1' && process.platform === 'darwin';

function which(cmd) {
  try {
    const r = execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    return r.split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

console.log('[stage] cleaning', out);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });

// 1. Runtimes — bun (server) + node (node-pty bridge spawned by terminal.ts)
if (universalMac) {
  stageUniversalRuntimes();
} else {
  const bunSrc = which('bun');
  if (!bunSrc) { console.error('[stage] bun not found on PATH'); process.exit(1); }
  const nodeSrc = process.execPath; // the node executing this script
  copyFileSync(bunSrc, join(out, 'bin', isWin ? 'bun.exe' : 'bun'));
  copyFileSync(nodeSrc, join(out, 'bin', isWin ? 'node.exe' : 'node'));
  if (!isWin) {
    chmodSync(join(out, 'bin', 'bun'), 0o755);
    chmodSync(join(out, 'bin', 'node'), 0o755);
  }
  console.log('[stage] bun  <-', bunSrc);
  console.log('[stage] node <-', nodeSrc);
}

// Build fat (x86_64 + arm64) bun & node so a single Universal app runs natively
// on every Mac. We download each arch's official binary and `lipo -create` them.
// Pinned to the host's bun/node VERSIONS so behaviour matches the native jobs.
function stageUniversalRuntimes() {
  const tmp = mkdtempSync(join(tmpdir(), 'stage-univ-'));
  const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const dl = (url, dest) => { console.log('[stage] download', url); sh('curl', ['-fsSL', '--retry', '3', url, '-o', dest]); };

  // ── bun: bun-darwin-{x64,aarch64}.zip → bun → lipo ──
  const bunVer = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
  const bunSlices = [];
  for (const [arch, asset] of [['x64', 'bun-darwin-x64'], ['arm64', 'bun-darwin-aarch64']]) {
    const zip = join(tmp, `${asset}.zip`);
    dl(`https://github.com/oven-sh/bun/releases/download/bun-v${bunVer}/${asset}.zip`, zip);
    sh('unzip', ['-q', '-o', zip, '-d', tmp]);
    const bin = join(tmp, asset, 'bun');
    if (!existsSync(bin)) { console.error('[stage] bun slice missing:', bin); process.exit(1); }
    bunSlices.push(bin);
  }
  sh('lipo', ['-create', ...bunSlices, '-output', join(out, 'bin', 'bun')]);
  chmodSync(join(out, 'bin', 'bun'), 0o755);
  console.log('[stage] bun  <- universal (x86_64 + arm64), v' + bunVer);

  // ── node: node-v<ver>-darwin-{x64,arm64}.tar.gz → bin/node → lipo ──
  const nodeVer = process.versions.node;
  const nodeSlices = [];
  for (const arch of ['x64', 'arm64']) {
    const base = `node-v${nodeVer}-darwin-${arch}`;
    const tgz = join(tmp, `${base}.tar.gz`);
    dl(`https://nodejs.org/dist/v${nodeVer}/${base}.tar.gz`, tgz);
    sh('tar', ['-xzf', tgz, '-C', tmp]);
    const bin = join(tmp, base, 'bin', 'node');
    if (!existsSync(bin)) { console.error('[stage] node slice missing:', bin); process.exit(1); }
    nodeSlices.push(bin);
  }
  sh('lipo', ['-create', ...nodeSlices, '-output', join(out, 'bin', 'node')]);
  chmodSync(join(out, 'bin', 'node'), 0o755);
  console.log('[stage] node <- universal (x86_64 + arm64), v' + nodeVer);

  rmSync(tmp, { recursive: true, force: true });

  // Fail loudly if either runtime isn't actually fat — a thin binary here would
  // silently ship a Mac app that crashes on the other architecture.
  for (const b of ['bun', 'node']) {
    const archs = execFileSync('lipo', ['-archs', join(out, 'bin', b)], { encoding: 'utf8' }).trim();
    if (!(archs.includes('x86_64') && archs.includes('arm64'))) {
      console.error(`[stage] ${b} is not universal (got: ${archs})`); process.exit(1);
    }
    console.log(`[stage] verified ${b}: ${archs}`);
  }
  // node-pty must carry BOTH darwin prebuilds for the universal app to work.
  const pre = join(out, 'node_modules', 'node-pty', 'prebuilds');
  // (node_modules is copied in step 3 below; assert after that — see tail check.)
  globalThis.__assertNodePtyUniversal = () => {
    for (const d of ['darwin-x64', 'darwin-arm64']) {
      if (!existsSync(join(pre, d))) { console.error('[stage] node-pty prebuild missing:', d); process.exit(1); }
    }
    console.log('[stage] verified node-pty prebuilds: darwin-x64 + darwin-arm64');
  };
}

// 2. Server source + static assets (server.ts resolves these via import.meta.dir)
for (const p of ['server.ts', 'server', 'public', 'package.json']) {
  const src = join(root, p);
  if (existsSync(src)) cpSync(src, join(out, p), { recursive: true });
  else console.warn('[stage] missing (skipped):', p);
}

// 3. Production node_modules (incl. node-pty native prebuilds, @anthropic-ai/sdk,
//    web-push, zod, playwright-core). Copied whole for transitive correctness.
console.log('[stage] copying node_modules (this is the bulky step)…');
cpSync(join(root, 'node_modules'), join(out, 'node_modules'), { recursive: true });
// For the Universal mac merge, STRIP every symlink from the bundled node_modules.
// @electron/universal aborts with "the number of mach-o files is not the same
// between the arm64 and x64 builds" when symlinks are present: the only ones
// here are node_modules/.bin/* CLI shims (playwright, anthropic-ai-sdk, web-push)
// whose targets resolve to different paths in the two per-arch temp app trees.
// The server resolves modules by directory, never via .bin, so dropping them is
// safe. Native (non-universal) jobs keep them — they don't go through the merge.
if (universalMac) {
  execFileSync('find', [join(out, 'node_modules'), '-type', 'l', '-delete'], { stdio: 'inherit' });
  const left = execFileSync('find', [join(out, 'node_modules'), '-type', 'l'], { encoding: 'utf8' }).trim();
  if (left) { console.error('[stage] symlinks still present after strip:\n' + left); process.exit(1); }
  console.log('[stage] stripped node_modules symlinks (.bin shims) for the universal merge');
}
// For the Universal build, confirm node-pty shipped both darwin prebuilds.
if (universalMac && globalThis.__assertNodePtyUniversal) globalThis.__assertNodePtyUniversal();

// 4. Self-signed loopback TLS cert. The committed certs/ are gitignored and the
//    private key must NOT ship; generate a throwaway localhost cert per build.
const certDir = join(out, 'certs');
mkdirSync(certDir, { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'fullchain.pem'),
    '-days', '3650', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'inherit' });
  console.log('[stage] generated self-signed localhost cert');
} catch (e) {
  // HARD FAIL: the packaged server binds https://127.0.0.1 and nothing sets
  // NO_TLS=1 at runtime, so a missing cert means the bundled server never
  // becomes healthy and the app ships broken. Better to fail the build than
  // publish a non-starting installer.
  console.error('[stage] openssl cert gen FAILED — refusing to stage a server that cannot bind TLS:', e.message);
  process.exit(1);
}

console.log('[stage] done ->', out);
