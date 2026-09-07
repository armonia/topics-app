// Does the PTY bridge boot AND open a terminal on THIS machine?
//
//   node scripts/pty-bridge-probe.mjs        (from the repo root, on any platform)
//   tools/topwin run "node scripts\\pty-bridge-probe.mjs"   (on the Windows PC)
//
// It exists because the answer differed per platform and nothing said so: on
// Windows the daemon died in its self-test before the socket ever existed, and
// the only trace was one line in a log file nobody read, while the server said
// «Bridge not connected» and the suite said «no terminal appears». Three
// different sentences for one defect. This starts a bridge of its own on a
// scratch socket, asks it for a real shell and waits for real bytes: it either
// prints what the shell wrote, or the reason it could not.
//
// Deliberately NOT a unit test: what it exercises is node-pty against the
// platform underneath, which is precisely what a mock removes.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'server', 'pty-bridge.mjs');
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const socket = isWindows
  ? `\\\\.\\pipe\\topics-pty-probe-${stamp}`
  : path.join(os.tmpdir(), `topics-pty-probe-${stamp}.sock`);
const logPath = path.join(os.tmpdir(), `topics-pty-probe-${stamp}.log`);

const shell = isWindows ? (process.env.TOPICS_SHELL || 'powershell.exe') : (process.env.SHELL || '/bin/sh');
const args = isWindows ? ['-NoLogo', '-Command', 'Write-Output PROBE_OK'] : ['-c', 'echo PROBE_OK'];

function bail(why) {
  let log = '';
  try { log = fs.readFileSync(logPath, 'utf8').trim(); } catch { /* the bridge never wrote */ }
  try { child.kill(); } catch { /* already gone */ }
  console.error(`FAIL: ${why}`);
  if (log) console.error(`bridge log:\n${log}`);
  process.exit(1);
}

const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [bridge, '--socket', socket, '--parent-pid', String(process.pid)], {
  stdio: ['ignore', 'ignore', logFd],
  detached: false,
});
child.on('error', (e) => bail(`could not spawn the bridge: ${e.message}`));

const deadline = Date.now() + 20_000;

function connect() {
  const conn = net.connect(socket);
  conn.on('error', () => {
    if (child.exitCode !== null) bail(`the bridge exited with code ${child.exitCode} before listening`);
    if (Date.now() > deadline) bail('the bridge never accepted a connection');
    setTimeout(connect, 200);
  });
  conn.on('connect', () => {
    let buffer = '';
    let seen = '';
    // The shell echoes and keeps talking after the answer: without this the
    // success branch fires again on every later frame.
    let done = false;
    conn.write(JSON.stringify({
      type: 'create', id: 'probe', shell, args, cwd: os.tmpdir(), cols: 80, rows: 24,
    }) + '\n');
    const timer = setTimeout(() => bail(`no PROBE_OK from ${shell} within 15s (got: ${JSON.stringify(seen.slice(-200))})`), 15_000);
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while (!done && (nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 'probe') continue;
        if (msg.type === 'error') { clearTimeout(timer); bail(`the bridge refused the create: ${msg.error}`); }
        if (msg.type === 'data') seen += msg.data;
        if (seen.includes('PROBE_OK')) {
          done = true;
          clearTimeout(timer);
          console.log(`OK: ${process.platform} bridge on ${socket}`);
          console.log(`OK: ${shell} answered through the PTY`);
          conn.write(JSON.stringify({ type: 'kill', id: 'probe' }) + '\n');
          setTimeout(() => { conn.destroy(); child.kill(); process.exit(0); }, 300);
          return;
        }
      }
    });
  });
}

setTimeout(connect, 300);
