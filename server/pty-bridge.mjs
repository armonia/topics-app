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
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'create': {
      const { id, shell, args, cwd, cols, rows, env } = msg;
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: cols || 120,
        rows: rows || 30,
        cwd: cwd || process.env.HOME,
        env: { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
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
