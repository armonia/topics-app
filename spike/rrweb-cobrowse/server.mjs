// Live co-browse demo broker — SESSION-SCOPED and ROLE-AWARE by design, so the
// exact same layer serves BOTH:
//   • multi-session : sessions Map keyed by sessionId → independent source pages,
//                     each fanned out to its own viewers.
//   • co-op         : many peers per session, tagged with a role (presenter /
//                     controller / viewer); input is relayed only from controllers.
//
// The source of truth is ONE headless page per session (real browser, runs JS,
// holds login). rrweb is injected → DOM events (tiny JSON) fan out to N viewers,
// which reconstruct the DOM NATIVELY (no video). Input rides back over the same WS
// → CDP. Canvas/video islands are out of scope here (→ Rust webrtc-bridge, reused).
//
// This is the JS reference of the broker; bridge/ is the Rust skeleton that speaks
// the same NDJSON contract for the production sidecar.
//
// Run:  bun spike/rrweb-cobrowse/server.mjs   then open  http://localhost:8879/
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8879);
const RECORD_BUNDLE = readFileSync(join(DIR, 'vendor/rrweb.min.js'), 'utf8') + '\n;window.rrweb=rrweb;';
const RECORD_START = readFileSync(join(DIR, 'record-start.js'), 'utf8');

const browser = await chromium.launch({ headless: true });

// sessionId → { page, context, viewers:Set, roles:Map, meta, full, inc[] }
const sessions = new Map();

async function getSession(id, url) {
  let s = sessions.get(id);
  if (s) return s;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  s = {
    id, page, context,
    viewers: new Set(),        // Set<ServerWebSocket>
    roles: new Map(),          // ws → 'presenter'|'controller'|'viewer'
    meta: null, full: null,    // last Meta (type 4) + FullSnapshot (type 2) for late-join bootstrap
    inc: [],                   // incrementals since last full snapshot (capped)
  };
  sessions.set(id, s);

  await page.exposeFunction('__rrwebEmit', (json) => {
    let m; try { m = JSON.parse(json); } catch { return; }
    if (m.kind !== 'event') return;
    const e = m.event;
    if (e.type === 4) { s.meta = e; }               // Meta
    else if (e.type === 2) { s.full = e; s.inc = []; } // FullSnapshot → reset bootstrap prefix
    else { s.inc.push(e); if (s.inc.length > 4000) s.inc.shift(); }
    const frame = JSON.stringify({ kind: 'event', event: e });
    for (const v of s.viewers) { try { v.send(frame); } catch {} }
  });
  await page.addInitScript(RECORD_BUNDLE);
  await page.addInitScript(RECORD_START);
  await page.goto(url || `http://localhost:${PORT}/fixture.html`, { waitUntil: 'load' }).catch(() => {});
  return s;
}

function bootstrap(ws, s) {
  if (s.meta) ws.send(JSON.stringify({ kind: 'event', event: s.meta }));
  if (s.full) ws.send(JSON.stringify({ kind: 'event', event: s.full }));
  for (const e of s.inc) ws.send(JSON.stringify({ kind: 'event', event: e }));
}

function presence(s) {
  const frame = JSON.stringify({ kind: 'presence', viewers: s.viewers.size });
  for (const v of s.viewers) { try { v.send(frame); } catch {} }
}

async function relayInput(s, msg) {
  const page = s.page;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const sx = msg.w ? (msg.x * vp.width / msg.w) : msg.x;
  const sy = msg.h ? (msg.y * vp.height / msg.h) : msg.y;
  try {
    if (msg.type === 'click') { await page.mouse.click(sx, sy); }
    else if (msg.type === 'scroll') { await page.mouse.move(sx, sy); await page.mouse.wheel(0, msg.deltaY || 0); }
    else if (msg.type === 'key' && msg.key) { await page.keyboard.press(mapKey(msg.key)); }
  } catch {}
}
function mapKey(k) { return k.length === 1 ? k : k; }

const CT = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serveFile(name) {
  try {
    const p = join(DIR, name.replace(/^\/+/, ''));
    if (!p.startsWith(DIR)) return new Response('nope', { status: 403 });
    const ext = name.slice(name.lastIndexOf('.'));
    return new Response(readFileSync(p), { headers: { 'content-type': CT[ext] || 'application/octet-stream' } });
  } catch { return new Response('not found', { status: 404 }); }
}

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname === '/ws') {
      const session = u.searchParams.get('session') || 'default';
      const role = u.searchParams.get('role') || 'viewer';
      const url = u.searchParams.get('url') || undefined;
      if (server.upgrade(req, { data: { session, role, url } })) return;
      return new Response('ws upgrade failed', { status: 400 });
    }
    if (u.pathname === '/') {
      return new Response(null, { status: 302, headers: { location: '/client.html?live=1&session=demo&role=viewer' } });
    }
    return serveFile(u.pathname);
  },
  websocket: {
    async open(ws) {
      const { session, role, url } = ws.data;
      const s = await getSession(session, url);
      s.viewers.add(ws); s.roles.set(ws, role);
      bootstrap(ws, s);
      presence(s);
    },
    async message(ws, raw) {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const s = sessions.get(ws.data.session); if (!s) return;
      if (msg.kind === 'input') {
        const role = s.roles.get(ws);
        if (role === 'viewer') return; // co-op gate: only presenter/controller drives
        await relayInput(s, msg);
      }
    },
    close(ws) {
      const s = sessions.get(ws.data.session); if (!s) return;
      s.viewers.delete(ws); s.roles.delete(ws);
      presence(s);
    },
  },
});

console.log(`[rrweb-cobrowse] broker on http://localhost:${PORT}/  (viewer)`);
console.log(`[rrweb-cobrowse] controller: http://localhost:${PORT}/client.html?live=1&session=demo&role=controller`);
console.log(`[rrweb-cobrowse] point at any site: add &url=https://example.com on the FIRST connect`);
