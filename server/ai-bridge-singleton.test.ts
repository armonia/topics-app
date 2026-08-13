import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chi possiede il socket del broker, e chi ha il diritto di prenderglielo.
//
// Il 13/08/2026 questo contratto e' costato la macchina, due volte nella stessa
// ora e una anche dopo un riavvio: 1.612 daemon sullo stesso socket in dodici
// minuti, 3.653 processi, swap a 36 GB su 32 di RAM, load 644, e il server su
// :3333 irraggiungibile. La causa era una sola riga di giudizio: `probeBridge`
// restituisce `timeout` sia quando il proprietario e' morto sia quando la
// macchina e' talmente carica da non farlo rispondere entro 1,5 s, e
// `checkExistingBridge` trattava i due casi allo stesso modo. Ogni daemon nuovo
// sfrattava il precedente; `listen()` su un path appena scollegato non da'
// EADDRINUSE ma crea un file nuovo, quindi restavano tutti vivi e nessuno
// raggiungibile.
//
// I test qui sotto sono la recinzione di quel giudizio. Il primo e' quello che
// conta: va visto ROSSO sul codice di prima.

const BRIDGE = join(import.meta.dir, "ai-bridge.mjs");
const PROBE_MS = 1_500; // il timeout dentro probeBridge()

type Pulizia = () => void;
const daPulire: Pulizia[] = [];
afterEach(() => { while (daPulire.length) daPulire.pop()?.(); });

function cartellaStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-singleton-"));
  daPulire.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gia' via */ } });
  return dir;
}

function percorsoSocket(nome: string): string {
  // Corto: un socket unix oltre i 104 byte non si lega (EINVAL).
  const sock = join(tmpdir(), `abs-${nome}-${process.pid}.sock`);
  daPulire.push(() => {
    for (const p of [sock, `${sock}.lock`, sock.replace(/\.sock$/, ".pid")]) {
      try { rmSync(p, { force: true }); } catch { /* gia' via */ }
    }
  });
  return sock;
}

/** Il pid file che il daemon scrive accanto al socket. */
function percorsoPid(sock: string): string {
  return sock.replace(/\.sock$/, ".pid");
}

/**
 * Un proprietario che ACCETTA la connessione e non risponde mai: e' la macchina
 * in ginocchio, non un daemon morto. Gira in un processo suo, perche' il punto
 * del test e' che quel processo sopravviva.
 */
async function proprietarioMuto(sock: string): Promise<{ pid: number; vivo: () => boolean }> {
  const codice = `
    const net = require("net"), fs = require("fs");
    const srv = net.createServer(() => { /* accetta e tace */ });
    srv.listen(${JSON.stringify(sock)}, () => {
      fs.writeFileSync(${JSON.stringify(percorsoPid(sock))}, String(process.pid));
      console.log("pronto");
    });
    setTimeout(() => process.exit(0), 30000);
  `;
  const proc = Bun.spawn([process.execPath, "-e", codice], { stdout: "pipe", stderr: "pipe" });
  daPulire.push(() => { try { proc.kill(9); } catch { /* gia' morto */ } });
  const atteso = Date.now() + 5_000;
  while (Date.now() < atteso && !existsSync(percorsoPid(sock))) {
    await Bun.sleep(50);
  }
  return {
    pid: proc.pid,
    vivo: () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } },
  };
}

/** Lancia il daemon vero e restituisce codice di uscita e stderr. */
async function lanciaDaemon(sock: string, store: string): Promise<{ codice: number; testo: string }> {
  const proc = Bun.spawn(
    [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
    { stdout: "pipe", stderr: "pipe" },
  );
  daPulire.push(() => { try { proc.kill(9); } catch { /* gia' morto */ } });
  const codice = await proc.exited;
  const testo = await new Response(proc.stderr).text();
  return { codice, testo };
}

function ascoltaQualcuno(sock: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((res) => {
    if (!existsSync(sock)) { res(false); return; }
    const c = net.connect(sock);
    let fatto = false;
    const fine = (v: boolean) => { if (fatto) return; fatto = true; try { c.destroy(); } catch { /* gia' chiuso */ } res(v); };
    c.on("connect", () => fine(true));
    c.on("error", () => fine(false));
    setTimeout(() => fine(false), timeoutMs);
  });
}

describe("ai-bridge · chi possiede il socket", () => {
  test("un proprietario VIVO che non fa in tempo a rispondere non viene sfrattato", async () => {
    const sock = percorsoSocket("muto");
    const store = cartellaStore();
    const padrone = await proprietarioMuto(sock);
    expect(padrone.vivo()).toBe(true);

    const { codice, testo } = await lanciaDaemon(sock, store);

    // Il daemon nuovo si tira indietro...
    expect(codice).not.toBe(0);
    expect(testo).toContain("NON lo sfratto");
    // ...e soprattutto NON tocca chi c'era. E' questa riga che, mancando,
    // trasformava una macchina carica in 1.612 processi.
    expect(padrone.vivo()).toBe(true);
    // Il pid file resta del proprietario: nessuno gli ha rubato il posto.
    expect(readFileSync(percorsoPid(sock), "utf8").trim()).toBe(String(padrone.pid));
  }, 20_000);

  test("un socket stantio, senza nessuno in ascolto, viene preso", async () => {
    const sock = percorsoSocket("stantio");
    const store = cartellaStore();
    // Il file c'e' ma non e' un socket vivo, e il pid registrato non esiste:
    // e' il caso in cui sfrattare e' giusto, e il daemon DEVE prenderlo.
    writeFileSync(sock, "");
    writeFileSync(percorsoPid(sock), "999999");

    const proc = Bun.spawn(
      [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
      { stdout: "pipe", stderr: "pipe" },
    );
    daPulire.push(() => { try { proc.kill(9); } catch { /* gia' morto */ } });

    const atteso = Date.now() + 8_000;
    let preso = false;
    while (Date.now() < atteso && !preso) {
      preso = await ascoltaQualcuno(sock);
      if (!preso) await Bun.sleep(100);
    }
    expect(preso).toBe(true);
    expect(readFileSync(percorsoPid(sock), "utf8").trim()).toBe(String(proc.pid));
  }, 20_000);

  test("cinque daemon lanciati insieme su un socket libero: ne resta in ascolto UNO", async () => {
    const sock = percorsoSocket("rissa");
    const store = cartellaStore();

    const nati = Array.from({ length: 5 }, () => {
      const proc = Bun.spawn(
        [process.execPath, BRIDGE, "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
        { stdout: "pipe", stderr: "pipe" },
      );
      daPulire.push(() => { try { proc.kill(9); } catch { /* gia' morto */ } });
      return proc;
    });

    // Si aspetta che la rissa si esaurisca: chi perde ESCE, e questo e' il
    // punto. Prima uscivano tutti in ascolto e restavano vivi per sempre.
    const atteso = Date.now() + PROBE_MS * 4 + 6_000;
    let vivi = nati.length;
    while (Date.now() < atteso) {
      vivi = nati.filter((p) => p.exitCode === null && p.signalCode === null).length;
      if (vivi <= 1) break;
      await Bun.sleep(200);
    }

    expect(vivi).toBe(1);
    expect(await ascoltaQualcuno(sock)).toBe(true);
  }, 30_000);
});
