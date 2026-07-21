// Live end-to-end check of the BROKER path (server.mjs), not just rrweb feasibility.
// harness.mjs already proved DOM capture→reconstruct fidelity; this proves the live
// server: session fan-out to N viewers, the co-op input gate (viewer dropped /
// controller relayed → CDP), multi-session isolation, and presence.
//
// Signal is unambiguous: clicking #go appends "manuale:" to the feed, while the
// fixture's own auto-feed only ever appends "evento auto". So any "manuale:" in the
// DOM stream is a click that actually reached the source page.
//
// Run:  bun spike/rrweb-cobrowse/live-check.mjs   (exit 0 = all green)
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
// Dedicated var, NOT process.env.PORT — under Topics that is 3333 (the live server).
const PORT = Number(process.env.LIVE_CHECK_PORT || 8891);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// A WS viewer that records the event stream so we can assert on it.
function connect(session, role) {
  const ws = new WebSocket(`${BASE}/ws?session=${session}&role=${role}`);
  const rec = {
    ws, session, role,
    metas: 0, fulls: 0, incrementals: 0,
    manuale: 0,               // count of frames whose DOM stream carried "manuale:"
    lastPresence: null,
    ready: new Promise((res) => (ws.onopen = res)),
  };
  ws.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'event') {
      const t = msg.event?.type;
      if (t === 4) rec.metas++;
      else if (t === 2) rec.fulls++;
      else rec.incrementals++;
      if (m.data.includes('manuale:')) rec.manuale++;
    } else if (msg.kind === 'presence') {
      rec.lastPresence = msg.viewers;
    }
  };
  return rec;
}
const sendClick = (rec, x, y) =>
  rec.ws.send(JSON.stringify({ kind: 'input', type: 'click', x, y, w: 1280, h: 800 }));

let exitCode = 1;
let browser;
let server;
try {
  // ── boot the broker ────────────────────────────────────────────────────────
  server = spawn('bun', [join(DIR, 'server.mjs')], {
    cwd: DIR, // no .env here → the passed PORT wins over the project's .env (PORT=3333)
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server boot timeout')), 20000);
    server.on('exit', (c) => rej(new Error(`server exited early (code ${c})`)));
    server.stdout.on('data', (b) => {
      if (b.toString().includes('broker on')) { clearTimeout(to); res(); }
    });
  });
  await sleep(400);

  // Measure #go center on an identical page/viewport → coords match the source 1:1.
  browser = await chromium.launch({ headless: true });
  const probe = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ppage = await probe.newPage();
  await ppage.goto(`${BASE}/fixture.html`, { waitUntil: 'load' });
  const box = await ppage.locator('#go').boundingBox();
  const gx = Math.round(box.x + box.width / 2);
  const gy = Math.round(box.y + box.height / 2);
  await probe.close();
  check('measured #go button center', box && gx > 0 && gy > 0, `(${gx},${gy})`);

  // 1) controller connects → creates the "live" source session.
  const ctrl = connect('live', 'controller');
  await ctrl.ready;
  await sleep(1600); // page load + rrweb full snapshot captured + baseline incrementals

  // 2) a second viewer joins the SAME session as a LATE JOINER → must bootstrap.
  const peer = connect('live', 'viewer');
  await peer.ready;
  await sleep(500);
  check('late joiner bootstraps (meta+full snapshot)', peer.metas >= 1 && peer.fulls >= 1,
    `meta=${peer.metas} full=${peer.fulls} inc=${peer.incrementals}`);
  check('presence broadcast reaches viewers', peer.lastPresence >= 2,
    `viewers=${peer.lastPresence}`);

  // 3) an isolated viewer on a DIFFERENT session.
  const iso = connect('other', 'viewer');
  await iso.ready;
  await sleep(500);

  // 4) CO-OP GATE: a viewer's input must be DROPPED (no "manuale:" appears).
  const before = { ctrl: ctrl.manuale, peer: peer.manuale, iso: iso.manuale };
  sendClick(peer, gx, gy);
  await sleep(800);
  const noLeak = ctrl.manuale === before.ctrl && peer.manuale === before.peer;
  check('co-op gate: viewer input is dropped', noLeak,
    `Δctrl=${ctrl.manuale - before.ctrl} Δpeer=${peer.manuale - before.peer}`);

  // 5) RELAY + FAN-OUT: a controller's click reaches the source (→ CDP) and the
  //    resulting DOM mutation fans out to BOTH peers on the session.
  const mid = { ctrl: ctrl.manuale, peer: peer.manuale, iso: iso.manuale };
  sendClick(ctrl, gx, gy);
  await sleep(900);
  check('controller input relayed → source page mutated', ctrl.manuale > mid.ctrl,
    `Δctrl=${ctrl.manuale - mid.ctrl}`);
  check('mutation fans out to the other viewer', peer.manuale > mid.peer,
    `Δpeer=${peer.manuale - mid.peer}`);

  // 6) MULTI-SESSION ISOLATION: none of session "live"'s traffic reached "other".
  check('multi-session isolation holds', iso.manuale === 0,
    `other-session manuale=${iso.manuale}, inc=${iso.incrementals}`);

  ctrl.ws.close(); peer.ws.close(); iso.ws.close();

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} live checks green`);
  exitCode = passed === checks.length ? 0 : 1;
} catch (e) {
  console.error('live-check error:', e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGKILL');
}
process.exit(exitCode);
