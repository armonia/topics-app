/**
 * `GET /__daemon/idle`: «c'e' un turno in volo?», e basta.
 *
 * Il riavvio condizionato dell'hub deve poter chiedere prima di impegnarsi.
 * `POST /__daemon/restart-when-idle` risponde alla stessa domanda ma apre
 * un'attesa e poi manda il SIGTERM: per leggere lo stato non c'era un cammino
 * che non lo cambiasse. Questo e' quel cammino, ed e' provato sul server VERO
 * (la rotta vive inline in `server.ts`, che si avvia all'import): un test su una
 * replica del corpo del handler non vedrebbe un `waitForDispatcherQuiescent`
 * aggiunto per errore a monte.
 *
 * Tre cose da tenere ferme:
 *   · la risposta ha la forma promessa (`idle`, `inFlight`, `holding`,
 *     `unrecoverable`, `alreadyWaiting`) e con il server a riposo dice «idle»;
 *   · stessa porta degli altri `/__daemon/*`: senza bearer, 401;
 *   · e' DAVVERO di sola lettura: dopo piu' GET nessuna attesa e' partita
 *     (`alreadyWaiting` resta false) e il processo e' ancora vivo. Un GET che
 *     avviasse l'attesa su un server a riposo lo vedrebbe uscire dal `for(;;)`
 *     al primo giro e mandarsi il SIGTERM da solo: e' il mutante che questo
 *     test deve far diventare rosso.
 *
 * @covers RGATE-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawnRealServer, testTmpDir, type RealServer } from "./helpers";

const ROOT = testTmpDir("daemon-idle-get");
let server: RealServer;
let token = "";
let pid = 0;

/** Il server scrive lo stato (con il token) in `$TOPICS_HOME`, che `spawnRealServer` pone qui. */
function readDaemonState(): { pid: number; token: string } {
  return JSON.parse(fs.readFileSync(join(ROOT, "topics-home", "daemon-state.json"), "utf-8"));
}

const bearer = () => ({ authorization: `Bearer ${token}` });

function alive(): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(async () => {
  server = await spawnRealServer(ROOT);
  ({ pid, token } = readDaemonState());
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("GET /__daemon/idle", () => {
  test("a server at rest answers idle, with the whole shape", async () => {
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      idle: true,
      inFlight: 0,
      holding: null,
      unrecoverable: 0,
      alreadyWaiting: false,
    });
  });

  test("it wants the same token as the other /__daemon/* routes", async () => {
    const none = await fetch(`${server.baseUrl}/__daemon/idle`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${server.baseUrl}/__daemon/idle`, {
      headers: { authorization: `Bearer ${"0".repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
  });

  test("reading it starts no wait and sends no signal", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
      expect((await res.json()).alreadyWaiting).toBe(false);
    }
    // L'attesa di un server a riposo termina al primo giro (<= 500 ms) e il
    // SIGTERM parte subito dopo: un secondo e mezzo di margine, poi si guarda.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(alive()).toBe(true);
    const health = await fetch(`${server.baseUrl}/__daemon/healthz`, { headers: bearer() });
    expect(health.status).toBe(200);
    const after = await fetch(`${server.baseUrl}/__daemon/idle`, { headers: bearer() });
    expect((await after.json()).alreadyWaiting).toBe(false);
  }, 30_000);

  test("only GET: a POST to the same path is not a way in", async () => {
    const res = await fetch(`${server.baseUrl}/__daemon/idle`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
    expect(alive()).toBe(true);
  });
});
