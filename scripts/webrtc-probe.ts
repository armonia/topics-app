/**
 * Banco end-to-end del sidecar WebRTC — la prova che i punti 5, 6 e 8 del piano
 * FUNZIONANO, non che compilano.
 *
 * Perché esiste: la suite e2e finge il server browser (browser-v2.fixture.ts
 * risponde al posto suo), quindi non tocca mai il sidecar vero. E il banco degli
 * encoder (`webrtc-bridge --bench`) misura la compressione ma non dimostra che i
 * byte prodotti si DECODIFICHINO: Annex-B e re-inject di SPS/PPS sono esattamente
 * il punto in cui una pane diventa nera in silenzio. Qui si guarda `framesDecoded`
 * di un Chrome vero.
 *
 * Cosa mette in piedi:
 *   1. un server statico con due pagine: `stage` (quella trasmessa: si muove, si
 *      lascia cliccare e scrivere) e `viewer` (il peer: <video> + HUD);
 *   2. Google Chrome headless con la porta CDP aperta — Chrome e non il Chromium
 *      di Playwright perché H.264 lo decodifica di sicuro;
 *   3. il sidecar `webrtc-bridge` sul suo socket;
 *   4. la segnalazione: offer dal viewer → NDJSON al sidecar → answer indietro.
 *      È lo stesso protocollo che parla `server/webrtc-bridge.ts`.
 *
 * Cosa misura e consegna:
 *   - framesDecoded / fps / codec / tipo di coppia ICE dal getStats del viewer;
 *   - la latenza dell'input misurata SUL POSTO: il viewer stampilla l'orologio nel
 *     messaggio, la stage risponde, il round trip si legge in ms;
 *   - un filmato .mp4 del viewer (screencast CDP → ffmpeg), che è la prova
 *     richiesta per i punti di comportamento.
 *
 * Uso:
 *   bun scripts/webrtc-probe.ts [--input ws|datachannel] [--relay] [--secs 12]
 *                               [--out <dir>] [--sw-encode]
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- argomenti

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};

const INPUT_MODE = opt("input", "datachannel") as "ws" | "datachannel";
const RELAY_ONLY = flag("relay");
const SECS = Number(opt("secs", "12"));
const OUT_DIR = opt("out", join(process.cwd(), "artifacts", "webrtc"));
const SW_ENCODE = flag("sw-encode");
// NON 19222: quella è la porta del Chromium vivo di Topics. Puntarci sopra fa
// partire il banco contro il browser DELL'UTENTE — che risponde, quindi sembra
// funzionare, e poi non trova mai la pagina di prova.
const CDP_PORT = Number(opt("cdp-port", "19333"));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BRIDGE = join(
  process.cwd(),
  "desktop-tauri/webrtc-bridge/target/release/webrtc-bridge",
);

// ------------------------------------------------------------ pagine servite

/** La pagina TRASMESSA. Si muove sempre (l'encoder deve avere lavoro vero), e
 *  reagisce a click / scroll / tasti in modo visibile a colpo d'occhio. */
const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0b0d12;color:#e8ecf5;font:16px -apple-system,system-ui,sans-serif;overflow:hidden}
  #bar{position:absolute;top:0;left:0;height:10px;background:linear-gradient(90deg,#3b82f6,#a855f7);width:0}
  #ball{position:absolute;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#7dd3fc,#2563eb);top:200px;left:0}
  #hud{position:absolute;left:32px;top:40px;font-size:44px;font-weight:700;letter-spacing:-1px}
  #sub{position:absolute;left:32px;top:100px;font-size:26px;opacity:.75}
  #box{position:absolute;right:40px;top:40px;width:420px;padding:18px 22px;border-radius:14px;background:#161a24;border:1px solid #2b3242}
  #box b{font-size:30px}
  #typed{font-size:30px;color:#7dd3fc;min-height:38px;word-break:break-all}
  .dot{position:absolute;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:#f43f5e;box-shadow:0 0 0 8px rgba(244,63,94,.28)}
</style></head><body>
  <div id="bar"></div><div id="ball"></div>
  <div id="hud">stage</div><div id="sub">frame <span id="f">0</span></div>
  <div id="box"><div>click <b id="clicks">0</b> &nbsp; scroll <b id="scrolls">0</b></div><div id="typed"></div></div>
<script>
  let f=0, clicks=0, scrolls=0;
  const ball=document.getElementById('ball'), bar=document.getElementById('bar');
  function tick(){
    f++;
    document.getElementById('f').textContent=f;
    const t=f/60;
    ball.style.left=(Math.sin(t)*0.5+0.5)*(innerWidth-120)+'px';
    ball.style.top=(220+Math.sin(t*1.7)*120)+'px';
    bar.style.width=((f%180)/180*100)+'%';
    requestAnimationFrame(tick);
  }
  tick();
  addEventListener('click',e=>{
    clicks++; document.getElementById('clicks').textContent=clicks;
    const d=document.createElement('div'); d.className='dot';
    d.style.left=e.clientX+'px'; d.style.top=e.clientY+'px';
    document.body.appendChild(d); setTimeout(()=>d.remove(),1400);
    // Marcatore per la misura di latenza: chi ha cliccato ha messo l'ora nel
    // messaggio, qui si registra l'arrivo.
    window.__lastClickAt = performance.timeOrigin + performance.now();
  });
  addEventListener('wheel',()=>{scrolls++;document.getElementById('scrolls').textContent=scrolls;},{passive:true});
  addEventListener('keydown',e=>{
    const el=document.getElementById('typed');
    if(e.key.length===1) el.textContent+=e.key;
    else if(e.key==='Backspace') el.textContent=el.textContent.slice(0,-1);
    else if(e.key==='Enter') el.textContent+=' \\u23ce ';
    window.__lastKeyAt = performance.timeOrigin + performance.now();
  });
</script></body></html>`;

/** Il PEER. Nient'altro che il <video> della track e un HUD leggibile anche a
 *  268px di larghezza — la miniatura della board deve dire cosa mostra. */
const VIEWER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05070b;overflow:hidden;font:16px -apple-system,system-ui,sans-serif;color:#e8ecf5}
  video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#05070b}
  #hud{position:absolute;left:0;right:0;bottom:0;padding:10px 18px;display:flex;gap:26px;align-items:baseline;
       background:linear-gradient(0deg,rgba(3,5,9,.94),rgba(3,5,9,0));font-variant-numeric:tabular-nums}
  #hud b{font-size:40px;font-weight:800;letter-spacing:-1.5px}
  #hud span{font-size:19px;opacity:.72}
  #tag{position:absolute;left:18px;top:14px;font-size:22px;font-weight:700;letter-spacing:.5px;
       background:rgba(3,5,9,.72);padding:6px 14px;border-radius:10px}
</style></head><body>
  <video id="v" autoplay playsinline muted></video>
  <div id="tag">viewer · WebRTC</div>
  <div id="hud"><div><b id="frames">0</b> <span>frame decodificati</span></div>
    <div><b id="fps">0</b> <span>fps</span></div>
    <div><b id="lat">–</b> <span>ms input</span></div>
    <div><span id="path"></span></div></div>
<script>
  let pc, dc, lastFrames=0, lastT=0;
  window.__start = async (relay) => {
    pc = new RTCPeerConnection(relay ? { iceServers: window.__iceServers || [], iceTransportPolicy:'relay' }
                                     : { iceServers: window.__iceServers || [] });
    // Il DataChannel va creato PRIMA dell'offer, o non entra nell'SDP e il
    // sidecar non ha nulla a cui rispondere.
    dc = pc.createDataChannel('input', { ordered: true });
    dc.onopen = () => { window.__dcOpen = true; };
    dc.onmessage = (e) => { window.__dcEcho = e.data; };
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => { document.getElementById('v').srcObject = e.streams[0]; };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Non-trickle: si aspetta la raccolta completa, come fa la pane vera.
    await new Promise(r => {
      if (pc.iceGatheringState === 'complete') return r(null);
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r(null));
      setTimeout(() => r(null), 4000);
    });
    return pc.localDescription.sdp;
  };
  window.__answer = async (sdp) => { await pc.setRemoteDescription({ type:'answer', sdp }); return true; };
  window.__send = (obj) => { if (dc && dc.readyState === 'open') { dc.send(JSON.stringify(obj)); return true; } return false; };
  window.__stats = async () => {
    const s = await pc.getStats(); let r = { frames:0, w:0, h:0, codec:'', pair:'', state:pc.iceConnectionState, dc: dc && dc.readyState };
    const codecs = new Map(); s.forEach(x => { if (x.type==='codec') codecs.set(x.id, x.mimeType); });
    s.forEach(x => {
      if (x.type==='inbound-rtp' && x.kind==='video') { r.frames = x.framesDecoded||0; r.w=x.frameWidth||0; r.h=x.frameHeight||0; r.codec = codecs.get(x.codecId)||''; }
      if (x.type==='candidate-pair' && x.state==='succeeded' && x.nominated) r.pairId = x.localCandidateId;
    });
    s.forEach(x => { if (x.type==='local-candidate' && x.id===r.pairId) r.pair = x.candidateType; });
    const now = performance.now();
    if (lastT) document.getElementById('fps').textContent = Math.round((r.frames-lastFrames)*1000/(now-lastT));
    lastFrames = r.frames; lastT = now;
    document.getElementById('frames').textContent = r.frames;
    document.getElementById('path').textContent = (r.codec.split('/')[1]||'') + (r.pair ? ' · ' + r.pair : '');
    return r;
  };
  window.__setLat = (ms) => { document.getElementById('lat').textContent = Math.round(ms); };
</script></body></html>`;

// ------------------------------------------------------------- client CDP

type CdpMsg = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };

class Cdp {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, (m: CdpMsg) => void>();
  private listeners: ((m: CdpMsg) => void)[] = [];

  static async attach(port: number): Promise<Cdp> {
    const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const c = new Cdp();
    c.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("CDP ws error"));
    });
    c.ws.onmessage = (ev) => {
      const m: CdpMsg = JSON.parse(String(ev.data));
      if (m.id && c.pending.has(m.id)) {
        c.pending.get(m.id)!(m);
        c.pending.delete(m.id);
      } else for (const l of c.listeners) l(m);
    };
    return c;
  }

  on(fn: (m: CdpMsg) => void) { this.listeners.push(fn); }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      setTimeout(() => rej(new Error(`${method}: timeout`)), 20000);
    });
  }

  /** `Runtime.evaluate` via CDP — NON l'eval di JavaScript. Il codice valutato è
   *  quello scritto qui sopra, dentro un Chrome usa-e-getta che avviamo noi con un
   *  profilo temporaneo: nessun input esterno arriva mai a questa stringa. */
  async eval(session: string, expr: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ------------------------------------------------------- socket del sidecar

/** Parla NDJSON al sidecar sul suo socket Unix — lo stesso dialetto di
 *  `server/webrtc-bridge.ts`, che qui NON gira: si prova il sidecar, non il broker. */
class BridgeSocket {
  private sock: any;
  private buf = "";
  private waiters: ((m: any) => boolean)[] = [];

  static async connect(path: string, tries = 60): Promise<BridgeSocket> {
    for (let i = 0; i < tries; i++) {
      try {
        const b = new BridgeSocket();
        b.sock = await Bun.connect({
          unix: path,
          socket: {
            data: (_s: any, data: Uint8Array) => b.onData(new TextDecoder().decode(data)),
            error: () => {},
            close: () => {},
          },
        });
        return b;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`sidecar non risponde su ${path}`);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.waiters = this.waiters.filter((w) => !w(msg));
    }
  }

  send(obj: any) { this.sock.write(JSON.stringify(obj) + "\n"); }

  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("sidecar: nessuna risposta")), ms);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t); res(m); return true;
      });
    });
  }
  close() { try { this.sock.end(); } catch {} }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- main

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const framesDir = mkdtempSync(join(tmpdir(), "webrtc-probe-frames-"));
  const profile = mkdtempSync(join(tmpdir(), "webrtc-probe-chrome-"));
  const profile2 = mkdtempSync(join(tmpdir(), "webrtc-probe-viewer-"));
  const sockPath = join(tmpdir(), `topics-webrtc-probe-${process.pid}.sock`);
  let chrome: ChildProcess | null = null;
  let chrome2: ChildProcess | null = null;
  let bridge: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  let cdp2: Cdp | null = null;
  let bs: BridgeSocket | null = null;
  const VIEWER_PORT = CDP_PORT + 1;
  const report: Record<string, unknown> = { input: INPUT_MODE, relay: RELAY_ONLY, swEncode: SW_ENCODE };

  // Server statico: le due pagine devono avere un'origine vera (un file:// non
  // basta, il DataChannel e getStats vogliono un contesto sicuro).
  const http = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      const body = p.startsWith("/viewer") ? VIEWER_HTML : STAGE_HTML;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const base = `http://127.0.0.1:${http.port}`;

  try {
    // La porta dev'essere NOSTRA: se risponde già qualcuno, ci attaccheremmo al
    // suo browser e il banco misurerebbe un'altra cosa.
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      throw new Error(`porta CDP ${CDP_PORT} già occupata — passa --cdp-port <libera>`);
    } catch (e) {
      if (String(e).includes("già occupata")) throw e;
    }

    // 1. Chrome headless con CDP aperta. Chrome, non il Chromium di Playwright:
    //    l'H.264 deve decodificarlo per forza, o la prova non prova niente.
    chrome = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,640",
      "--force-device-scale-factor=1",
      "--autoplay-policy=no-user-gesture-required",
      `${base}/stage`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr?.on("data", () => {});

    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); break; }
      catch { if (i > 60) throw new Error("Chrome non ha aperto la porta CDP"); await sleep(250); }
    }
    cdp = await Cdp.attach(CDP_PORT);

    // La porta apre prima che la pagina esista: si aspetta il TARGET, non il socket.
    let stage: any = null;
    for (let i = 0; i < 60 && !stage; i++) {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      stage = list.find((t: any) => t.type === "page" && String(t.url).includes("/stage"));
      if (!stage) await sleep(250);
    }
    if (!stage) throw new Error("target della stage non trovato");
    const stageSession = (await cdp.send("Target.attachToTarget", { targetId: stage.id, flatten: true })).sessionId;
    await cdp.send("Runtime.enable", {}, stageSession);
    report.stageTarget = stage.id;

    // 2. Il sidecar. Stesso binario che spedisce il server.
    const env = { ...process.env, TOPICS_CDP_PORT: String(CDP_PORT) } as Record<string, string>;
    if (SW_ENCODE) env.TOPICS_WEBRTC_SW_ENCODE = "1";
    const bridgeLog: string[] = [];
    bridge = spawn(BRIDGE, ["--socket", sockPath], { env, stdio: ["ignore", "ignore", "pipe"] });
    bridge.stderr?.on("data", (d) => bridgeLog.push(String(d)));
    bs = await BridgeSocket.connect(sockPath);
    await bs.wait((m) => m.t === "ready", 10000);

    // 3. Il viewer, in un SECONDO Chrome. Non è pignoleria: in headless renderizza
    //    solo la scheda in primo piano, quindi mettere viewer e stage nello stesso
    //    browser spegne la stage — screencast a zero fotogrammi e un sidecar che
    //    sembra rotto mentre invece non gli arriva niente da comprimere. Due
    //    processi separati sono anche il caso vero: due dispositivi.
    chrome2 = spawn(CHROME, [
      "--headless=new",
      `--remote-debugging-port=${VIEWER_PORT}`,
      `--user-data-dir=${profile2}`,
      "--no-first-run", "--no-default-browser-check",
      "--window-size=1280,640",
      "--force-device-scale-factor=1",
      "--autoplay-policy=no-user-gesture-required",
      `${base}/viewer`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    chrome2.stderr?.on("data", () => {});

    let viewerTarget: any = null;
    for (let i = 0; i < 80 && !viewerTarget; i++) {
      try {
        const l = await fetch(`http://127.0.0.1:${VIEWER_PORT}/json/list`).then((r) => r.json());
        viewerTarget = l.find((t: any) => t.type === "page" && String(t.url).includes("/viewer"));
      } catch { /* la porta non è ancora aperta */ }
      if (!viewerTarget) await sleep(250);
    }
    if (!viewerTarget) throw new Error("target del viewer non trovato");
    cdp2 = await Cdp.attach(VIEWER_PORT);
    const viewer = (await cdp2.send("Target.attachToTarget", { targetId: viewerTarget.id, flatten: true })).sessionId;
    await cdp2.send("Runtime.enable", {}, viewer);
    await cdp2.send("Page.enable", {}, viewer);
    // 1280×640 = rapporto 0,50: sotto la soglia oltre la quale la card della board
    // TAGLIA invece di rimpicciolire. La misura la fissa qui, non in post.
    await cdp2.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false }, viewer);
    await sleep(600);

    if (RELAY_ONLY) {
      const ice = JSON.parse(process.env.TOPICS_TURN_CLIENT_ICE || "[]");
      await cdp2.eval(viewer, `window.__iceServers = ${JSON.stringify(ice)}; true`);
      report.iceServers = ice;
    }

    // 4. Segnalazione. Offer del viewer → sidecar → answer.
    const offer = await cdp2.eval(viewer, `window.__start(${RELAY_ONLY ? "true" : "false"})`);
    const peer = "probe-1";
    bs.send({ t: "offer", peer, target: stage.id, sdp: offer });
    const ans = await bs.wait((m) => (m.t === "answer" || m.t === "error") && m.peer === peer, 25000);
    if (ans.t === "error") throw new Error(`sidecar: ${ans.message}`);
    await cdp2.eval(viewer, `window.__answer(${JSON.stringify(ans.sdp)})`);

    // 5. Registrazione + misura, in parallelo.
    let n = 0;
    let lastShot = 0;
    cdp2.on((m) => {
      if (m.method !== "Page.screencastFrame" || m.sessionId !== viewer) return;
      cdp2!.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, viewer).catch(() => {});
      const now = Date.now();
      if (now - lastShot < 66) return; // ~15 fps, basta e avanza per una clip
      lastShot = now;
      writeFileSync(join(framesDir, `${String(n++).padStart(5, "0")}.jpg`), Buffer.from(m.params.data, "base64"));
    });
    await cdp2.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 640, everyNthFrame: 1 }, viewer);

    const deadline = Date.now() + SECS * 1000;
    let stats: any = null;
    let connectedAt = 0;
    const latencies: number[] = [];
    let acted = 0;

    while (Date.now() < deadline) {
      stats = await cdp2.eval(viewer, "window.__stats()");
      if (!connectedAt && stats.frames > 0) {
        connectedAt = Date.now();
        report.firstDecodedAfterMs = SECS * 1000 - (deadline - Date.now());
      }
      // 6. Input: una raffica di click/scroll/tasti, ognuno cronometrato dal
      //    momento in cui parte a quello in cui la STAGE lo registra. È la
      //    latenza che il punto 6 deve abbassare, misurata sul percorso vero.
      if (stats.frames > 0 && acted < 24) {
        const x = 180 + ((acted * 97) % 900);
        const y = 260 + ((acted * 53) % 260);
        const t0 = Date.now();
        if (INPUT_MODE === "datachannel") {
          const ok = await cdp2.eval(viewer, `window.__send(${JSON.stringify({ a: "click", x, y })})`);
          if (!ok) { await sleep(120); continue; }
        } else {
          // Il vecchio percorso, per il confronto: click via CDP sulla stage,
          // che è il minimo assoluto che il giro dal server poteva costare.
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, stageSession);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, stageSession);
        }
        // Attende che la stage abbia visto il click e legge quando l'ha visto.
        for (let i = 0; i < 60; i++) {
          const seen = await cdp.eval(stageSession, "window.__lastClickAt || 0");
          if (seen > t0 - 5) { latencies.push(Date.now() - t0); break; }
          await sleep(5);
        }
        if (acted % 6 === 5) {
          if (INPUT_MODE === "datachannel") await cdp2.eval(viewer, `window.__send(${JSON.stringify({ a: "type", text: "ciao " })})`);
          else await cdp.send("Input.insertText", { text: "ciao " }, stageSession);
        }
        if (acted % 4 === 3) {
          if (INPUT_MODE === "datachannel") await cdp2.eval(viewer, `window.__send(${JSON.stringify({ a: "scroll", x, y, deltaY: 120 })})`);
        }
        acted++;
        if (latencies.length) {
          const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
          await cdp2.eval(viewer, `window.__setLat(${avg})`);
        }
      }
      await sleep(200);
    }

    await cdp2.send("Page.stopScreencast", {}, viewer).catch(() => {});
    const stageState = await cdp.eval(stageSession, `({clicks:+document.getElementById('clicks').textContent,
      scrolls:+document.getElementById('scrolls').textContent, typed:document.getElementById('typed').textContent})`);

    report.stats = stats;
    report.stage = stageState;
    report.inputSamples = latencies.length;
    report.inputLatencyMs = latencies.length
      ? { avg: +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1), min: Math.min(...latencies), max: Math.max(...latencies) }
      : null;
    report.encoder = bridgeLog.join("").split("\n").find((l) => l.includes("[enc] encoder")) ?? "";
    report.bridgeErrors = bridgeLog.join("").split("\n").filter((l) => /error|panic|OSStatus/i.test(l)).slice(0, 5);

    // 7. Il filmato.
    const shots = readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length;
    const video = join(OUT_DIR, `webrtc-${INPUT_MODE}${RELAY_ONLY ? "-relay" : ""}${SW_ENCODE ? "-sw" : ""}.mp4`);
    if (shots > 4) {
      const ff = spawn("ffmpeg", ["-y", "-framerate", "15", "-i", join(framesDir, "%05d.jpg"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video], { stdio: "ignore" });
      await new Promise((r) => ff.on("exit", r));
      report.video = video;
      report.videoFrames = shots;
    }

    console.log(JSON.stringify(report, null, 2));
    const ok = stats && stats.frames > 0;
    if (!ok) {
      // Il log del sidecar è l'unico posto dove si vede PERCHÉ: senza, un fallimento
      // qui è indistinguibile da "non ha risposto".
      console.error("\n--- stderr del sidecar ---\n" + bridgeLog.join("").slice(-4000));
      console.error("FALLITO: nessun fotogramma decodificato dal viewer.");
      process.exitCode = 1;
    }
  } finally {
    bs?.close();
    cdp?.close();
    cdp2?.close();
    try { bridge?.kill("SIGKILL"); } catch {}
    try { chrome?.kill("SIGKILL"); } catch {}
    try { chrome2?.kill("SIGKILL"); } catch {}
    http.stop(true);
    rmSync(framesDir, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
    rmSync(profile2, { recursive: true, force: true });
    rmSync(sockPath, { force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
