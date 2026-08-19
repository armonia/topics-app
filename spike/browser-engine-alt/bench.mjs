// Bench: engine CDP a confronto per la pane browser di Topics.
// Misura: startup->CDP, RSS albero processi, nav su siti reali, screenshot, screencast.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const HOME = process.env.HOME;
const PW = `${HOME}/Library/Caches/ms-playwright`;
const SCRATCH = process.env.BENCH_BIN_DIR || `${HOME}/tmp/browsers`;

export function treeRssMB(rootPid) {
  const out = execSync("ps -Ao pid=,ppid=,rss=").toString();
  const kids = new Map(); const rss = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], r = +m[3];
    rss.set(pid, r);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let total = 0, count = 0; const stack = [rootPid]; const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue; seen.add(p);
    if (rss.has(p)) { total += rss.get(p); count++; }
    for (const c of kids.get(p) || []) stack.push(c);
  }
  return { mb: +(total / 1024).toFixed(1), procs: count };
}

const ENGINES = {
  "headless-shell": {
    label: "chrome-headless-shell 148",
    exec: `${PW}/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    args: (port, udd) => [`--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, "--no-first-run",
      "--no-default-browser-check", "--use-mock-keychain", "about:blank"],
  },
  lightpanda: {
    label: "Lightpanda (Zig, no render)",
    exec: `${SCRATCH}/lightpanda`,
    args: (port) => ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "error"],
  },
  obscura: {
    label: "Obscura 0.2 (Rust, native render)",
    exec: `${SCRATCH}/obscura`,
    args: (port) => ["serve", "--port", String(port), "--allow-private-network", "--quiet"],
  },
};

async function probeCdp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

export async function launch(key, port) {
  const eng = ENGINES[key];
  if (!existsSync(eng.exec)) throw new Error("exec missing " + eng.exec);
  const udd = mkdtempSync(join(tmpdir(), "bench-"));
  const t0 = now();
  const proc = spawn(eng.exec, eng.args(port, udd), { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; proc.stderr.on("data", (d) => (stderr += d.toString()));
  let exited = null; proc.on("exit", (c, s) => (exited = { c, s }));
  let info = null;
  const deadline = now() + 20000;
  while (now() < deadline) {
    if (exited) throw new Error(`exit early ${JSON.stringify(exited)} :: ${stderr.slice(0, 400)}`);
    info = await probeCdp(port);
    if (info) break;
    await sleep(20);
  }
  const startupMs = +(now() - t0).toFixed(1);
  if (!info) { try { proc.kill("SIGKILL"); } catch {} throw new Error("no CDP: " + stderr.slice(0, 400)); }
  return {
    proc, port, startupMs, info, stderr: () => stderr,
    wsUrl: info.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/browser`,
    dispose() { try { proc.kill("SIGKILL"); } catch {} try { rmSync(udd, { recursive: true, force: true }); } catch {} },
  };
}

export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error " + wsUrl)); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) (c.handlers.get(msg.method) || []).forEach((h) => h(msg.params));
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const t = setTimeout(() => { if (this.pending.delete(id)) rej(new Error("timeout " + method)); }, 30000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(m, h) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(h); }
  close() { try { this.ws.close(); } catch {} }
}

export async function newPage(browser) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

export { sleep, now, ENGINES };
