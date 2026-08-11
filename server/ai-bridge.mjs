// AI Bridge Daemon — hosts Claude Code `--output-format stream-json` sessions in
// a DETACHED process so chat/dispatch AI turns survive a server restart AND a
// crash (the server reconnects and re-attaches to the still-running turn).
//
// Sibling of pty-bridge.mjs (same singleton / orphan-grace / Unix-socket NDJSON
// scaffolding) but deliberately NOT a PTY: a pseudo-terminal's cooked mode
// corrupts clean NDJSON (stdin echo bleeds into stdout, \n→\r\n, canonical mode
// truncates >1KB stdin lines). We use PLAIN PIPES via child_process.spawn, and a
// per-session APPEND-ONLY, OFFSET-ADDRESSABLE, LINE-ALIGNED store file so a
// reattaching server can replay exactly the bytes it missed, starting on a JSON
// line boundary. Runs under the same Bun as the server (no node-pty → no Rust
// port needed; the Tauri desktop shell talks to the launchd Bun server).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

// The user's REAL home (getpwuid, not $HOME): the daemon can be respawned by a
// server whose $HOME was clobbered by a sandbox ancestor. An explicit per-spawn
// env.HOME still wins (test sandboxes rely on that). Mirrors pty-bridge.mjs.
let _realHome;
function realHome() {
  if (_realHome !== undefined) return _realHome;
  let h = '';
  try { h = userInfo().homedir || ''; } catch { /* getpwuid failed */ }
  _realHome = h || process.env.HOME || '';
  return _realHome;
}

// --- Configuration ---
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const socketPath = argOf('--socket') || getDefaultSocketPath();
const pidPath = socketPath.replace(/\.sock$/, '.pid');
const storeDir = argOf('--store-dir') || path.join('/tmp', `topics-ai-bridge-store-${hashCwd()}`);
// PID of the server that spawned us, for the orphan monitor. NOT derivable from
// process.ppid here — Bun never refreshes it after reparenting to init (see the
// monitor in start()). Absent when the daemon is started by hand.
const parentPid = Number(argOf('--parent-pid')) || null;
// A single turn's NDJSON is normally well under this; a run that blows past it is
// pathological → we emit `error` and the server falls back to a fresh turn.
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;
const RETENTION_MS = 6 * 60 * 60_000; // sweep dead session files older than 6h
const SWEEP_EVERY_MS = 10 * 60_000;
// Retire a daemon nobody is using. Generous: it applies even with a LIVE parent,
// and a server sitting between turns holds no client connection.
const IDLE_EXIT_MS = 30 * 60_000;

function hashCwd() {
  return createHash('md5').update(process.cwd()).digest('hex').slice(0, 8);
}
function getDefaultSocketPath() {
  return `/tmp/topics-ai-bridge-${hashCwd()}.sock`;
}

try { fs.mkdirSync(storeDir, { recursive: true }); } catch { /* best effort */ }

// --- State ---
/**
 * Session = {
 *   child, pid, alive, exitCode, createdAt,
 *   storePath, storeFd, endOffset,      // append-only NDJSON store
 *   attached: Map<socket, deliveredOffset>,  // clients wanting live `data` frames
 *   meta: { cwd, argv },
 * }
 */
const sessions = new Map();  // id -> Session
const clients = new Set();   // connected server sockets

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const client of clients) { try { client.write(line); } catch { /* dead socket */ } }
}
function sendTo(client, msg) {
  try { client.write(JSON.stringify(msg) + '\n'); } catch { /* dead socket */ }
}

function storePathFor(id) {
  // id is the topics sessionKey (e.g. "topic:ab12cd34"); sanitize for a filename.
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(storeDir, `${safe}.ndjson`);
}

// Build the child env: mirror pty-bridge's HOME anchoring + UTF-8 locale + PATH
// hardening so a `claude` spawned under launchd behaves identically to the PTY
// path it replaces.
function buildEnv(env) {
  const merged = { ...process.env, HOME: realHome(), ...env };
  for (const k of Object.keys(merged)) { if (merged[k] == null) delete merged[k]; }
  const hasUtf8 = [merged.LC_ALL, merged.LC_CTYPE, merged.LANG].some((v) => typeof v === 'string' && /utf-?8/i.test(v));
  if (!hasUtf8) { merged.LANG = 'en_US.UTF-8'; merged.LC_CTYPE = 'en_US.UTF-8'; }
  const home = merged.HOME || realHome();
  const extra = [`${home}/.local/bin`, `${home}/.bun/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  merged.PATH = [...extra, merged.PATH || ''].filter(Boolean).join(':');
  return merged;
}

function appendToStore(session, buf) {
  if (session.storeClosed) return null; // fd closed (session killed) — drop silently, no EBADF
  const startOffset = session.endOffset;
  try {
    fs.writeSync(session.storeFd, buf);
    session.endOffset += buf.byteLength;
  } catch (e) {
    console.error(`[AI Bridge] store write failed for ${session.id}: ${e.message}`);
    return null;
  }
  return startOffset;
}

// Stream the store bytes [fromOffset, endOffset) to a freshly-attaching socket.
// SYNCHRONOUS read + attach registration in one tick so a concurrent stdout
// 'data' event (which would append + broadcast live) can never interleave and
// create an overlap/gap — node is single-threaded, the child 'data' callback
// cannot run in the middle of this function. Slicing does NOT weaken that: the
// loop below is synchronous from the first byte to the `attached.set`, so no
// other callback can run in the middle of it either.
//
// POSIZIONALE, non `readFileSync` dell'intero file. Il vecchio codice leggeva
// TUTTO lo store a ogni attach e poi ne buttava via il prefisso — anche per
// `resyncStream`, che riattacca dall'ULTIMO byte consumato e nel caso normale
// vuole ZERO byte. Con 27 store fino a 6,9 MB e una raffica di riattacchi dopo
// ogni riconnessione del socket, quella era decine di MB letti e scartati per
// non consegnare niente.
//
// A FETTE, non un frame solo. Un attach da offset 0 su uno store da 7 MB
// produceva UNA riga JSON da ~9,8 MB: base64 dell'intero file più la stringa
// JSON che lo avvolge, cioè ~25 MB di stringhe temporanee per attach, e dal
// lato server un `JSON.parse` altrettanto grande prima che UN solo byte
// diventasse utile. A fette il picco di memoria è costante, il server piega
// mentre il resto arriva, e — cosa che conta per il timeout — chi aspetta
// l'ack vede il replay PROGREDIRE invece di un silenzio lungo secondi.
// Taglia della fetta. Misurata, non scelta a occhio: fette troppo piccole
// pagano il costo per-frame (una riga JSON, un base64, una write, un parse
// dall'altra parte) su un replay che di byte ne ha comunque milioni; fette
// troppo grosse riportano il picco di memoria e la lunga muta che il taglio
// serviva a togliere. L'env esiste per il banco (`ai-bridge-replay-bench.ts`)
// e per i test, non per la produzione.
const REPLAY_SLICE_BYTES = Number(process.env.TOPICS_AI_BRIDGE_REPLAY_SLICE) || 1024 * 1024;

function replayTo(session, socket, fromOffset) {
  const end = session.endOffset;
  const from = Math.max(0, Math.min(fromOffset | 0, end));
  if (end > from) {
    let fd = null;
    try {
      fd = fs.openSync(session.storePath, 'r');
      const buf = Buffer.allocUnsafe(Math.min(REPLAY_SLICE_BYTES, end - from));
      let pos = from;
      while (pos < end) {
        const want = Math.min(buf.byteLength, end - pos);
        const got = fs.readSync(fd, buf, 0, want, pos);
        if (got <= 0) break; // file troncato sotto i piedi: meglio corto che in loop
        sendTo(socket, { type: 'data', id: session.id, offset: pos, chunk: buf.subarray(0, got).toString('base64') });
        pos += got;
      }
    } catch (e) {
      console.error(`[AI Bridge] replay read failed for ${session.id}: ${e.message}`);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* già chiuso */ } }
    }
  }
  session.attached.set(socket, end);
}

function handleMessage(msg, client) {
  switch (msg.type) {
    case 'spawn': {
      const { id, cliPath, args, cwd, env } = msg;
      const existing = sessions.get(id);
      // IDEMPOTENT: a live session for this id already exists (e.g. a
      // double-fire, or a server restart re-spawning onto the child the daemon
      // kept alive) → ack the existing pid, never spawn a second `claude` on
      // the same on-disk transcript.
      //
      // The caller is ATTACHED here for the same reason the fresh branch below
      // attaches at offset 0: whoever spawns wants this child's live stream.
      // Skipping it acked a pid and then delivered nothing — `write` still
      // reached the child's stdin, the child answered, and the answer went to
      // the sockets in `attached` (all of them stale). The turn hung on
      // "stream lento — il provider è ancora connesso" until something else
      // attached, i.e. forever.
      //
      // From `endOffset`, not 0: this is a NEW turn on an existing child, so
      // the caller wants what the child emits from now on. Replaying the store
      // would re-fold every earlier turn of that child's lifetime through the
      // caller's fresh handler. A caller that does want the history asks for it
      // explicitly with `attach` (that is what reattach's SCAN pass does).
      if (existing && existing.alive) {
        replayTo(existing, client, existing.endOffset);
        sendTo(client, { type: 'spawned', id, pid: existing.pid, resumed: true });
        break;
      }
      // A dead session lingering for late-attach → replace it (fresh child = fresh store).
      if (existing) { try { fs.closeSync(existing.storeFd); } catch {} sessions.delete(id); }

      const storePath = storePathFor(id);
      let storeFd;
      try { storeFd = fs.openSync(storePath, 'w'); } // truncate: a new child = a fresh output stream
      catch (e) { sendTo(client, { type: 'error', id, error: `store open failed: ${e.message}` }); break; }

      let child;
      try {
        child = spawn(cliPath, args || [], { cwd: cwd || realHome(), stdio: ['pipe', 'pipe', 'pipe'], env: buildEnv(env) });
      } catch (e) {
        try { fs.closeSync(storeFd); } catch {}
        sendTo(client, { type: 'error', id, error: `spawn failed: ${e.message}` });
        break;
      }

      const session = {
        id, child, pid: child.pid, alive: true, exitCode: null, createdAt: Date.now(),
        storePath, storeFd, endOffset: 0, attached: new Map(), meta: { cwd, argv: [cliPath, ...(args || [])] },
      };
      sessions.set(id, session);

      child.stdout.on('data', (buf) => {
        const startOffset = appendToStore(session, buf);
        if (startOffset === null) return;
        if (session.endOffset > MAX_STORE_BYTES) {
          broadcast({ type: 'error', id, error: 'store size cap exceeded' });
        }
        const frame = { type: 'data', id, offset: startOffset, chunk: buf.toString('base64') };
        for (const [sock, delivered] of session.attached) {
          if (delivered <= startOffset) {
            sendTo(sock, frame);
            session.attached.set(sock, session.endOffset);
          }
        }
      });
      child.stderr.on('data', (buf) => {
        const frame = { type: 'stderr', id, chunk: buf.toString('base64') };
        for (const sock of session.attached.keys()) sendTo(sock, frame);
      });
      const onDead = (code) => {
        if (!session.alive) return;
        session.alive = false;
        session.exitCode = typeof code === 'number' ? code : null;
        broadcast({ type: 'exit', id, exitCode: session.exitCode, endOffset: session.endOffset });
        if (session.killing) {
          // Explicit teardown: the child is truly gone now → close fd + remove.
          // (Closing in `kill` while the child still emitted during the
          // SIGTERM→SIGKILL grace caused EBADF writes that DROPPED the tail of
          // the turn's output — the "no output" dispatch failures.)
          session.storeClosed = true;
          try { fs.closeSync(session.storeFd); } catch { /* already closed */ }
          try { fs.unlinkSync(session.storePath); } catch { /* already gone */ }
          sessions.delete(id);
        }
        // else keep the session + store for a late attach (Case 1); the sweep reaps it.
      };
      child.on('close', (code) => onDead(code));
      child.on('error', (e) => { console.error(`[AI Bridge] child error ${id}: ${e.message}`); onDead(null); });

      // The spawning client is implicitly attached from offset 0 (it wants the
      // live stream of the turn it just started).
      replayTo(session, client, 0);
      sendTo(client, { type: 'spawned', id, pid: child.pid });
      break;
    }
    case 'write': {
      const s = sessions.get(msg.id);
      if (!s || !s.alive) { sendTo(client, { type: 'error', id: msg.id, error: 'no live session' }); break; }
      try { s.child.stdin.write(msg.data); } catch (e) { sendTo(client, { type: 'error', id: msg.id, error: e.message }); }
      break;
    }
    case 'attach': {
      const s = sessions.get(msg.id);
      if (!s) { sendTo(client, { type: 'attached', id: msg.id, endOffset: 0, alive: false, exitCode: null, missing: true }); break; }
      replayTo(s, client, msg.fromOffset || 0);
      sendTo(client, { type: 'attached', id: msg.id, endOffset: s.endOffset, alive: s.alive, exitCode: s.exitCode });
      break;
    }
    case 'detach': {
      const s = sessions.get(msg.id);
      if (s) s.attached.delete(client);
      break;
    }
    case 'signal': {
      const s = sessions.get(msg.id);
      if (s && s.alive) { try { s.child.kill(msg.signal || 'SIGINT'); } catch {} }
      break;
    }
    case 'kill': {
      const s = sessions.get(msg.id);
      if (s) {
        s.killing = true; // onDead does fd close + unlink + delete once the child truly exits
        try { s.child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { if (s.alive) s.child.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
      }
      broadcast({ type: 'killed', id: msg.id });
      break;
    }
    case 'list': {
      const list = [];
      for (const [id, s] of sessions) list.push({ id, pid: s.pid, alive: s.alive, exitCode: s.exitCode, endOffset: s.endOffset, createdAt: s.createdAt });
      sendTo(client, { type: 'list', sessions: list });
      break;
    }
    case 'ping': {
      sendTo(client, { type: 'pong' });
      break;
    }
    default:
      sendTo(client, { type: 'error', id: msg.id, error: `unknown type: ${msg.type}` });
  }
}

// --- Singleton startup (mirror pty-bridge; probe via ping/pong — no node-pty
//     degradation to detect here) ---
function pidAlive(pid) {
  if (!pid || isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probeBridge(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve({ ok: false, reason: 'no-socket' }); return; }
    const conn = net.connect(socketPath);
    let buffer = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { conn.destroy(); } catch {} resolve(r); };
    conn.on('connect', () => {
      conn.write(JSON.stringify({ type: 'ping' }) + '\n');
      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          try { if (JSON.parse(line).type === 'pong') { finish({ ok: true }); return; } } catch {}
        }
      });
    });
    conn.on('error', () => finish({ ok: false, reason: 'connect-error' }));
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
  });
}

async function checkExistingBridge() {
  let recordedPid = null;
  try { if (fs.existsSync(pidPath)) recordedPid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch {}
  const probe = await probeBridge();
  if (probe.ok) return true;
  if (recordedPid && pidAlive(recordedPid) && recordedPid !== process.pid) {
    console.error(`[AI Bridge] Recorded owner ${recordedPid} unreachable (${probe.reason}). SIGTERM.`);
    try { process.kill(recordedPid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
    if (pidAlive(recordedPid)) { try { process.kill(recordedPid, 'SIGKILL'); } catch {} }
  }
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  return false;
}

// Reap store files whose session is gone and whose file is older than retention.
function sweepStore() {
  let names = [];
  try { names = fs.readdirSync(storeDir); } catch { return; }
  const liveFiles = new Set([...sessions.values()].map((s) => path.basename(s.storePath)));
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.ndjson') || liveFiles.has(name)) continue;
    const p = path.join(storeDir, name);
    try { if (now - fs.statSync(p).mtimeMs > RETENTION_MS) fs.unlinkSync(p); } catch {}
  }
}

async function start() {
  if (await checkExistingBridge()) {
    console.error(`[AI Bridge] Another healthy bridge already on ${socketPath}`);
    process.exit(1);
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    let lineBuffer = '';
    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl); lineBuffer = lineBuffer.slice(nl + 1);
        let parsed = null;
        try { parsed = JSON.parse(line); } catch (e) { sendTo(socket, { type: 'error', error: e.message }); continue; }
        try { handleMessage(parsed, socket); }
        catch (e) { sendTo(socket, { type: 'error', error: e.message, id: parsed?.id }); }
      }
    });
    const drop = () => { clients.delete(socket); for (const s of sessions.values()) s.attached.delete(socket); };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  server.listen(socketPath, () => {
    fs.writeFileSync(pidPath, String(process.pid));
    console.error(`[AI Bridge] Listening on ${socketPath} (PID ${process.pid}), store ${storeDir}`);
  });
  server.on('error', (err) => { console.error(`[AI Bridge] Server error: ${err.message}`); process.exit(1); });

  setInterval(sweepStore, SWEEP_EVERY_MS).unref();

  function shutdown(signal) {
    console.error(`[AI Bridge] ${signal} — shutting down, killing ${sessions.size} session(s).`);
    for (const s of sessions.values()) { try { s.child.kill('SIGTERM'); } catch {} try { fs.closeSync(s.storeFd); } catch {} }
    sessions.clear();
    server.close();
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Survive server restarts (same intent as pty-bridge): once the spawner is
  // gone, exit only if NO server reconnects within the grace window — a
  // reconnecting server keeps the surviving `claude` children alive, which is
  // the whole point of being detached.
  //
  // Orphanhood is decided on `--parent-pid`, NOT on `process.ppid`: under Bun
  // (which is what `ai-bridge-client.ts` spawns us with) `process.ppid` is
  // captured once and never refreshed after reparenting to init, so the
  // `process.ppid === 1` test this monitor used to do was never true and the
  // monitor never fired. pty-bridge.mjs got away with the same code only
  // because it runs under node, where ppid does update; bridge.rs calls
  // libc::getppid() per tick. `--parent-pid` needs no runtime to cooperate.
  // Env override exists so the test can exercise the real monitor without
  // sitting through 90s; production never sets it.
  const ORPHAN_GRACE_MS = Number(process.env.TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS) || 90_000;
  let orphanDeadline = null;
  setInterval(() => {
    // No --parent-pid (hand-started daemon): nothing to outlive, the idle
    // timeout below is the only thing that will ever retire us.
    const orphaned = parentPid !== null && !pidAlive(parentPid);
    if (!orphaned) { orphanDeadline = null; return; }
    if (clients.size > 0) {
      if (orphanDeadline !== null) { console.error('[AI Bridge] Server reconnected after parent death — staying alive, sessions preserved.'); orphanDeadline = null; }
      return;
    }
    const now = Date.now();
    if (orphanDeadline === null) {
      orphanDeadline = now + ORPHAN_GRACE_MS;
      console.error(`[AI Bridge] Parent died (was ${parentPid}), no server connected — exit in ${ORPHAN_GRACE_MS / 1000}s unless one reconnects.`);
    } else if (now >= orphanDeadline) {
      console.error('[AI Bridge] No server reconnected within grace — shutting down.');
      shutdown('ORPHAN_ABANDONED');
    }
  }, 5000).unref();

  // Backstop for daemons no parent check can ever retire: a crashed/timed-out
  // `bun test` never runs its afterAll, and its socket path embeds the test
  // runner's PID, so nothing will reconnect to that path — ever. Same for a
  // daemon whose worktree was reaped by worktree-gc (the socket path hashes the
  // cwd). Those were the bulk of the 28 strays found in the wild, and their
  // signature is exactly this: no sessions, no clients, indefinitely.
  //
  // Deliberately much longer than ORPHAN_GRACE_MS: this fires on a LIVE parent
  // too, so it must never race a server that is merely idle between turns.
  let idleSince = Date.now();
  setInterval(() => {
    if (clients.size > 0 || sessions.size > 0) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince < IDLE_EXIT_MS) return;
    console.error(`[AI Bridge] Idle ${IDLE_EXIT_MS / 60_000}min with no clients and no sessions — shutting down.`);
    shutdown('IDLE');
  }, 60_000).unref();
}

start();
