/**
 * La versione di protocollo NEGOZIATA, non quella chiesta.
 *
 * `initialize` manda `protocolVersion: 1`; la spec dice che un agente che non
 * la supporta risponde con l'ultima che supporta. Finora quella risposta veniva
 * letta solo per le capability e il numero buttato via: si continuava a parlare
 * v1 su un peer v2, e il guasto arrivava più tardi e senza nome (una
 * `session/new` che risponde storto, una chat che muore opaca).
 *
 * Si prova contro l'agente finto VERO (un processo), perché è lì che vive lo
 * scambio: un peer in-process salterebbe proprio lo spawn e lo stdio.
  * @covers ACP-02
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpProvider, ACP_VERSION_UNSUPPORTED, type AcpProviderConfig } from "../acp";
import type { StreamHandler } from "../types";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.fixture.ts");

const live: AcpProvider[] = [];
const tmpRoots: string[] = [];

function makeProvider(overrides: Partial<AcpProviderConfig> = {}): AcpProvider {
  const root = mkdtempSync(join(tmpdir(), "acp-protocol-"));
  tmpRoots.push(root);
  const p = new AcpProvider({
    type: "acp",
    name: "finto",
    command: process.execPath, // bun: contiene "/", si usa così com'è
    args: [FAKE_AGENT],
    defaultWorkspace: root,
    ...overrides,
  });
  live.push(p);
  p.start();
  return p;
}

/** Raccoglie solo ciò che serve qui: l'errore e il fatto che il turno sia morto. */
function recorder() {
  const errors: string[] = [];
  const done: number[] = [];
  const handler: StreamHandler = {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => done.push(1),
    onError: (e) => errors.push(e),
  };
  return { handler, errors, done };
}

afterEach(() => {
  while (live.length) live.pop()!.stop();
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop()!, { recursive: true, force: true }); } catch { /* già sparito */ }
  }
});

describe("protocolVersion di risposta", () => {
  test("una versione più ALTA della nostra chiude la connessione con un motivo parlante", async () => {
    const provider = makeProvider({ env: { FAKE_ACP_PROTOCOL_VERSION: "2" } });
    const rec = recorder();

    await provider.sendChat("topic:v2", "ciao", rec.handler);

    expect(rec.done).toHaveLength(0);
    expect(rec.errors).toHaveLength(1);
    // Il numero visto entra nel motivo: senza, chi legge il log non sa CON CHE
    // COSA stava parlando.
    expect(rec.errors[0]).toContain(`${ACP_VERSION_UNSUPPORTED}_2`);
  });

  test("dopo il rifiuto il provider non è più connesso e non ritenta", async () => {
    const provider = makeProvider({ env: { FAKE_ACP_PROTOCOL_VERSION: "3" } });
    const rec = recorder();

    await provider.sendChat("topic:v3", "ciao", rec.handler);
    expect(provider.connected).toBe(false);

    // Il secondo turno fallisce SUBITO con lo stesso motivo: se rispawnassimo
    // l'agente otterremmo lo stesso numero al prezzo di un processo per turno.
    await provider.sendChat("topic:v3", "ancora", rec.handler);
    expect(rec.errors).toHaveLength(2);
    expect(rec.errors[1]).toContain(`${ACP_VERSION_UNSUPPORTED}_3`);
    expect(provider.isTurnProcessAlive("topic:v3")).toBe(false);
  });

  test("il diagnose lo dice: requisito rosso, stato non disponibile, versione nel lastError", async () => {
    const provider = makeProvider({ env: { FAKE_ACP_PROTOCOL_VERSION: "7" } });
    await provider.sendChat("topic:v7", "ciao", recorder().handler);

    const diag = await provider.diagnose();
    expect(diag.status).toBe("unavailable");
    expect(diag.lastError).toBe(`${ACP_VERSION_UNSUPPORTED}_7`);
    const protocolReq = diag.requirements.find((r) => r.key === "finto-protocol");
    expect(protocolReq?.present).toBe(false);
    expect(protocolReq?.hint ?? "").toContain("v7");
  });

  test("una versione PIÙ BASSA o assente non blocca niente (retro-compatibilità)", async () => {
    // L'agente che risponde `0` sta dicendo «parlo una v più vecchia»: la spec
    // non chiede di chiudere, e chiudere spegnerebbe un agente funzionante.
    const provider = makeProvider({ env: { FAKE_ACP_PROTOCOL_VERSION: "0" } });
    const rec = recorder();

    await provider.sendChat("topic:v0", "ciao", rec.handler);

    expect(rec.errors).toEqual([]);
    expect(rec.done).toHaveLength(1);
    expect(provider.connected).toBe(true);
  });

  test("un nuovo start() riapre la porta: è la strada per riprovare dopo un aggiornamento", async () => {
    const provider = makeProvider({ env: { FAKE_ACP_PROTOCOL_VERSION: "2" } });
    await provider.sendChat("topic:restart", "ciao", recorder().handler);
    expect(provider.connected).toBe(false);

    provider.start();
    expect(provider.connected).toBe(true);
  });
});
