/**
 * Il trasporto di ACP, provato con due stringhe e nessun processo.
 *
 * Ogni test qui corrisponde a un modo in cui un'integrazione su stdio muore
 * senza dare errore: una riga tagliata da un chunk, del rumore su stdout, una
 * richiesta dell'agente che non riceve risposta, un processo che muore con una
 * promise ancora in volo.
  * @covers ACP-01
 */
import { describe, expect, test } from "bun:test";
import { JsonRpcPeer, JsonRpcRemoteError, RPC_METHOD_NOT_FOUND, RPC_INTERNAL_ERROR } from "./jsonrpc";

function makePeer() {
  const written: Record<string, unknown>[] = [];
  const errors: Array<{ message: string; raw?: string }> = [];
  const peer = new JsonRpcPeer({
    write: (line) => { written.push(JSON.parse(line) as Record<string, unknown>); },
    onTransportError: (message, raw) => { errors.push({ message, raw }); },
  });
  return { peer, written, errors };
}

/** L'errore con cui muore una promise, o `null` se non muore. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

describe("JsonRpcPeer — uscita", () => {
  test("request scrive un messaggio con id crescente e risolve col result", async () => {
    const { peer, written } = makePeer();
    const p = peer.request<{ ok: boolean }>("initialize", { protocolVersion: 1 });
    expect(written[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect(peer.inFlight).toBe(1);

    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    expect(await p).toEqual({ ok: true });
    expect(peer.inFlight).toBe(0);
  });

  test("un errore dell'altro capo diventa JsonRpcRemoteError col codice", async () => {
    const { peer } = makePeer();
    const p = peer.request("session/load", { sessionId: "gone" });
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "sessione sconosciuta" } }) + "\n");
    const err = await rejection(p);
    expect(err).toBeInstanceOf(JsonRpcRemoteError);
    expect((err as JsonRpcRemoteError).code).toBe(-32000);
    expect((err as JsonRpcRemoteError).message).toBe("sessione sconosciuta");
  });

  test("notify non ha id e non lascia niente in volo", () => {
    const { peer, written } = makePeer();
    peer.notify("session/cancel", { sessionId: "s1" });
    expect(written[0]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } });
    expect(peer.inFlight).toBe(0);
  });
});

describe("JsonRpcPeer — framing", () => {
  test("una riga tagliata da più chunk si ricompone", async () => {
    const { peer } = makePeer();
    const p = peer.request("initialize");
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { v: 42 } });
    for (const ch of [line.slice(0, 7), line.slice(7, 20), line.slice(20), "\n"]) peer.feed(ch);
    expect(await p).toEqual({ v: 42 });
  });

  test("più messaggi in un chunk solo arrivano tutti, in ordine", () => {
    const { peer } = makePeer();
    const seen: string[] = [];
    peer.onNotification("session/update", (params) => seen.push(String(params.n)));
    peer.feed(
      [1, 2, 3].map((n) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n } })).join("\n") + "\n",
    );
    expect(seen).toEqual(["1", "2", "3"]);
  });

  test("rumore su stdout NON uccide la sessione (il messaggio dopo passa)", () => {
    const { peer, errors } = makePeer();
    const seen: string[] = [];
    peer.onNotification("session/update", (params) => seen.push(String(params.n)));
    peer.feed("Warning: qualcosa\n");
    peer.feed("[banner] agent v1.2\n");
    peer.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 7 } }) + "\n");
    expect(seen).toEqual(["7"]);
    expect(errors.length).toBe(2);
    expect(errors[0]!.raw).toBe("Warning: qualcosa");
  });

  test("righe vuote si ignorano senza segnalare niente", () => {
    const { peer, errors } = makePeer();
    peer.feed("\n\n   \n");
    expect(errors).toEqual([]);
  });
});

describe("JsonRpcPeer — richieste in entrata", () => {
  test("un metodo noto riceve il result dell'handler", async () => {
    const { peer, written } = makePeer();
    peer.onRequest("session/request_permission", (params) => ({ echo: params.sessionId }));
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: "s1" } }) + "\n");
    await Bun.sleep(1);
    expect(written[0]).toEqual({ jsonrpc: "2.0", id: 9, result: { echo: "s1" } });
  });

  test("un metodo IGNOTO riceve comunque risposta: -32601, mai silenzio", async () => {
    const { peer, written } = makePeer();
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "terminal/create", params: {} }) + "\n");
    await Bun.sleep(1);
    expect(written[0]).toMatchObject({ id: 3, error: { code: RPC_METHOD_NOT_FOUND } });
  });

  test("un handler che lancia diventa -32603, non un turno appeso", async () => {
    const { peer, written } = makePeer();
    peer.onRequest("fs/read_text_file", () => { throw new Error("boom"); });
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "fs/read_text_file" }) + "\n");
    await Bun.sleep(1);
    expect(written[0]).toMatchObject({ id: 4, error: { code: RPC_INTERNAL_ERROR, message: "boom" } });
  });

  test("una notifica ignota si ignora in silenzio (è il suo contratto)", () => {
    const { peer, written, errors } = makePeer();
    peer.feed(JSON.stringify({ jsonrpc: "2.0", method: "qualcosa/di/nuovo" }) + "\n");
    expect(written).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("un handler di notifica che lancia non propaga fuori da feed()", () => {
    const { peer, errors } = makePeer();
    peer.onNotification("session/update", () => { throw new Error("crash nel consumer"); });
    expect(() => peer.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/update" }) + "\n")).not.toThrow();
    expect(errors[0]!.message).toContain("crash nel consumer");
  });
});

describe("JsonRpcPeer — chiusura", () => {
  test("close rigetta TUTTO ciò che è in volo", async () => {
    const { peer } = makePeer();
    const a = peer.request("session/prompt");
    const b = peer.request("session/prompt");
    peer.close("PROCESS_DIED_1");
    expect((await rejection(a) as Error).message).toBe("PROCESS_DIED_1");
    expect((await rejection(b) as Error).message).toBe("PROCESS_DIED_1");
    expect(peer.inFlight).toBe(0);
    expect(peer.isClosed).toBe(true);
  });

  test("dopo close, request rigetta subito invece di restare appesa", async () => {
    const { peer } = makePeer();
    peer.close("stop");
    expect((await rejection(peer.request("initialize")) as Error).message).toBe("ACP_CONNECTION_CLOSED");
  });

  test("close è idempotente (exit + close dello stream arrivano entrambi)", async () => {
    const { peer } = makePeer();
    const p = peer.request("session/prompt");
    peer.close("primo");
    peer.close("secondo");
    expect((await rejection(p) as Error).message).toBe("primo");
  });

  test("dopo close, feed e notify non scrivono più niente", () => {
    const { peer, written } = makePeer();
    peer.close("stop");
    peer.notify("session/cancel");
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sconosciuto" }) + "\n");
    expect(written).toEqual([]);
  });

  test("una risposta senza richiesta in attesa si segnala e non esplode", () => {
    const { peer, errors } = makePeer();
    peer.feed(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }) + "\n");
    expect(errors[0]!.message).toContain("99");
  });
});
