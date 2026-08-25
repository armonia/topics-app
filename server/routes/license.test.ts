/**
 * La rotta della licenza non è un cancello, e questo file lo fissa.
 *
 * Il modo in cui una rotta del genere si guasta è sempre lo stesso: qualcuno
 * decide che «senza licenza» è un errore, e da quel momento un'interfaccia che
 * chiede «cosa posso fare» riceve un `4xx` — indistinguibile, per chi guarda,
 * da una macchina rotta. Qui `GET` risponde `200` in ogni caso, e ciò che
 * cambia è il CONTENUTO.
  * @covers LICENSE-04
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLicenseRouter } from "./license";
import { creaServizioLicenza, type CaricoGettone, type EntitlementSulFilo } from "../lib/licenza";
import type { AppContext } from "../types";

const IID = "installazione-di-prova";

function nuovaCoppia() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privata: privateKey, pubblicaB64: der.subarray(der.length - 32).toString("base64") };
}

function firma(privata: KeyObject, carico: Partial<CaricoGettone> = {}): string {
  const pieno: CaricoGettone = {
    v: 1, iid: IID, plan: "team", seats: 5, exp: 4_000_000_000_000, ...carico,
  };
  const p = Buffer.from(JSON.stringify(pieno), "utf8").toString("base64url");
  return `${p}.${sign(null, Buffer.from(p, "ascii"), privata).toString("base64url")}`;
}

const servizio = nuovaCoppia();

/** `root` scrive anche dove i permessi dicono di no: lì il caso «cartella non
 *  scrivibile» non si riproduce, e si salta invece di dichiararlo verde. */
const itSenzaRoot = (typeof process.getuid === "function" && process.getuid() === 0) ? it.skip : it;

function creaCtx(stateDir: string | null) {
  // UN'istanza sola, come in `server.ts`: se ogni chiamata ne creasse una nuova
  // la cache non verrebbe mai messa alla prova, e «installa poi rileggi»
  // passerebbe anche con un servizio che non si accorge dei cambiamenti.
  const svc = stateDir
    ? creaServizioLicenza({
      stateDir,
      env: { TOPICS_LICENSE_PUBKEYS: `k1:${servizio.pubblicaB64}` },
      installationId: IID,
    })
    : null;
  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json() as unknown; } catch { return null; }
    },
    licenza: svc ? () => svc : undefined,
  } as unknown as AppContext;
  return ctx;
}

function chiama(
  router: ReturnType<typeof createLicenseRouter>,
  method = "GET",
  body?: unknown,
): Promise<Response | null> {
  const url = new URL("http://127.0.0.1:3333/api/license");
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

describe("rotta licenza · leggere non fallisce mai", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "licenza-rotta-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("senza gettone risponde 200 col piano gratuito, non un errore", async () => {
    const r = await chiama(createLicenseRouter(creaCtx(dir)));
    expect(r?.status).toBe(200);
    expect(await r!.json() as EntitlementSulFilo).toEqual({
      plan: "free", seats: 1, remoteAccess: false, expiresAt: null,
      reason: "no_token", installationId: IID,
    });
  });

  it("senza nemmeno il servizio innestato risponde comunque, e nel verso libero", async () => {
    // Un contesto ridotto non deve poter produrre una macchina bloccata.
    const r = await chiama(createLicenseRouter(creaCtx(null)));
    expect(r?.status).toBe(200);
    expect((await r!.json() as EntitlementSulFilo).plan).toBe("free");
  });

  it("un gettone buono si installa e la lettura successiva lo riflette", async () => {
    const router = createLicenseRouter(creaCtx(dir));
    const messo = await chiama(router, "PUT", { token: firma(servizio.privata, { seats: 6 }) });
    expect(messo?.status).toBe(200);
    expect((await messo!.json() as EntitlementSulFilo).seats).toBe(6);

    const letto = await chiama(router);
    expect(await letto!.json() as EntitlementSulFilo).toMatchObject({
      plan: "team", seats: 6, remoteAccess: true, reason: "valid",
    });
  });

  it("un gettone di un'altra macchina si rifiuta DICENDO perché", async () => {
    const router = createLicenseRouter(creaCtx(dir));
    const r = await chiama(router, "PUT", { token: firma(servizio.privata, { iid: "un-altra-macchina" }) });
    expect(r?.status).toBe(409);
    const corpo = await r!.json() as EntitlementSulFilo & { error: string };
    expect(corpo.error).toBe("token_refused");
    expect(corpo.reason).toBe("other_installation");
    // E la macchina resta sul gratuito, non in un limbo «in attesa».
    expect((await (await chiama(router))!.json() as EntitlementSulFilo).reason).toBe("no_token");
  });

  itSenzaRoot("una cartella di stato non scrivibile NON è un gettone rifiutato", async () => {
    // Il `409` sbagliato: gettone perfetto, macchina giusta, pagamento andato a
    // buon fine — e un `token_refused` perché la directory non accetta
    // scritture. Chi lo riceve va a cercare il problema nel gettone, che è
    // l'unico posto dove non c'è.
    chmodSync(dir, 0o500);
    try {
      const router = createLicenseRouter(creaCtx(dir));
      const r = await chiama(router, "PUT", { token: firma(servizio.privata, { seats: 3 }) });
      expect(r?.status).toBe(200);
      expect(await r!.json() as EntitlementSulFilo).toMatchObject({
        plan: "team", seats: 3, remoteAccess: true, reason: "valid",
      });
      // E la lettura successiva dice la stessa cosa: una risposta buona seguita
      // da un `GET` che torna al gratuito sarebbe la stessa bugia, spostata.
      expect((await (await chiama(router))!.json() as EntitlementSulFilo).plan).toBe("team");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("un corpo senza gettone è una richiesta sbagliata, non un rifiuto di licenza", async () => {
    const r = await chiama(createLicenseRouter(creaCtx(dir)), "PUT", { token: "  " });
    expect(r?.status).toBe(400);
  });

  it("si può togliere: una licenza inamovibile non si sposta di macchina", async () => {
    const router = createLicenseRouter(creaCtx(dir));
    await chiama(router, "PUT", { token: firma(servizio.privata) });
    const via = await chiama(router, "DELETE");
    expect((await via!.json() as EntitlementSulFilo).plan).toBe("free");
    expect((await (await chiama(router))!.json() as EntitlementSulFilo).remoteAccess).toBe(false);
  });

  it("non si intromette sugli altri percorsi", async () => {
    const router = createLicenseRouter(creaCtx(dir));
    const url = new URL("http://127.0.0.1:3333/api/topics");
    const r = await router(new Request(url), url, url.pathname, "GET");
    expect(r).toBeNull();
  });
});
