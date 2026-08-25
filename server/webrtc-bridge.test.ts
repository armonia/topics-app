/**
 * Il broker adotta un sidecar già in ascolto sul nostro socket — è così che
 * sopravvive a un reload del server. Ma se quel sidecar è di una build vecchia
 * è un ORFANO, e l'adozione è il motivo per cui `reapOrphanBridges()` non
 * scattava mai: gira solo dopo che `tryConnect()` fallisce, e un orfano il
 * socket lo tiene e risponde. Risultato osservato: un sidecar buggato al 42% di
 * CPU sopravvissuto a sei giorni di riavvii.
 *
 * Qui si verifica l'altra metà del fix (il lato Rust è in
 * desktop-tauri/webrtc-bridge/src/main.rs): un sidecar che dichiara una build
 * diversa dalla nostra viene mietuto all'avvio, senza aspettare un offer.
  * @covers WEBRTC-01
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "child_process";
import { copyFileSync, existsSync, mkdtempSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SIDECAR = resolve(import.meta.dir, "../desktop-tauri/webrtc-bridge/target/release/webrtc-bridge");

/** Il binario è un artefatto di build locale: senza, il test non ha soggetto. */
const haveSidecar = existsSync(SIDECAR);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe.skipIf(!haveSidecar)("webrtc bridge — mietitura dell'orfano stantìo", () => {
  it("mieta all'avvio un sidecar di build diversa dalla nostra", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webrtc-reap-"));
    const sock = join(dir, "orfano.sock");

    // Il "nostro" binario: una copia con mtime spostato indietro di un'ora. Il
    // sidecar dichiara nel `ready` l'mtime del proprio eseguibile — che è
    // l'originale — quindi le due build non combaciano, esattamente come per un
    // orfano rimasto in giro da prima di una ricompilazione.
    const ourBin = join(dir, "webrtc-bridge");
    copyFileSync(SIDECAR, ourBin);
    const oldTime = new Date(Date.now() - 3_600_000);
    utimesSync(ourBin, oldTime, oldTime);

    const orfano = spawn(SIDECAR, ["--socket", sock], { stdio: "ignore" });
    const pid = orfano.pid!;
    try {
      expect(await waitUntil(() => existsSync(sock), 5000)).toBe(true);

      process.env.TOPICS_WEBRTC_SOCKET = sock;
      process.env.TOPICS_WEBRTC_BRIDGE_BIN = ourBin;
      const { createWebrtcBridge } = await import("./webrtc-bridge");
      const bridge = createWebrtcBridge();

      expect(await waitUntil(() => !alive(pid), 8000)).toBe(true);
      await bridge.shutdown();
    } finally {
      try { orfano.kill("SIGKILL"); } catch { /* già morto: è il punto del test */ }
      delete process.env.TOPICS_WEBRTC_SOCKET;
      delete process.env.TOPICS_WEBRTC_BRIDGE_BIN;
    }
  }, 20_000);

  it("lascia in vita un sidecar della NOSTRA build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webrtc-keep-"));
    const sock = join(dir, "sano.sock");

    const sano = spawn(SIDECAR, ["--socket", sock], { stdio: "ignore" });
    const pid = sano.pid!;
    try {
      expect(await waitUntil(() => existsSync(sock), 5000)).toBe(true);

      // Stavolta il binario atteso È quello che sta girando: stesso mtime,
      // stessa build, nessuna mietitura.
      process.env.TOPICS_WEBRTC_SOCKET = sock;
      process.env.TOPICS_WEBRTC_BRIDGE_BIN = SIDECAR;
      const { createWebrtcBridge } = await import("./webrtc-bridge");
      const bridge = createWebrtcBridge();

      await new Promise((r) => setTimeout(r, 2000));
      expect(alive(pid)).toBe(true);
      await bridge.shutdown();
    } finally {
      try { sano.kill("SIGKILL"); } catch { /* ignore */ }
      delete process.env.TOPICS_WEBRTC_SOCKET;
      delete process.env.TOPICS_WEBRTC_BRIDGE_BIN;
    }
  }, 20_000);
});
