/**
 * Chi conia e chi verifica devono restare d'accordo.
 *
 * ── COSA PRESIDIA, E PERCHÉ NON BASTA GUARDARE ──────────────────────────────
 * Due file che non si importano a vicenda: `scripts/licenza.ts` firma,
 * `server/lib/licenza.ts` verifica. Fra loro c'è un accordo tacito su tre cose,
 * e ognuna è un modo diverso di rompere tutto senza un errore leggibile:
 *
 *   1. cosa si firma — il SEGMENTO base64url in ascii, non i byte del JSON.
 *      Firmare l'altra cosa produce gettoni che non verificano, e il motivo
 *      che esce è `bad_signature`: indistinguibile da una chiave sbagliata.
 *      Andresti a cercare il guasto nelle chiavi, che sono giuste.
 *   2. il formato della chiave — 32 byte grezzi in base64url, non PEM.
 *   3. la forma del carico — `v`, `iid`, `plan`, `seats`, `exp`.
 *
 * Un test che li guarda separatamente li vedrebbe entrambi verdi mentre non si
 * parlano. Questo li fa parlare: conia con lo script VERO (via processo, così
 * prova anche la riga di comando) e verifica col modulo VERO.
 *
 * ── PERCHÉ IN PRODUZIONE NON CAMBIA NIENTE ──────────────────────────────────
 * Le chiavi qui sono generate al volo e vivono quanto il test: ogni verifica
 * riceve `[]` al posto di `CHIAVI_INTEGRATE`, così questo file prova l'accordo
 * fra i due lati e non tocca la chiave con cui firmiamo davvero. Nessun gettone
 * coniato qui vale su una macchina vera — e l'ultimo caso lo controlla invece
 * di darlo per scontato.
  * @covers LICENSE-07
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { CHIAVI_INTEGRATE, NODE_LABEL, caricaChiavi, verificaGettone } from "../../server/lib/licenza";
import { leggiCaricoNonVerificato } from "../../scripts/conio-lib";

const RADICE = join(import.meta.dir, "..", "..");
const STRUMENTO = join(RADICE, "scripts", "licenza.ts");
const IID = "0123456789abcdef01234567";

function esegui(argomenti: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", [STRUMENTO, ...argomenti], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: RADICE,
  });
}

/** La coppia, dalla bocca dello strumento: se cambia il formato di stampa, il
 *  test si accorge qui invece che tre passi più in là. */
function coppia(): { pub: string; priv: string } {
  const r = esegui(["chiavi"], { TOPICS_LICENSE_KID: "prova-1" });
  expect(r.status, r.stderr).toBe(0);
  const pub = /"(prova-1:[A-Za-z0-9_-]+)"/.exec(r.stdout)?.[1];
  const priv = /TOPICS_LICENSE_PRIVKEY="([A-Za-z0-9_-]+)"/.exec(r.stdout)?.[1];
  expect(pub, "lo strumento non stampa più la chiave pubblica in forma usabile").toBeTruthy();
  expect(priv, "lo strumento non stampa più la chiave privata in forma usabile").toBeTruthy();
  return { pub: pub!, priv: priv! };
}

function conia(priv: string, args: string[]) {
  const r = esegui(["conia", ...args], { TOPICS_LICENSE_PRIVKEY: priv, TOPICS_LICENSE_KID: "prova-1" });
  const gettone = r.stdout.split("\n").map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(l) && l.length > 80);
  return { r, gettone };
}

describe("licenza · chi conia e chi verifica parlano la stessa lingua", () => {
  it("un gettone coniato dallo strumento è VALIDO per il modulo", () => {
    const { pub, priv } = coppia();
    const { r, gettone } = conia(priv, [IID, "5", "365"]);
    expect(r.status, r.stderr).toBe(0);
    expect(gettone, "lo strumento non ha stampato nessun gettone").toBeTruthy();

    const chiavi = caricaChiavi({ TOPICS_LICENSE_PUBKEYS: pub }, []);
    expect(chiavi.length, "la chiave pubblica stampata non è caricabile").toBe(1);

    const esito = verificaGettone(gettone!, { chiavi, installationId: IID, ora: Date.now() });
    expect(esito.motivo).toBe("valid");
    expect(esito.piano).toBe("team");
    expect(esito.posti).toBe(5);
    expect(esito.accessoRemoto).toBe(true);
  });

  it("il gettone di un'altra installazione NON vale su questa", () => {
    // È l'unica domanda su cui una firma non ha voce: il carico è autentico e
    // parla di un'altra macchina. Senza questo controllo un cliente pagante
    // passa la propria licenza a chiunque.
    const { pub, priv } = coppia();
    const { gettone } = conia(priv, [IID, "5", "365"]);
    const esito = verificaGettone(gettone!, {
      chiavi: caricaChiavi({ TOPICS_LICENSE_PUBKEYS: pub }, []),
      installationId: "ffffffffffffffffffffffff",
      ora: Date.now(),
    });
    expect(esito.motivo).not.toBe("valid");
    expect(esito.piano).toBe("free");
  });

  it("una chiave DIVERSA non verifica, e non è un dettaglio", () => {
    // Se questo passasse, «firmato da noi» non vorrebbe dire niente.
    const a = coppia();
    const b = coppia();
    const { gettone } = conia(a.priv, [IID, "3", "30"]);
    const esito = verificaGettone(gettone!, {
      chiavi: caricaChiavi({ TOPICS_LICENSE_PUBKEYS: b.pub }, []),
      installationId: IID,
      ora: Date.now(),
    });
    expect(esito.motivo).toBe("bad_signature");
    expect(esito.piano).toBe("free");
  });

  it("scaduto è scaduto, e si torna al piano gratuito senza bloccare niente", () => {
    const { pub, priv } = coppia();
    const { gettone } = conia(priv, [IID, "5", "1"]);
    const fraDueGiorni = Date.now() + 2 * 86_400_000;
    const esito = verificaGettone(gettone!, {
      chiavi: caricaChiavi({ TOPICS_LICENSE_PUBKEYS: pub }, []),
      installationId: IID,
      ora: fraDueGiorni,
    });
    expect(esito.motivo).toBe("expired");
    expect(esito.piano).toBe("free");
  });

  it("senza chiave privata lo strumento si RIFIUTA invece di inventare", () => {
    const r = esegui(["conia", IID], { TOPICS_LICENSE_PRIVKEY: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("TOPICS_LICENSE_PRIVKEY");
  });

  it("posti fuori scala sono rifiutati alla fonte", () => {
    const { priv } = coppia();
    for (const posti of ["0", "-3", "99999"]) {
      const r = esegui(["conia", IID, posti], { TOPICS_LICENSE_PRIVKEY: priv });
      expect(`${posti}→${r.status}`, "un numero assurdo non deve diventare un gettone").not.toBe(`${posti}→0`);
    }
  });

  it("le chiavi usate qui non sono quelle di produzione", () => {
    // La rete di sicurezza del test stesso. Le coppie di questo file nascono
    // al volo e muoiono col processo: nessun gettone coniato qui deve poter
    // valere su una macchina vera, e ciò che lo garantisce è che la sua
    // pubblica non finisca mai in `CHIAVI_INTEGRATE`.
    const { pub } = coppia();
    const b64 = pub.slice(pub.indexOf(":") + 1);
    expect(CHIAVI_INTEGRATE.some((k) => k.includes(b64))).toBe(false);

    // E il verso opposto: la chiave integrata NON verifica un gettone di prova.
    const { gettone } = conia(coppia().priv, [IID, "5", "365"]);
    const esito = verificaGettone(gettone!, {
      chiavi: caricaChiavi({}, CHIAVI_INTEGRATE),
      installationId: IID,
      ora: Date.now(),
    });
    expect(esito.motivo).toBe("bad_signature");
    expect(esito.piano).toBe("free");
  });

  // ── one token PER cloud node, bound to the Mac's installation ─────────────
  it("conia-nodo: un posto, 30 giorni, etichetta dentro, VALIDO sull'installazione del Mac", () => {
    const { pub, priv } = coppia();
    const r = esegui(["conia-nodo", IID, "topics-permanent-node"], { TOPICS_LICENSE_PRIVKEY: priv, TOPICS_LICENSE_KID: "prova-1" });
    expect(r.status, r.stderr).toBe(0);
    const gettone = r.stdout.split("\n").map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(l) && l.length > 80);
    expect(gettone).toBeTruthy();

    const payload = leggiCaricoNonVerificato(gettone!);
    expect(payload?.node).toBe("topics-permanent-node");
    expect(payload?.seats).toBe(1);
    const days = ((payload?.exp ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);

    const chiavi = caricaChiavi({ TOPICS_LICENSE_PUBKEYS: pub }, []);
    const onMac = verificaGettone(gettone!, { chiavi, installationId: IID, ora: Date.now() });
    expect(onMac.motivo).toBe("valid");
    expect(onMac.accessoRemoto).toBe(true);
    expect(onMac.posti).toBe(1);
    // On another installation (a node that does not declare the Mac's) it is refused.
    const elsewhere = verificaGettone(gettone!, { chiavi, installationId: "ffffffffffffffffffffffff", ora: Date.now() });
    expect(elsewhere.motivo).toBe("other_installation");
    expect(elsewhere.accessoRemoto).toBe(false);
    // The summary names the node.
    expect(r.stdout).toContain("nodo          : topics-permanent-node");
  });

  it("conia-nodo rifiuta un'etichetta che non è un nome host", () => {
    const { priv } = coppia();
    for (const nome of ["", "../x", "a b", "-x", "x".repeat(65)]) {
      const r = esegui(["conia-nodo", IID, nome], { TOPICS_LICENSE_PRIVKEY: priv });
      expect(r.status, `etichetta «${nome}» non doveva passare`).not.toBe(0);
    }
  });

  it("un carico con `node` storto è rifiutato da chi verifica, anche se la firma è buona", () => {
    // Same rule as the other fields: rejected, not interpreted. The token is
    // really signed, by hand, because the tool would never mint it.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
    const badPayload = { v: 1, iid: IID, plan: "team", seats: 1, exp: Date.now() + 86_400_000, node: "a/b" };
    const seg = Buffer.from(JSON.stringify(badPayload)).toString("base64url");
    const gettone = `${seg}.${sign(null, Buffer.from(seg, "ascii"), privateKey).toString("base64url")}`;
    const esito = verificaGettone(gettone, {
      chiavi: caricaChiavi({ TOPICS_LICENSE_PUBKEYS: `prova-1:${pub}` }, []),
      installationId: IID,
      ora: Date.now(),
    });
    expect(esito.motivo).toBe("malformed");
    expect(esito.piano).toBe("free");
    expect(NODE_LABEL.test("topics-permanent-node")).toBe(true);
  });
});
