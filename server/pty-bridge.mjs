// PTY Bridge Daemon — runs with Node.js to use node-pty (which doesn't work with Bun)
// Communicates with the main Bun server via Unix domain socket (JSON-line protocol)
// Survives server restarts — PTY sessions persist across bun --watch reloads
import * as pty from 'node-pty';
import net from 'node:net';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

// The user's REAL home, from the OS account db (getpwuid) not $HOME. The bridge
// can be (re)spawned by a server whose $HOME was clobbered by a sandbox ancestor
// to a throwaway dir (seen: /tmp/tcs-h-XXXX). Without anchoring, every spawned
// `claude`/`codex` reads an empty ~/.claude.json there and re-onboards. An
// explicit per-create `env.HOME` still wins (test sandboxes rely on that).
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
const MAX_BUFFER_SIZE = 100 * 1024; // 100KB ring buffer per session

/**
 * Who spawned us, as told by the spawner — see the orphan monitor at the bottom.
 * The server passes it (server/routes/terminal.ts); a hand-started daemon doesn't,
 * and then the ppid heuristic below is all we have.
 */
const parentPid = Number(argOf('--parent-pid')) || null;

/**
 * Read HERE, at module load, and NOT inside the monitor.
 *
 * The monitor's fallback heuristic is `process.ppid === 1 && initialPpid !== 1`,
 * and it used to sample `initialPpid` after `start()` had awaited
 * checkExistingBridge() + selfTest() — up to ~3s. A spawner that died inside that
 * window made this read 1, so the guard was false forever and the monitor could
 * never arm: the bridge became immortal. Measured 2026-08-14 on this machine —
 * 20 bridges with zero clients and zero sessions, alive up to 37h, none of which
 * had ever logged "Parent died". Sampling before any await closes the window;
 * `--parent-pid` removes the guesswork altogether.
 */
const initialPpid = process.ppid;

function getDefaultSocketPath() {
  const hash = createHash('md5').update(process.cwd()).digest('hex').slice(0, 8);
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

// How long a killed child gets to honour SIGHUP before its process GROUP is
// SIGKILLed. `kill` used to be one SIGHUP and nothing else: a child that traps
// or ignores HUP simply stayed, and since the entry left the map on the spot it
// was invisible to `list`, to reconcile and to shutdown. Two seconds is well
// past what a healthy TUI needs to save and exit, and far under the 5s ack
// window the server gives a create. Same env knob as the Rust bridge.
const KILL_GRACE_MS = Number(process.env.TOPICS_PTY_BRIDGE_KILL_GRACE_MS) > 0
  ? Number(process.env.TOPICS_PTY_BRIDGE_KILL_GRACE_MS)
  : 2000;

/**
 * SIGKILL a process GROUP, falling back to the single pid.
 *
 * The group, not the pid, is what has to go: node-pty puts the child in its own
 * session, so `sh -c 'trap "" HUP; sleep 300'` leaves `sleep` in the same group
 * holding the slave tty. Killing only the shell leaves that fd open, the master
 * never sees EOF, and `onExit` (the only place that broadcasts `exit`) never
 * runs.
 */
function killGroup(pid) {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); return; } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

// --- State ---
const sessions = new Map();        // id -> { pty, buffer: { chunks, totalSize }, killing, killTimer }
const clients = new Set();         // connected server sockets
const connectedAt = new Map();     // socket -> quando si è attaccato (monitor anti-orfano)

// --- Socket Server ---
function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const client of clients) {
    try { client.write(line); } catch {}
  }
}

function sendTo(client, msg) {
  try { client.write(JSON.stringify(msg) + '\n'); } catch {}
}

function handleMessage(msg, client) {
  switch (msg.type) {
    case 'create': {
      const { id, shell, args, cwd, cols, rows, env } = msg;
      // ONE PTY PER ID, always. Two concurrent creates for the same id (the
      // double POST /revive) used to build two children over one map slot; the
      // first to exit then broadcast an `exit` that tore down the survivor,
      // which after that lived in neither this map nor the server's. Refusing
      // the second is what makes `create` idempotent. `code: 'exists'` matters:
      // the server counts consecutive `error` frames as spawn failures and
      // recycles the whole bridge at three, and this is not a spawn failure.
      if (sessions.has(id)) {
        broadcast({ type: 'error', id, code: 'exists', error: `session ${id} already exists` });
        break;
      }
      // HOME before ...env so a polluted process.env.HOME is overridden by the
      // real home, but an explicit env.HOME (test sandboxes) still wins.
      const mergedEnv = { ...process.env, HOME: realHome(), ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      for (const key of Object.keys(mergedEnv)) {
        if (mergedEnv[key] == null) delete mergedEnv[key];
      }
      // Ensure a UTF-8 locale so accented output doesn't mojibake (à -> √†).
      // Under launchd the env is stripped (LANG unset) -> agent panes that exec
      // `claude`/`codex` directly fall into the C/POSIX single-byte locale.
      // Only fill in if the caller didn't already pass a UTF-8 locale (so an
      // explicit it_IT.UTF-8 is respected).
      const hasUtf8Locale = [mergedEnv.LC_ALL, mergedEnv.LC_CTYPE, mergedEnv.LANG]
        .some((v) => typeof v === 'string' && /utf-?8/i.test(v));
      if (!hasUtf8Locale) {
        mergedEnv.LANG = 'en_US.UTF-8';
        mergedEnv.LC_CTYPE = 'en_US.UTF-8';
      }
      const home = mergedEnv.HOME || realHome();
      const extraPaths = [`${home}/.local/bin`, `${home}/.bun/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
      const currentPath = mergedEnv.PATH || '';
      mergedEnv.PATH = [...extraPaths, currentPath].filter(Boolean).join(':');
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || mergedEnv.HOME || realHome(),
        env: mergedEnv,
      });
      sessions.set(id, { pty: p, buffer: { chunks: [], totalSize: 0 }, killing: false, killTimer: null });
      p.onData((data) => {
        // Append to output buffer
        const session = sessions.get(id);
        if (session) {
          const buf = Buffer.from(data);
          session.buffer.chunks.push(buf);
          session.buffer.totalSize += buf.byteLength;
          while (session.buffer.totalSize > MAX_BUFFER_SIZE && session.buffer.chunks.length > 1) {
            const removed = session.buffer.chunks.shift();
            session.buffer.totalSize -= removed.byteLength;
          }
        }
        broadcast({ type: 'data', id, data });
      });
      p.onExit(({ exitCode }) => {
        // THE ONLY PLACE A SESSION LEAVES THE MAP, and it removes only its OWN
        // pty: an unconditional delete here would let a late exit evict a newer
        // session that had taken the same id.
        const cur = sessions.get(id);
        if (cur && cur.pty === p) {
          if (cur.killTimer) clearTimeout(cur.killTimer);
          sessions.delete(id);
        }
        broadcast({ type: 'exit', id, exitCode });
      });
      broadcast({ type: 'created', id, pid: p.pid });
      break;
    }
    case 'write': {
      const s = sessions.get(msg.id);
      if (s) s.pty.write(msg.data);
      break;
    }
    case 'resize': {
      const s = sessions.get(msg.id);
      if (s) s.pty.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      const s = sessions.get(msg.id);
      // THE ENTRY STAYS. It used to be deleted here, before anything confirmed
      // the child was dead, and the signal was a single SIGHUP: a child that
      // traps or ignores HUP survived a `kill` and was then in no map at all,
      // so `list`, reconcile and shutdown could not see it and nothing ever
      // reaped it. Now `onExit` is the ONE place a session disappears, and this
      // timer guarantees the child gets there.
      if (s && !s.killing) {
        s.killing = true;
        try { s.pty.kill(); } catch {}
        s.killTimer = setTimeout(() => {
          if (sessions.get(msg.id) !== s) return; // it honoured the signal
          console.error(`[PTY Bridge] ${msg.id} ignored SIGHUP for ${KILL_GRACE_MS}ms, escalating to SIGKILL`);
          killGroup(s.pty.pid);
          // SECOND AND LAST STEP, and it is not belt-and-braces: SIGKILL to the
          // group does not guarantee EOF on the master. Anything outside that
          // group still holding the slave fd (a grandchild that called setsid)
          // keeps the master open, `onExit` never fires, and since `onExit` is
          // now the ONLY place a session leaves the map the entry would live
          // forever — every later `create` for that id answering `exists`,
          // which the server deliberately does NOT count toward its spawn
          // breaker. The tab became permanently un-recreatable. The old code
          // always removed the entry; this restores that guarantee, bounded.
          s.killTimer = setTimeout(() => {
            if (sessions.get(msg.id) !== s) return; // `onExit` got there
            console.error(`[PTY Bridge] ${msg.id} never reached onExit after SIGKILL — forcing it out of the map`);
            sessions.delete(msg.id);
            // The `exit` frame is what the server listens to: without it the id
            // stays busy on its side too.
            broadcast({ type: 'exit', id: msg.id, exitCode: -1 });
          }, KILL_GRACE_MS);
          if (typeof s.killTimer.unref === 'function') s.killTimer.unref();
        }, KILL_GRACE_MS);
        // The escalation must not be what keeps the daemon alive.
        if (typeof s.killTimer.unref === 'function') s.killTimer.unref();
      } else if (s) {
        try { s.pty.kill(); } catch {}
      }
      // `killed` still goes out immediately: it acks the request, not the
      // death. The death is the `exit` frame.
      broadcast({ type: 'killed', id: msg.id });
      break;
    }
    case 'list': {
      const list = [];
      for (const [id, s] of sessions) {
        list.push({ id, pid: s.pty.pid });
      }
      sendTo(client, { type: 'list', sessions: list });
      break;
    }
    case 'buffer': {
      const s = sessions.get(msg.id);
      if (s && s.buffer.totalSize > 0) {
        const combined = Buffer.concat(s.buffer.chunks);
        sendTo(client, { type: 'buffer', id: msg.id, data: combined.toString('base64') });
      } else {
        sendTo(client, { type: 'buffer', id: msg.id, data: '' });
      }
      break;
    }
    case 'ping': {
      sendTo(client, { type: 'pong' });
      break;
    }
  }
}

// --- Startup ---
// Single-instance guarantee: a pidfile next to the socket holds the
// owning PID. On startup we check it. If a process with that PID is
// alive AND its socket is healthy AND it can still spawn, we exit.
// Otherwise the pidfile is stale (or the bridge is degraded — see
// posix_spawnp incident) and we take over. The pidfile + healthCheck
// together prevent the "two bridges, one broken" zombie state we saw
// in production.
function pidAlive(pid) {
  if (!pid || isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probeBridge(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve({ ok: false, reason: 'no-socket' }); return; }
    const conn = net.connect(socketPath);
    let buffer = '';
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { conn.destroy(); } catch {}
      resolve(result);
    };
    conn.on('connect', () => {
      // Health-test: ask it to spawn /bin/true. A bridge whose
      // node-pty native addon has lost its session context (see the
      // posix_spawnp failure) responds with {type:'error'}, and that
      // is exactly the case we MUST treat as "this bridge is dead,
      // take over". A simple {type:'ping'} would say {type:'pong'}
      // even from such a degraded bridge.
      const probeId = `__probe-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      conn.write(JSON.stringify({
        type: 'create',
        id: probeId,
        // `/bin/sh -c :` — the most portable trivial-exit spawn. /bin/true was
        // dropped on macOS 26 (only /usr/bin/true remains); /bin/sh is universal.
        shell: '/bin/sh',
        args: ['-c', ':'],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
      }) + '\n');
      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.id !== probeId) continue;
            if (msg.type === 'created') {
              // Probe succeeded — clean up the throwaway PTY.
              conn.write(JSON.stringify({ type: 'kill', id: probeId }) + '\n');
              finish({ ok: true });
              return;
            }
            if (msg.type === 'error') { finish({ ok: false, reason: 'spawn-error', detail: msg.error }); return; }
          } catch {}
        }
      });
    });
    conn.on('error', () => finish({ ok: false, reason: 'connect-error' }));
    setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
  });
}

async function checkExistingBridge() {
  // Read pidfile first — if it points to a healthy process whose
  // bridge can actually spawn, we yield.
  let recordedPid = null;
  try {
    if (fs.existsSync(pidPath)) recordedPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  } catch {}

  const probe = await probeBridge();
  if (probe.ok) return true; // Healthy bridge owns the socket — yield.

  // Bridge unreachable or degraded — clean up.
  if (recordedPid && pidAlive(recordedPid) && recordedPid !== process.pid) {
    // The owning process is alive but its bridge is broken (e.g.
    // posix_spawnp failures from a stale Aqua session). Kill it so
    // we can take over cleanly. SIGTERM, fall through to SIGKILL
    // after 1 s if it ignores us.
    console.error(`[PTY Bridge] Recorded owner ${recordedPid} is degraded (${probe.reason}${probe.detail ? ': ' + probe.detail : ''}). Sending SIGTERM.`);
    try { process.kill(recordedPid, 'SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    if (pidAlive(recordedPid)) {
      try { process.kill(recordedPid, 'SIGKILL'); } catch {}
    }
  }
  // Remove stale socket / pidfile so listen() can rebind.
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(pidPath); } catch {}
  return false;
}

async function selfTest() {
  // Verify node-pty can actually spawn before we advertise the
  // socket. If the native addon is broken (the posix_spawnp failure
  // we saw on a long-running orphan), we exit so the parent server
  // respawns us with a fresh process state.
  try {
    const p = pty.spawn('/bin/true', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: process.env });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('self-test timeout')), 2000);
      p.onExit(() => { clearTimeout(t); resolve(); });
    });
  } catch (e) {
    console.error(`[PTY Bridge] Self-test failed: ${e.message}. Exiting.`);
    process.exit(2);
  }
}

async function start() {
  const existing = await checkExistingBridge();
  if (existing) {
    console.error(`[PTY Bridge] Another healthy bridge is already running on ${socketPath}`);
    process.exit(1);
  }

  await selfTest();

  const server = net.createServer((socket) => {
    clients.add(socket);
    // Quando si è attaccato. Serve al monitor anti-orfano per distinguere un
    // server da una sonda: vedi `REAL_CLIENT_MS`.
    connectedAt.set(socket, Date.now());
    console.error(`[PTY Bridge] Client connected (${clients.size} total)`);

    let lineBuffer = '';
    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        let parsed = null;
        try { parsed = JSON.parse(line); } catch (e) {
          sendTo(socket, { type: 'error', error: e.message });
          continue;
        }
        try {
          handleMessage(parsed, socket);
        } catch (e) {
          // Echo the id back so the server can fail the right pending
          // create instead of cancelling all of them.
          sendTo(socket, { type: 'error', error: e.message, id: parsed?.id });
        }
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      connectedAt.delete(socket);
      console.error(`[PTY Bridge] Client disconnected (${clients.size} remaining)`);
    });

    socket.on('error', () => {
      clients.delete(socket);
      connectedAt.delete(socket);
    });
  });

  server.listen(socketPath, () => {
    // Write PID file
    fs.writeFileSync(pidPath, String(process.pid));
    console.error(`[PTY Bridge] Daemon listening on ${socketPath} (PID ${process.pid})`);
  });

  server.on('error', (err) => {
    console.error(`[PTY Bridge] Server error: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.error(`[PTY Bridge] Received ${signal}, shutting down...`);
    // Same escalation as `kill`: SIGHUP, a grace, then the process GROUP.
    // Exiting straight after one SIGHUP is how a HUP-ignoring child outlived
    // the daemon that owned it, holding a PTY nobody could reach again.
    const pids = [];
    for (const [, s] of sessions) {
      if (s.killTimer) clearTimeout(s.killTimer);
      if (typeof s.pty.pid === 'number') pids.push(s.pty.pid);
      try { s.pty.kill(); } catch {}
    }
    sessions.clear();
    server.close();
    const finish = () => {
      try { fs.unlinkSync(socketPath); } catch {}
      try { fs.unlinkSync(pidPath); } catch {}
      process.exit(0);
    };
    // The socket and the pidfile go away only at the very end, so nobody can
    // take over while children of ours are still being taken down. A signal
    // handler is an ordinary callback, so the loop is still turning here and a
    // timer WILL fire: no busy-wait, and the delay is bounded by the grace.
    //
    // MISURATO il 2026-08-15, contro il sospetto che un SIGKILL dentro la
    // grazia lasci entrambi i file su disco: il SOCKET no. `net.Server.close()`
    // toglie da solo il path del socket unix, quindi a metà grazia quel file
    // non c'è già più (SIGTERM, poi SIGKILL a +500ms su una grazia di 5s: file
    // assente). Resta il PIDFILE, e non c'è modo in-process di difenderlo da un
    // SIGKILL — è esattamente il caso per cui `checkExistingBridge` sonda
    // l'owner invece di fidarsi del numero.
    if (pids.some(pidAlive)) {
      setTimeout(() => {
        for (const pid of pids.filter(pidAlive)) {
          console.error(`[PTY Bridge] shutdown: ${pid} ignored SIGHUP, escalating to SIGKILL`);
          killGroup(pid);
        }
        finish();
      }, KILL_GRACE_MS);
      return;
    }
    finish();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Survive server restarts. When our parent (the server) dies we get
  // reparented to launchd (PPID=1) — but that ALSO happens on a NORMAL server
  // reload/kickstart, after which a fresh server reconnects within seconds.
  // The old code shut down the instant the parent died, killing every live
  // Claude PTY on each restart — the "This terminal session has expired after
  // an update" bug. Instead: once orphaned we only exit if NO server is/becomes
  // connected for a grace window (i.e. the app really quit). A connected client
  // == a server is actively using us, so we stay alive regardless of PPID, and
  // the reconnecting server reattaches to the surviving PTYs via reconcile.
  //
  // Trade-off: while orphaned (PPID=1) a child PTY's `open <url>` may fail to
  // resolve the default browser (lost Aqua session) — a rare, acceptable cost
  // versus losing every running session on every restart.
  //
  // Orphanhood is decided on `--parent-pid` when we have one: it needs no
  // cooperation from the runtime and no lucky timing. The ppid heuristic stays
  // for hand-started daemons, now sampled at module load (see `initialPpid`) so
  // a spawner that dies during startup can no longer disarm it.
  // Env override so the test can exercise the real monitor without sitting
  // through 90s; production never sets it.
  const ORPHAN_GRACE_MS = Number(process.env.TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS) || 90_000;
  // UNA SONDA NON È UN SERVER. `checkExistingBridge()` di ogni ponte che prova a
  // nascere si connette qui, aspetta un pong e chiude: circa un secondo. Il
  // monitor azzerava la scadenza a QUALSIASI connessione, quindi bastava che
  // qualcuno continuasse a provare a spawnare per rendere l'orfano immortale.
  // Misurato il 2026-08-14 in ai-bridge/daemon.log: «Parent died … exit in 90s» e
  // «Server reconnected» alternate all'infinito, pid 41214 ancora vivo dopo 12
  // minuti con il padre morto e zero peer sul socket. Solo un client attaccato da
  // almeno REAL_CLIENT_MS è un server che si è riagganciato — e va misurato sul
  // singolo collegamento, non contando i tick: due sonde diverse a due tick
  // consecutivi non sono un server che è rimasto.
  const REAL_CLIENT_MS = Number(process.env.TOPICS_PTY_BRIDGE_REAL_CLIENT_MS) || 5_000;
  // How often the orphan monitor fires. Production default 5s; tests can shrink
  // it via TOPICS_PTY_BRIDGE_MONITOR_TICK_MS to avoid sitting through full ticks.
  const MONITOR_TICK_MS = Number(process.env.TOPICS_PTY_BRIDGE_MONITOR_TICK_MS) || 5_000;
  let orphanDeadline = null;
  let orphanExtended = false;
  setInterval(() => {
    const orphaned = parentPid !== null
      ? !pidAlive(parentPid)
      : (process.ppid === 1 && initialPpid !== 1);
    if (!orphaned) { orphanDeadline = null; orphanExtended = false; return; }
    const now = Date.now();
    // Un server riagganciato resta attaccato: se qualcuno è qui da REAL_CLIENT_MS
    // non siamo abbandonati, e la scadenza si azzera davvero.
    const settled = [...clients].some((c) => now - (connectedAt.get(c) ?? now) >= REAL_CLIENT_MS);
    if (settled) {
      if (orphanDeadline !== null) {
        console.error('[PTY Bridge] Server reconnected after parent death — staying alive, PTYs preserved.');
        orphanDeadline = null;
        orphanExtended = false;
      }
      return;
    }
    // Orphaned AND no server connected — start/await the grace countdown.
    if (orphanDeadline === null) {
      orphanDeadline = now + ORPHAN_GRACE_MS;
      console.error(`[PTY Bridge] Parent died (was ${parentPid ?? initialPpid}) and no server connected — will exit in ${ORPHAN_GRACE_MS / 1000}s unless one reconnects (PTYs preserved across server restarts).`);
      return;
    }
    if (now < orphanDeadline) return;
    if (clients.size > 0 && !orphanExtended) {
      // Scaduta con qualcuno attaccato da poco: potrebbe essere un server che si
      // sta appena riagganciando. Gli si regala UNA proroga, lunga abbastanza da
      // farlo diventare `settled` — poi si chiude comunque, altrimenti bastano
      // sonde che si sovrappongono per tenere in vita l'orfano per sempre.
      orphanExtended = true;
      orphanDeadline = now + REAL_CLIENT_MS * 2;
      return;
    }
    console.error('[PTY Bridge] No server reconnected within grace window — app likely quit, shutting down.');
    shutdown('ORPHAN_ABANDONED');
  }, MONITOR_TICK_MS).unref();

  // Backstop for the bridges no parent check can ever retire — a spawner whose
  // pid got recycled, a `bun test` that died without its afterAll, a worktree
  // reaped from under us (the socket path hashes the cwd, so nothing will ever
  // reconnect to it). Their signature is always the same: no clients, no
  // sessions, indefinitely. ai-bridge.mjs already had this; the PTY bridge did
  // not, which is why the strays could pile up unnoticed for days.
  //
  // Deliberately much longer than ORPHAN_GRACE_MS: it fires on a LIVE parent
  // too, so it must never race a server that is merely idle between turns. A
  // single live PTY (sessions.size > 0) keeps us up regardless — that is the
  // whole point of surviving detached.
  const IDLE_EXIT_MS = Number(process.env.TOPICS_PTY_BRIDGE_IDLE_EXIT_MS) || 30 * 60_000;
  // Tick at a minute in production; a test that shortens the window must not
  // have to sit through a minute to see the effect of a 2s one.
  const IDLE_TICK_MS = Math.max(500, Math.min(60_000, Math.floor(IDLE_EXIT_MS / 2)));
  let idleSince = Date.now();
  setInterval(() => {
    if (clients.size > 0 || sessions.size > 0) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince < IDLE_EXIT_MS) return;
    console.error(`[PTY Bridge] Idle ${Math.round(IDLE_EXIT_MS / 60_000)}min with no clients and no sessions — shutting down.`);
    shutdown('IDLE');
  }, IDLE_TICK_MS).unref();
}

start();
