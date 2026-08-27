#!/usr/bin/env bun
/**
 * scripts/ai-bridge-replay-bench.ts — la MISURA dell'«ack timeout a raffica».
 *
 * In produzione (topics-server-error.log) gli ack scaduti non sono sparsi: 104
 * in 9 raffiche, la più grossa 51 di fila su topic diversi, con in mezzo
 * «watchdog: no pong» — cioè il ponte non risponde neanche a un ping. È la
 * firma di uno STALLO, non di flake. Questo banco lo riproduce sul daemon vero
 * e — questo è il punto — misura separatamente i DUE sospetti, che da fuori
 * danno lo stesso sintomo:
 *
 *   · il DAEMON è bloccato (readFileSync dell'intero store + base64 in un frame
 *     solo, per ogni attach, tutti nello stesso giro di event loop);
 *   · il SERVER è bloccato (il replay arriva ma piegarlo in righe blocca il
 *     processo che dovrebbe leggere gli ack degli ALTRI).
 *
 * Attribuzione: due sonde indipendenti che fanno la stessa domanda al ponte.
 *   · `daemonPing` — processo SEPARATO, socket suo: se il suo RTT esplode, il
 *     daemon è fermo. Se resta piatto, il daemon sta benissimo.
 *   · `list` in-process + `loopLag` — se solo questi esplodono, il collo di
 *     bottiglia è l'event loop del server, non il ponte.
 *
 * Uso:
 *   bun run scripts/ai-bridge-replay-bench.ts --label prima
 *   bun run scripts/ai-bridge-replay-bench.ts --label dopo --out /tmp/dopo.json
 *
 * Opzioni: --sessions N (6) · --store-mb M (7) · --seed <file.ndjson> (usa uno
 * store REALE come semente invece di sintetizzarlo) · --out <file.json>.
 *
 * NB: gira contro un daemon ISOLATO (socket + store dir in una temp dir), mai
 * contro quello di produzione.
 */
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineFolder } from "../server/lib/ndjson-lines";

// ---------------------------------------------------------------- args ----

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function argNum(flag: string, dflt: number): number {
  const v = argOf(flag);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ------------------------------------------------------- sonda esterna ----
// Modalità `--ping-probe`: stesso file, processo diverso. Stampa una riga JSON
// per campione, così la raffica si legge come una linea temporale e non come
// una media che nasconde il picco.

function runPingProbe(): never {
  const socketPath = argOf("--socket") ?? "";
  const everyMs = argNum("--every", 200);
  const sock = net.connect(socketPath);
  let buf = "";
  let sentAt = 0;
  const sample = (rtt: number): void => {
    process.stdout.write(JSON.stringify({ at: Date.now(), rtt }) + "\n");
  };
  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        if (JSON.parse(line).type === "pong" && sentAt) { sample(Date.now() - sentAt); sentAt = 0; }
      } catch { /* frame non nostro */ }
    }
  });
  sock.on("error", () => process.exit(0));
  sock.on("connect", () => {
    setInterval(() => {
      // Un ping alla volta: se il precedente non è tornato, il ritardo è già
      // il dato che ci interessa e sovrapporne altri lo confonderebbe.
      if (sentAt) { sample(Date.now() - sentAt); return; }
      sentAt = Date.now();
      sock.write(JSON.stringify({ type: "ping" }) + "\n");
    }, everyMs);
  });
  process.on("SIGTERM", () => process.exit(0));
  return undefined as never;
}

// -------------------------------------------------------------- seme ----

const ROW_TEXT =
  "Sto leggendo il file e cerco il punto in cui la riadozione perde l'ancora: è lì che il turno muore, " +
  "perché l'offset da cui riparte non è quello che il daemon ha davvero consegnato. Però la prova sta nei byte. ";

/** Un file NDJSON di `bytes` byte con la forma vera dello stream-json (righe da
 *  ~500 byte, accenti compresi: servono a esercitare i confini UTF-8). */
function synthStore(bytes: number, sessionId: string): Buffer {
  const parts: string[] = [];
  let total = 0;
  let i = 0;
  while (total < bytes) {
    const text = ROW_TEXT.slice(0, 200) + ` #${i}`;
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: `${sessionId}-${i}`,
    }) + "\n";
    parts.push(line);
    total += Buffer.byteLength(line);
    i++;
  }
  parts.push(JSON.stringify({
    type: "result", subtype: "success", is_error: false, duration_ms: 12345,
    num_turns: 1, result: "fatto", session_id: sessionId,
    usage: { input_tokens: 10, output_tokens: 20 },
  }) + "\n");
  return Buffer.from(parts.join(""), "utf8");
}

/** Uno store REALE ripetuto fino alla taglia voluta. La concatenazione di file
 *  NDJSON resta NDJSON, quindi la forma delle righe è quella di produzione. */
function seedFromReal(path: string, bytes: number): Buffer {
  const one = readFileSync(path);
  const copies = Math.max(1, Math.ceil(bytes / Math.max(1, one.byteLength)));
  return Buffer.concat(Array.from({ length: copies }, () => one)).subarray(0, bytes);
}

// ------------------------------------------------------------ statistica ----

interface Stat { n: number; p50: number; p95: number; max: number }
function stat(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

// ------------------------------------------------------------------ run ----

interface AttachOutcome {
  id: string;
  /** ms fino all'ack `attached` — o null se l'ack è SCADUTO (il guasto vero). */
  ackMs: number | null;
  ackError: string | null;
  /** ms fino all'ultimo byte del replay piegato: il costo reale, che c'è anche
   *  quando l'ack è già stato dichiarato perso. */
  replayMs: number | null;
  bytes: number;
  lines: number;
}

async function main(): Promise<void> {
  const sessions = Math.max(1, Math.round(argNum("--sessions", 6)));
  const storeMb = argNum("--store-mb", 7);
  const label = argOf("--label") ?? "run";
  const seedPath = argOf("--seed");
  const outPath = argOf("--out");
  const targetBytes = Math.round(storeMb * 1024 * 1024);

  const tmp = mkdtempSync(join(tmpdir(), "ai-bridge-bench-"));
  const socketPath = join(tmp, "bench.sock");
  const storeDir = join(tmp, "store");
  process.env.TOPICS_AI_BRIDGE_SOCKET = socketPath;
  process.env.TOPICS_DATA_DIR = tmp;

  const seedFile = join(tmp, "seed.ndjson");
  writeFileSync(seedFile, seedPath ? seedFromReal(seedPath, targetBytes) : synthStore(targetBytes, "bench-session"));
  const seedBytes = statSync(seedFile).size;

  console.log(`[bench:${label}] ${sessions} sessioni × ${(seedBytes / 1048576).toFixed(2)} MB (${seedPath ? `semente reale ${seedPath}` : "sintetico"})`);

  const daemon = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "server", "ai-bridge.mjs"), "--socket", socketPath, "--store-dir", storeDir],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 200 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(socketPath)) throw new Error("il daemon non ha aperto il socket");

  // Import DOPO che l'env è stato scritto: il costruttore del client legge lì
  // socket e store dir.
  const { AiBridgeClient } = await import("../server/lib/ai-bridge-client");
  const client = new AiBridgeClient();

  const folded = new Map<string, { bytes: number; lines: number; done: (() => void) | null }>();
  const ids = Array.from({ length: sessions }, (_, i) => `topic:bench${i}`);

  for (const id of ids) {
    const acc = { bytes: 0, lines: 0, done: null as (() => void) | null };
    folded.set(id, acc);
    const fold = createLineFolder(() => { acc.lines++; });
    client.registerHandlers(id, {
      onData: (chunk: Buffer) => {
        fold(chunk);
        acc.bytes += chunk.byteLength;
        if (acc.done && acc.bytes >= seedBytes) { const d = acc.done; acc.done = null; d(); }
      },
    });
  }

  // --- riempimento: N figli che sputano lo store e restano vivi -----------
  console.log(`[bench:${label}] riempio gli store…`);
  await Promise.all(ids.map((id) => client.spawn(id, {
    cliPath: "/bin/sh", args: ["-c", `cat ${seedFile}; sleep 900`], cwd: tmp, env: {},
  })));
  // Il riempimento si constata sui BYTE PIEGATI, non con un `list`: chi spawna
  // è attaccato da offset 0, quindi riceve tutto. E un `list` qui scadrebbe —
  // il primo sintomo che questo banco riproduce è proprio quello: l'ack di una
  // richiesta minuscola resta dietro ai megabyte che la precedono sullo STESSO
  // socket (head-of-line blocking), e a 5s il client dichiara il ponte perso.
  //
  // Un riempimento che NON finisce non è un banco rotto: è il guasto. Il
  // watchdog del client ricicla il socket quando il pong tarda, il riciclo
  // stacca ogni attacco lato daemon, e i byte che mancavano non arrivano più.
  // Va quindi REGISTRATO e riportato, non lanciato come eccezione.
  const fillDeadline = Date.now() + 180_000;
  let fillTruncated = false;
  for (;;) {
    if (ids.every((id) => (folded.get(id)?.bytes ?? 0) >= seedBytes)) break;
    if (Date.now() > fillDeadline) { fillTruncated = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (fillTruncated) console.log(`[bench:${label}] riempimento TRONCATO: lo stream si è interrotto prima della fine`);

  // --- sonde --------------------------------------------------------------
  const probe = Bun.spawn(
    [process.execPath, import.meta.path, "--ping-probe", "--socket", socketPath, "--every", "200"],
    { stdout: "pipe", stderr: "ignore" },
  );

  const loopLags: number[] = [];
  let expected = Date.now() + 20;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    loopLags.push(Math.max(0, now - expected));
    expected = now + 20;
  }, 20);

  const listLatencies: number[] = [];
  const listTimeouts: string[] = [];
  let probing = true;
  const listProbe = (async (): Promise<void> => {
    while (probing) {
      const t0 = Date.now();
      try { await client.list(); listLatencies.push(Date.now() - t0); }
      catch (e) { listTimeouts.push(e instanceof Error ? e.message : String(e)); }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  await new Promise((r) => setTimeout(r, 600)); // linea di base delle sonde

  // --- LA RAFFICA ---------------------------------------------------------
  // `attach0` = la fase 1 di `reattach`, replay INTEGRALE, quella del boot.
  // `resync`  = `resyncStream` dopo un silenzio: riattacca da poco prima della
  //             coda (`--resync-gap`, 4 KB di default: i byte arrivati mentre
  //             eravamo staccati). Pochi byte da consegnare — ed è per questo
  //             che è la misura più netta del costo di LEGGERE comunque tutto
  //             il file. Con gap 0 non si misura niente: il vecchio codice
  //             salta il replay quando `from === endOffset`.
  const mode = (argOf("--mode") ?? "attach0") === "resync" ? "resync" : "attach0";
  const resyncGap = Math.max(0, Math.round(argNum("--resync-gap", 4096)));
  const tips = new Map<string, number>();
  if (mode === "resync") for (const s of await client.list()) tips.set(s.id, Math.max(0, s.endOffset - resyncGap));

  console.log(`[bench:${label}] raffica ${mode}: ${sessions} attach concorrenti`);
  const burstStart = Date.now();
  for (const acc of folded.values()) { acc.bytes = 0; acc.lines = 0; }

  const outcomes = await Promise.all(ids.map(async (id): Promise<AttachOutcome> => {
    const acc = folded.get(id)!;
    let replayMs: number | null = null;
    const replayDone = new Promise<void>((res) => { acc.done = () => { replayMs = Date.now() - burstStart; res(); }; });
    const t0 = Date.now();
    let ackMs: number | null = null;
    let ackError: string | null = null;
    try { await client.attach(id, mode === "resync" ? (tips.get(id) ?? 0) : 0); ackMs = Date.now() - t0; }
    catch (e) { ackError = e instanceof Error ? e.message : String(e); }
    // Anche con l'ack dichiarato perso i byte continuano ad arrivare: il costo
    // vero del replay va misurato lo stesso, altrimenti la riga «timeout» non
    // dice NIENTE su quanto ci è voluto davvero.
    if (mode === "attach0") await Promise.race([replayDone, new Promise((r) => setTimeout(r, 120_000))]);
    return { id, ackMs, ackError, replayMs, bytes: acc.bytes, lines: acc.lines };
  }));
  const burstMs = Date.now() - burstStart;

  // --- chiusura sonde ------------------------------------------------------
  probing = false;
  clearInterval(lagTimer);
  await listProbe;
  probe.kill();
  const probeOut = await new Response(probe.stdout).text();
  const pings = probeOut.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as { at: number; rtt: number }; } catch { return null; } })
    .filter((x): x is { at: number; rtt: number } => x !== null);
  const pingsDuringBurst = pings.filter((p) => p.at >= burstStart && p.at <= burstStart + burstMs + 500);

  const report = {
    label,
    mode,
    sessions,
    storeBytes: seedBytes,
    seed: seedPath ?? "synthetic",
    resyncGap: mode === "resync" ? resyncGap : null,
    replaySlice: Number(process.env.TOPICS_AI_BRIDGE_REPLAY_SLICE) || null,
    /** Lo stream live si è interrotto da solo prima ancora della raffica. */
    fillTruncated,
    burstMs,
    attach: {
      timedOut: outcomes.filter((o) => o.ackError !== null).length,
      ackMs: stat(outcomes.filter((o) => o.ackMs !== null).map((o) => o.ackMs!)),
      replayMs: stat(outcomes.filter((o) => o.replayMs !== null).map((o) => o.replayMs!)),
      bytesDelivered: outcomes.reduce((a, o) => a + o.bytes, 0),
      linesFolded: outcomes.reduce((a, o) => a + o.lines, 0),
      incomplete: outcomes.filter((o) => o.replayMs === null).map((o) => o.id),
    },
    /** DAEMON: sonda fuori processo. Alto ⇒ è il daemon a essere fermo. */
    daemonPingMs: stat(pingsDuringBurst.map((p) => p.rtt)),
    /** SERVER: se questi esplodono e daemonPing no, il collo è l'event loop. */
    serverLoopLagMs: stat(loopLags),
    serverListMs: stat(listLatencies),
    serverListTimeouts: listTimeouts.length,
    outcomes,
  };

  console.log(JSON.stringify(report, null, 2));
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

  client.dispose();
  try { daemon.kill(); } catch { /* già andato */ }
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}

if (process.argv.includes("--ping-probe")) runPingProbe();
else void main();
