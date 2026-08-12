// Minimal CDP client + Chromium launch/RSS helpers for the browser-engine spike.
// Pure Node (>=21, uses global WebSocket + fetch). No external deps.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME;
const PW = `${HOME}/Library/Caches/ms-playwright`;

// Resolved browser executables (playwright build 1223 == Chrome for Testing 148).
export const ENGINES = {
  "chromium-headless": {
    label: "Chromium (full) --headless=new",
    exec: `${PW}/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    headless: "new",
  },
  "headless-shell": {
    label: "chrome-headless-shell",
    exec: `${PW}/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    headless: "shell",
  },
  "chromium-headful": {
    label: "Chromium (full) headful",
    exec: `${PW}/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    headless: null,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, float

// Sum RSS (KB) over the whole process tree rooted at pid. Returns MB.
export function treeRssMB(rootPid) {
  const out = execSync("ps -Ao pid=,ppid=,rss=").toString();
  const kids = new Map();
  const rss = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], r = +m[3];
    rss.set(pid, r);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let total = 0, count = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (rss.has(p)) { total += rss.get(p); count++; }
    for (const c of kids.get(p) || []) stack.push(c);
  }
  return { mb: +(total / 1024).toFixed(1), procs: count };
}

// Launch a browser with CDP on a fixed port. Returns { proc, port, wsUrl, userDataDir, dispose }.
export async function launch(engineKey, port) {
  const eng = ENGINES[engineKey];
  if (!eng) throw new Error("unknown engine " + engineKey);
  if (!existsSync(eng.exec)) throw new Error("exec not found: " + eng.exec);
  const userDataDir = mkdtempSync(join(tmpdir(), "spike-cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Portachiavi FINTO. Senza, Chromium interroga il portachiavi VERO di macOS
    // e a ogni avvio compare il dialogo di autenticazione del sistema: il 12/08
    // due alberi di questo banco sono sopravvissuti al loro giro (22 ore e 15
    // ore, profilo fisso /tmp/cft-profile, porta 9333) e hanno riempito lo
    // schermo di richieste. Playwright il flag lo passa di suo — questo lancio
    // e' a mano, quindi tocca a noi. Vedi il gemello in
    // server/browser-chromium-sidecar.ts.
    "--use-mock-keychain",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ];
  if (eng.headless === "new") args.unshift("--headless=new");
  // headless-shell is headless by default; headful adds no flag.

  const t0 = now();
  const proc = spawn(eng.exec, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  let earlyExit = null;
  proc.on("exit", (code, sig) => { earlyExit = { code, sig }; });

  // Poll CDP /json/version until ready.
  let wsUrl = null;
  const deadline = now() + 15000;
  while (now() < deadline) {
    if (earlyExit) throw new Error(`process exited early (code=${earlyExit.code} sig=${earlyExit.sig})\n${stderr.slice(0, 800)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
    await sleep(20);
  }
  const startupMs = +(now() - t0).toFixed(1);
  if (!wsUrl) { try { proc.kill("SIGKILL"); } catch {} throw new Error("CDP never became ready\n" + stderr.slice(0, 800)); }

  const dispose = () => {
    try { proc.kill("SIGKILL"); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { proc, port, wsUrl, userDataDir, startupMs, dispose, stderr: () => stderr };
}

// Thin CDP session over a websocket (browser-level or page target).
export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error")); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        (c.handlers.get(msg.method) || []).forEach((h) => h(msg.params));
      }
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = id ? sessionId : undefined; // sessionId routing
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(sessionId ? { ...payload, sessionId } : payload));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  off(method) { this.handlers.delete(method); }
  close() { try { this.ws.close(); } catch {} }
}

// Open a fresh page target and return a flat-mode session id bound to it.
export async function newPageSession(browser) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

export { sleep };
