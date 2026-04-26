// PTY Bridge Daemon — runs with Node.js to use node-pty (which doesn't work with Bun)
// Communicates with the main Bun server via Unix domain socket (JSON-line protocol)
// Survives server restarts — PTY sessions persist across bun --watch reloads
import * as pty from 'node-pty';
import net from 'node:net';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

// --- Configuration ---
const socketPath = process.argv.find((a, i) => process.argv[i - 1] === '--socket') || getDefaultSocketPath();
const pidPath = socketPath.replace(/\.sock$/, '.pid');
const MAX_BUFFER_SIZE = 100 * 1024; // 100KB ring buffer per session

function getDefaultSocketPath() {
  const hash = createHash('md5').update(process.cwd()).digest('hex').slice(0, 8);
  return `/tmp/topics-pty-bridge-${hash}.sock`;
}

// --- State ---
const sessions = new Map();        // id -> { pty, buffer: { chunks: Buffer[], totalSize: number } }
const clients = new Set();         // connected server sockets

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
      const mergedEnv = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      for (const key of Object.keys(mergedEnv)) {
        if (mergedEnv[key] == null) delete mergedEnv[key];
      }
      const home = process.env.HOME || '';
      const extraPaths = [`${home}/.local/bin`, `${home}/.bun/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
      const currentPath = mergedEnv.PATH || '';
      mergedEnv.PATH = [...extraPaths, currentPath].filter(Boolean).join(':');
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || process.env.HOME,
        env: mergedEnv,
      });
      sessions.set(id, { pty: p, buffer: { chunks: [], totalSize: 0 } });
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
        sessions.delete(id);
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
      if (s) { s.pty.kill(); sessions.delete(msg.id); }
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
function checkExistingBridge() {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve(false); return; }
    const testConn = net.connect(socketPath, () => {
      testConn.end();
      resolve(true); // Another bridge is already running
    });
    testConn.on('error', () => {
      // Stale socket — remove it
      try { fs.unlinkSync(socketPath); } catch {}
      resolve(false);
    });
  });
}

async function start() {
  const existing = await checkExistingBridge();
  if (existing) {
    console.error(`[PTY Bridge] Another bridge is already running on ${socketPath}`);
    process.exit(1);
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    console.error(`[PTY Bridge] Client connected (${clients.size} total)`);

    let lineBuffer = '';
    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        try {
          handleMessage(JSON.parse(line), socket);
        } catch (e) {
          sendTo(socket, { type: 'error', error: e.message });
        }
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      console.error(`[PTY Bridge] Client disconnected (${clients.size} remaining)`);
    });

    socket.on('error', () => {
      clients.delete(socket);
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
    for (const [id, s] of sessions) {
      try { s.pty.kill(); } catch {}
    }
    sessions.clear();
    server.close();
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Exit when parent dies. An orphaned bridge (reparented to launchd, PPID=1)
  // loses its Aqua/GUI session context, which breaks `open <url>` for child
  // PTYs (Launch Services can't resolve the default browser). On parent
  // death, exit so the next request spawns a fresh bridge in the proper
  // session context.
  const initialPpid = process.ppid;
  setInterval(() => {
    if (process.ppid === 1 && initialPpid !== 1) {
      console.error(`[PTY Bridge] Parent died (was ${initialPpid}, now reparented to launchd). Exiting to avoid losing GUI session.`);
      shutdown('PARENT_DIED');
    }
  }, 5000).unref();
}

start();
