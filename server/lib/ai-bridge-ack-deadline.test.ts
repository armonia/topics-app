import { describe, test, expect, afterAll } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * L'ack scaduto NON è più un verdetto.
 *
 * Il guasto di produzione: 104 «ack timeout» in 9 raffiche, la più grossa 51
 * di fila su topic diversi, ognuno un turno morto con «Riadozione del turno
 * non riuscita» in chat. Misurato col banco (`scripts/ai-bridge-replay-bench.ts`)
 * il ponte non era rotto: sei riattacchi su store da 7 MB mettono in coda
 * ~44 MB su UN socket e le risposte escono a scaletta fino a 5 secondi — con
 * il daemon che intanto risponde a un ping in 4 ms da un altro processo.
 * Quello che scadeva era l'attesa di chi stava dietro ai megabyte degli altri.
 *
 * Qui il daemon è FINTO, così i due casi si possono separare a comando:
 *  · parla ma tarda  → l'attesa NON deve morire;
 *  · è muto davvero  → deve morire, ma solo dopo aver RIPROVATO.
 */

const SOCK = join(tmpdir(), `ai-bridge-stall-${process.pid}.sock`);
const dataDir = mkdtempSync(join(tmpdir(), "ai-bridge-stall-data-"));
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
process.env.TOPICS_DATA_DIR = dataDir;
// Shrink timers so the test does not sit through the real production waits
// (5s ACK + 1s tick = 15s for 3 mute retries; 8s slow-bridge wait).
// Production never sets these.
const TEST_ACK_MS = 500;
const TEST_TICK_MS = 50;
process.env.TOPICS_AI_BRIDGE_ACK_MS = String(TEST_ACK_MS);
process.env.TOPICS_AI_BRIDGE_STALL_TICK_MS = String(TEST_TICK_MS);

const { AiBridgeClient, BridgeAckStalled, isRetryableBridgeError, shouldRecycleSocket } =
  await import("./ai-bridge-client");

let server: net.Server | null = null;
let client: InstanceType<typeof AiBridgeClient> | null = null;

/** Ferma la scena precedente e ne apre una nuova: daemon finto sul socket +
 *  un client fresco (il costruttore rilegge l'env, quindi punta lì). */
async function scena(onFrame: (frame: { type?: string }, sock: net.Socket) => void): Promise<InstanceType<typeof AiBridgeClient>> {
  try { client?.dispose(); } catch { /* già chiuso */ }
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  try { rmSync(SOCK, { force: true }); } catch { /* già sparito */ }

  const s = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { onFrame(JSON.parse(line), sock); } catch { /* frame illeggibile */ }
      }
    });
    sock.on("error", () => { /* il client butta il socket apposta */ });
  });
  await new Promise<void>((res) => s.listen(SOCK, () => res()));
  server = s;
  client = new AiBridgeClient();
  return client;
}

afterAll(async () => {
  try { client?.dispose(); } catch { /* già chiuso */ }
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  try { rmSync(SOCK, { force: true }); } catch { /* già sparito */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("deadline sul silenzio, non sul totale", () => {
  test("un ponte LENTO ma che parla non fa scadere l'ack (ACK_TIMEOUT_MS = 5s)", async () => {
    // Il `list` viene acked solo dopo TEST_ACK_MS * 2 — ben oltre la deadline.
    // Nel frattempo il daemon versa `data` di ALTRE sessioni: è esattamente la
    // coda che in produzione fa da tappo, ed è la prova che è vivo.
    // (In prod: 8s delay per dimostrare che l'ack da 5s non scattava; qui
    // usiamo TEST_ACK_MS via env per non sedersi 8s a ogni run.)
    const replyAfterMs = TEST_ACK_MS * 2;
    const noiseEveryMs = Math.min(200, TEST_ACK_MS / 2);
    const c = await scena((frame, sock) => {
      if (frame.type !== "list") return;
      const rumore = setInterval(() => {
        sock.write(JSON.stringify({ type: "data", id: "topic:altro", offset: 0, chunk: "eA==" }) + "\n");
      }, noiseEveryMs);
      setTimeout(() => {
        clearInterval(rumore);
        sock.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      }, replyAfterMs);
    });

    const t0 = Date.now();
    const sessions = await c.list();
    const dt = Date.now() - t0;

    expect(sessions).toEqual([]);
    expect(dt).toBeGreaterThan(TEST_ACK_MS);   // la vecchia deadline sarebbe già scattata
    expect(dt).toBeLessThan(replyAfterMs + 2_000);
  }, 10_000);

  test("un ponte MUTO rigetta — ma solo dopo aver rimandato il frame", async () => {
    let listRicevuti = 0;
    const c = await scena((frame) => { if (frame.type === "list") listRicevuti++; });

    let errore: unknown = null;
    try { await c.list(); } catch (e) { errore = e; }

    expect(errore).toBeInstanceOf(BridgeAckStalled);
    expect((errore as InstanceType<typeof BridgeAckStalled>).message).toContain("muto da");
    expect(isRetryableBridgeError(errore)).toBe(true);
    // REQUEST_ATTEMPTS = 3: prima si moriva al primo colpo. `list` è
    // idempotente, quindi rimandarlo è sicuro per costruzione.
    expect(listRicevuti).toBe(3);
  }, 20_000);
});

describe("cosa vale la pena rimandare", () => {
  test("il tetto assoluto scaduto MENTRE i byte scorrevano NON si ritenta", () => {
    // Rimandare un `attach` lì vuol dire rifare da capo lo stesso replay da
    // megabyte che era già in arrivo: benzina sulla coda che ha causato
    // l'attesa. Solo il silenzio VERO merita un secondo tentativo.
    expect(isRetryableBridgeError(new BridgeAckStalled("tetto 90s", false))).toBe(false);
    expect(isRetryableBridgeError(new BridgeAckStalled("muto da 15s", true))).toBe(true);
  });

  test("un errore qualunque non è ritentabile (un `error` del daemon si ripeterebbe uguale)", () => {
    expect(isRetryableBridgeError(new Error("store open failed"))).toBe(false);
  });
});

describe("watchdog: il pong tardivo non è una morte", () => {
  const T = 45_000;
  test("né pong né byte da oltre la soglia ⇒ il socket si ricicla", () => {
    expect(shouldRecycleSocket(100_000, 100_000 - T - 1, 100_000 - T - 1, T)).toBe(true);
  });
  test("pong vecchio ma BYTE recenti ⇒ il ponte è vivo, non si tocca niente", () => {
    // Il caso di produzione: il pong è in fondo alla coda dietro i replay.
    // Riciclare qui staccava ogni attacco e faceva ripartire tutti i replay —
    // il moltiplicatore della raffica.
    expect(shouldRecycleSocket(100_000, 100_000 - T - 1, 99_000, T)).toBe(false);
  });
  test("pong recente ⇒ niente da fare", () => {
    expect(shouldRecycleSocket(100_000, 99_000, 100_000 - T - 1, T)).toBe(false);
  });
});
