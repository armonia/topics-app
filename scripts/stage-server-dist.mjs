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
import { cpSync, mkdirSync, rmSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const root = join(here, '..');                        // repo root
const out = join(root, 'electron-app', 'server-dist');
const isWin = process.platform === 'win32';

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
  console.warn('[stage] openssl cert gen failed — the server will need NO_TLS=1:', e.message);
}

console.log('[stage] done ->', out);
