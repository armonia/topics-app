// PTY Bridge — runs with Node.js to use node-pty (which doesn't work with Bun)
// Communicates with the main Bun server via IPC (stdin/stdout JSON messages)
import * as pty from 'node-pty';

const sessions = new Map();

process.stdin.setEncoding('utf-8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      send({ type: 'error', error: e.message });
    }
  }
});

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    // Parent process closed the pipe — nothing we can do, exit gracefully
    if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') {
      process.exit(0);
    }
    throw e;
  }
}

// Prevent unhandled EPIPE from crashing the process
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'create': {
      const { id, shell, args, cwd, cols, rows, env } = msg;
      const mergedEnv = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      // Remove keys explicitly set to null/undefined (used to unset inherited env vars like CLAUDECODE)
      for (const key of Object.keys(mergedEnv)) {
        if (mergedEnv[key] == null) delete mergedEnv[key];
      }
      // Augment PATH with common user binary locations so tools like 'claude' are found
      const home = process.env.HOME || '';
      const extraPaths = [`${home}/.local/bin`, `${home}/.bun/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin'];
      const currentPath = mergedEnv.PATH || '/usr/local/bin';
      mergedEnv.PATH = [...extraPaths, currentPath].filter(Boolean).join(':');
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || process.env.HOME,
        env: mergedEnv,
      });
      sessions.set(id, p);
      p.onData((data) => {
        send({ type: 'data', id, data });
      });
      p.onExit(({ exitCode }) => {
        sessions.delete(id);
        send({ type: 'exit', id, exitCode });
      });
      send({ type: 'created', id, pid: p.pid });
      break;
    }
    case 'write': {
      const p = sessions.get(msg.id);
      if (p) p.write(msg.data);
      break;
    }
    case 'resize': {
      const p = sessions.get(msg.id);
      if (p) p.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      const p = sessions.get(msg.id);
      if (p) { p.kill(); sessions.delete(msg.id); }
      send({ type: 'killed', id: msg.id });
      break;
    }
  }
}

send({ type: 'ready' });
