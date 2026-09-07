// The platform-dependent choices of the PTY bridge daemon, kept OUT of the daemon
// itself for one reason: pty-bridge.mjs starts a real daemon the moment it is
// imported, so nothing in it can be tested for a platform the test is not running
// on. These are pure functions that take the platform as an argument, so the
// Windows behaviour is checked from a Mac (see pty-bridge-platform.test.ts).
//
// Every branch here already exists in the twin bridge in Rust
// (desktop-tauri/pty-bridge: TRUE_PROG/TRUE_ARGS, transport::pid_path_for,
// build_env) and in the server (server/utils/path-env.ts). The Node bridge is
// what a checkout actually runs — including the Windows checkout — and it was
// the only one of the three still assuming unix.

import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A program that starts and exits immediately, for the self-test and for the
 * single-instance health probe.
 *
 * On unix `/bin/sh -c :` is the portable choice: /bin/sh is guaranteed
 * everywhere, whereas /bin/true was dropped on macOS 26 (only /usr/bin/true is
 * left there). On Windows neither the program nor the `/tmp` working directory
 * exists, and node-pty answers a missing program with `File not found: ` and an
 * empty name: that string, in the bridge log, is the whole reason no terminal
 * could open on Windows.
 */
export function trivialSpawn(platform = process.platform, tmpDir = tmpdir()) {
  if (platform === 'win32') return { shell: 'cmd.exe', args: ['/c', 'exit'], cwd: tmpDir };
  return { shell: '/bin/sh', args: ['-c', ':'], cwd: '/tmp' };
}

/**
 * Where the pidfile of the bridge owning `socketPath` lives.
 *
 * On unix the socket is a file and the pidfile sits beside it. On Windows the
 * socket is a named pipe (`\\.\pipe\...`), which is not a filesystem path at
 * all: the `.sock` suffix is not there to swap, so the naive replace returns the
 * pipe name itself and writing the pid to it fails. The pidfile goes to TEMP,
 * carrying the pipe's name so two instances stay distinct — the same rule as
 * `transport::pid_path_for` in the Rust bridge and `bridgePidPath()` in the
 * server. If the two halves disagree, the server can never find the owner of a
 * degraded bridge to retire it.
 */
export function pidPathFor(socketPath, platform = process.platform, tmpDir = tmpdir()) {
  if (platform === 'win32') {
    const leaf = socketPath.split('\\').pop() || 'topics-pty-bridge';
    return path.join(tmpDir, `${leaf}.pid`);
  }
  return socketPath.replace(/\.sock$/, '.pid');
}

/**
 * Can `fs.existsSync(socketPath)` answer "is a bridge listening?"
 *
 * Only on unix, where the socket is a file. On Windows `existsSync` of a named
 * pipe ALWAYS answers false, healthy bridge or not, so a guard built on it reads
 * "no bridge, ever" and the probe never even tries to connect. There the
 * question belongs to the connection attempt, which is the only thing that
 * knows (same reasoning as `socketMightExist()` in the server).
 */
export function socketIsFile(platform = process.platform) {
  return platform !== 'win32';
}

/**
 * The extra directories prepended to a PTY child's PATH, and the separator that
 * joins them.
 *
 * The separator is `;` on Windows, where `:` is the drive letter's own
 * punctuation: joining with `:` does not merely fail to separate, it welds
 * `C:\WINDOWS\system32` into a longer nonexistent entry, and the shell we are
 * trying to launch (`powershell.exe`) stops being findable. The directories
 * differ too: the unix list is nine paths that do not exist on Windows, and the
 * Windows list is where per-user CLI installs actually land.
 */
export function pathAugmentation(home, platform = process.platform) {
  if (platform === 'win32') {
    return {
      separator: ';',
      extra: [
        `${home}\\.local\\bin`,
        `${home}\\.bun\\bin`,
        `${home}\\.cargo\\bin`,
        `${home}\\AppData\\Roaming\\npm`,
        `${home}\\AppData\\Local\\Microsoft\\WinGet\\Links`,
      ],
    };
  }
  return {
    separator: ':',
    extra: [
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ],
  };
}

/**
 * The augmented PATH for a PTY child, and the env key to write it under.
 *
 * That key is a Windows problem: environment variables are case-insensitive
 * there and the inherited value is usually spelled `Path`, so adding a `PATH`
 * beside it leaves two entries in conflict and the child reads whichever it
 * likes. We reuse the spelling the parent used and drop any other.
 */
export function augmentedPath(env, home, platform = process.platform) {
  const { separator, extra } = pathAugmentation(home, platform);
  const spellings = platform === 'win32'
    ? Object.keys(env).filter((k) => k.toLowerCase() === 'path')
    : (env.PATH === undefined ? [] : ['PATH']);
  const key = spellings[0] ?? 'PATH';
  const current = spellings.map((k) => env[k]).find((v) => v) || '';
  const seen = new Set();
  const parts = [];
  for (const entry of [...extra, ...current.split(separator)]) {
    const trimmed = (entry || '').trim();
    if (!trimmed) continue;
    // De-duplicated case-insensitively on Windows, where paths are.
    const fingerprint = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    parts.push(trimmed);
  }
  return { key, value: parts.join(separator), drop: spellings.filter((k) => k !== key) };
}
