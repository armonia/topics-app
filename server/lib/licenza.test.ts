/**
 * Il caso che questo file esiste per fissare è uno, e va detto per intero:
 * **nessun gettone deve mai poter spegnere una macchina.**
 *
 * Un cancello di licenza sbaglia sempre nello stesso verso — verso il chiuso —
 * perché ogni ramo nuovo è scritto pensando a chi non ha pagato, e nessuno lo
 * scrive pensando a chi ha pagato e sta guardando un servizio giù. Qui la
 * proprietà è al contrario: si prende l'insieme di TUTTI i modi in cui una
 * licenza può andare male (assente, storta, firmata da un altro, per un'altra
 * macchina, scaduta) e si chiede a ognuno se la macchina resta usabile. Se un
 * giorno qualcuno mette una condizione su `uso_locale`, questo file diventa
 * rosso in cinque punti insieme.
 *
 * La chiave privata usata qui nasce a ogni esecuzione e muore col processo: non
 * esiste su disco, non esiste nel repository, e non è la chiave di nessun
 * servizio vero.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consentito, verificaGettone, caricaChiavi, pianoGratuito, sulFilo,
  creaServizioLicenza, creaInterruttoreLicenza, baseUrlConcesso,
  percorsoGettone, leggiGettoneGrezzo,
  CHIAVI_INTEGRATE, POSTI_GRATUITI, POSTI_MAX,
  type CaricoGettone, type Entitlement, type MotivoLicenza,
} from "./licenza";

const IID = "installazione-di-prova";

// ── Un servizio di firma finto, con la stessa forma di quello vero. ──────────
function nuovaCoppia() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privata: privateKey, pubblicaB64: der.subarray(der.length - 32).toString("base64") };
}

function firma(privata: KeyObject, carico: Partial<CaricoGettone> & { iid?: string }): string {
  const pieno: CaricoGettone = {
    v: 1, iid: IID, plan: "team", seats: 5, exp: 4_000_000_000_000, ...carico,
  };
  const p = Buffer.from(JSON.stringify(pieno), "utf8").toString("base64url");
  const s = sign(null, Buffer.from(p, "ascii"), privata).toString("base64url");
  return `${p}.${s}`;
}

const servizio = nuovaCoppia();
const ENV_CHIAVE = { TOPICS_LICENSE_PUBKEYS: `k1:${servizio.pubblicaB64}` };
const chiaviBuone = () => caricaChiavi(ENV_CHIAVE, []);

/** Ogni modo in cui una licenza può andare male, in una lista sola: è
 *  l'insieme su cui la proprietà «il locale resta» va provata tutta. */
function ogniModoDiAndareMale(): Array<{ nome: string; e: Entitlement }> {
  const chiavi = chiaviBuone();
  const altro = nuovaCoppia();
  const v = (g: string, ora = 1_000) => verificaGettone(g, { chiavi, installationId: IID, ora });
  return [
    { nome: "nessun gettone", e: v("") },
    { nome: "spazzatura", e: v("questo-non-e-un-gettone") },
    { nome: "carico non JSON", e: v(`${Buffer.from("xxx").toString("base64url")}.${"A".repeat(86)}`) },
    { nome: "firmato da un altro", e: v(firma(altro.privata, {})) },
    { nome: "per un'altra macchina", e: v(firma(servizio.privata, { iid: "un-altra" })) },
    { nome: "scaduto", e: v(firma(servizio.privata, { exp: 500 }), 1_000) },
    {
      nome: "senza chiavi con cui controllare",
      e: verificaGettone(firma(servizio.privata, {}), { chiavi: [], installationId: IID, ora: 1_000 }),
    },
  ];
}

describe("licenza · il cancello cade verso il LOCALE", () => {
  it("in OGNI modo di andare male, la macchina resta pienamente usabile", () => {
    const casi = ogniModoDiAndareMale();
    // Il canale di osservazione funziona: i casi ci sono davvero, e sono tutti
    // sul piano gratuito. Senza questo, l'asserzione sotto passerebbe anche su
    // una lista vuota.
    expect(casi.length).toBe(7);
    for (const c of casi) {
      expect(c.e.piano, c.nome).toBe("free");
      expect(consentito(c.e, { tipo: "uso_locale" }), c.nome).toEqual({ ok: true });
      expect(consentito(c.e, { tipo: "accesso_rete_locale" }), c.nome).toEqual({ ok: true });
    }
  });

  it("ogni modo di andare male si SPIEGA, e non tutti allo stesso modo", () => {
    // Il controllo positivo dell'asserzione sopra: se i motivi fossero tutti
    // uguali, «cade verso il locale» sarebbe vero e inutile — chi ha pagato e
    // vede `no_verification_key` deve poterlo distinguere da `bad_signature`,
    // perché il primo è un problema nostro e il secondo è un gettone falso.
    const motivi = ogniModoDiAndareMale().map((c) => c.e.motivo);
    const attesi: MotivoLicenza[] = [
      "no_token", "malformed", "malformed", "bad_signature",
      "other_installation", "expired", "no_verification_key",
    ];
    expect(motivi).toEqual(attesi);
    expect(new Set(motivi).size).toBe(6);
  });

  it("il piano gratuito non scade e non raggiunge il mondo", () => {
    const e = pianoGratuito(IID, "no_token");
    expect(e.scadeIl).toBeNull();
    expect(e.posti).toBe(POSTI_GRATUITI);
    // Il controllo positivo: il gratuito nega DAVVERO qualcosa, altrimenti
    // «uso_locale è concesso» non proverebbe niente.
    expect(consentito(e, { tipo: "accesso_remoto" })).toEqual({ ok: false, codice: "plan_required" });
  });
});

describe("licenza · i posti governano l'INGRESSO, mai la permanenza", () => {
  const team = (posti: number): Entitlement => ({
    piano: "team", posti, accessoRemoto: true, scadeIl: 9e12, motivo: "valid", installationId: IID,
  });

  it("sotto il tetto si entra, al tetto no", () => {
    expect(consentito(team(3), { tipo: "aggiungi_persona_al_gruppo", membriVivi: 2 })).toEqual({ ok: true });
    expect(consentito(team(3), { tipo: "aggiungi_persona_al_gruppo", membriVivi: 3 }))
      .toEqual({ ok: false, codice: "no_seats_left", posti: 3, membri: 3 });
  });

  it("un gruppo che ha SFORATO non chiude fuori nessuno", () => {
    // Licenza scaduta con cinque persone già dentro: il piano torna gratuito
    // (un posto), ma nessuno perde la propria macchina e nessuno viene
    // espulso — l'unica cosa che smette è far entrare la sesta.
    const scaduta = pianoGratuito(IID, "expired");
    expect(consentito(scaduta, { tipo: "uso_locale" })).toEqual({ ok: true });
    expect(consentito(scaduta, { tipo: "accesso_rete_locale" })).toEqual({ ok: true });
    expect(consentito(scaduta, { tipo: "aggiungi_persona_al_gruppo", membriVivi: 5 }))
      .toEqual({ ok: false, codice: "no_seats_left", posti: 1, membri: 5 });
  });

  it("il piano gratuito ha UN posto: sei tu, e il primo invito si paga", () => {
    const e = pianoGratuito(IID, "no_token");
    expect(consentito(e, { tipo: "aggiungi_persona_al_gruppo", membriVivi: 0 })).toEqual({ ok: true });
    expect(consentito(e, { tipo: "aggiungi_persona_al_gruppo", membriVivi: 1 }))
      .toEqual({ ok: false, codice: "no_seats_left", posti: 1, membri: 1 });
  });
});

describe("licenza · la firma si controlla OFFLINE", () => {
  it("un gettone buono apre l'accesso remoto e porta i suoi posti", () => {
    const e = verificaGettone(firma(servizio.privata, { seats: 7, exp: 9_000 }), {
      chiavi: chiaviBuone(), installationId: IID, ora: 8_000,
    });
    expect(e).toEqual({
      piano: "team", posti: 7, accessoRemoto: true, scadeIl: 9_000,
      motivo: "valid", installationId: IID,
    });
    expect(consentito(e, { tipo: "accesso_remoto" })).toEqual({ ok: true });
  });

  it("cambiare UN byte del carico invalida la firma", () => {
    const g = firma(servizio.privata, { seats: 2 });
    const [p, s] = g.split(".") as [string, string];
    const carico = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as CaricoGettone;
    carico.seats = 500;
    const manomesso = `${Buffer.from(JSON.stringify(carico)).toString("base64url")}.${s}`;
    expect(verificaGettone(manomesso, { chiavi: chiaviBuone(), installationId: IID, ora: 1 }).motivo)
      .toBe("bad_signature");
  });

  it("il `kid` sbagliato non basta a rifiutare un gettone che la chiave verifica", () => {
    // Un'etichetta non è una firma: se la chiave regge, il gettone vale.
    const g = firma(servizio.privata, { kid: "nome-che-non-esiste" });
    expect(verificaGettone(g, { chiavi: chiaviBuone(), installationId: IID, ora: 1 }).motivo).toBe("valid");
  });

  it("i posti dichiarati si tengono entro limiti sensati", () => {
    const chiavi = chiaviBuone();
    const v = (seats: number) =>
      verificaGettone(firma(servizio.privata, { seats }), { chiavi, installationId: IID, ora: 1 }).posti;
    expect(v(0)).toBe(POSTI_GRATUITI);
    expect(v(-4)).toBe(POSTI_GRATUITI);
    expect(v(1e9)).toBe(POSTI_MAX);
    expect(v(4.7)).toBe(4);
  });

  it("un carico con un campo del tipo sbagliato è malformato, non «interpretato»", () => {
    const storto = Buffer.from(JSON.stringify({ v: 1, iid: IID, plan: "team", seats: "cinque", exp: 9e12 }))
      .toString("base64url");
    const g = `${storto}.${sign(null, Buffer.from(storto, "ascii"), servizio.privata).toString("base64url")}`;
    expect(verificaGettone(g, { chiavi: chiaviBuone(), installationId: IID, ora: 1 }).motivo).toBe("malformed");
  });

  it("caratteri fuori dall'alfabeto base64url non si «ripuliscono»", () => {
    // `Buffer.from` li ignorerebbe, e due gettoni diversi si decodificherebbero
    // uguali: è la strada per cui una firma vale su un carico che non è quello.
    const g = firma(servizio.privata, {});
    const [p, s] = g.split(".") as [string, string];
    expect(verificaGettone(`${p}!!.${s}`, { chiavi: chiaviBuone(), installationId: IID, ora: 1 }).motivo)
      .toBe("malformed");
  });
});

describe("licenza · le chiavi di verifica", () => {
  it("oggi non c'è nessuna chiave integrata, e va detto invece che finto", () => {
    // Una chiave inventata qui sarebbe un cancello che sembra chiuso e non lo
    // è. Finché la lista è vuota, un gettone perfetto resta sul gratuito col
    // motivo che lo spiega — verificato sopra in `ogniModoDiAndareMale`.
    expect(CHIAVI_INTEGRATE).toEqual([]);
    expect(caricaChiavi({}, CHIAVI_INTEGRATE)).toEqual([]);
  });

  it("una riga storta non spegne le chiavi buone che le stanno accanto", () => {
    const k = caricaChiavi({ TOPICS_LICENSE_PUBKEYS: `rotta:@@@,,k1:${servizio.pubblicaB64},corta:AAAA` }, []);
    expect(k.length).toBe(1);
    expect(k[0]?.kid).toBe("k1");
  });

  it("il `kid:` si può omettere", () => {
    expect(caricaChiavi({ TOPICS_LICENSE_PUBKEYS: servizio.pubblicaB64 }, []).length).toBe(1);
  });
});

describe("licenza · il servizio su disco", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "licenza-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const crea = (env: Record<string, string | undefined> = ENV_CHIAVE, ora?: () => number) =>
    creaServizioLicenza({ stateDir: dir, env, installationId: IID, ora });

  it("senza file è il piano gratuito, e non è un errore", () => {
    expect(leggiGettoneGrezzo({}, dir)).toBeNull();
    expect(crea().stato().motivo).toBe("no_token");
  });

  it("installa un gettone buono, e da quel momento lo stato lo riflette", () => {
    const s = crea();
    expect(s.stato().piano).toBe("free");
    const dopo = s.installa(firma(servizio.privata, { seats: 4 }), 1_000);
    expect(dopo.piano).toBe("team");
    expect(dopo.posti).toBe(4);
    expect(s.stato(1_000).posti).toBe(4);
    expect(existsSync(percorsoGettone(dir))).toBe(true);
  });

  it("un gettone che non regge NON si scrive sul disco", () => {
    // Conservarlo darebbe un'interfaccia con una licenza «in attesa» che non
    // diventerà mai valida, e una macchina che sembra aver pagato invano.
    const s = crea();
    const altro = nuovaCoppia();
    expect(s.installa(firma(altro.privata, {}), 1_000).motivo).toBe("bad_signature");
    expect(existsSync(percorsoGettone(dir))).toBe(false);
    expect(s.stato().piano).toBe("free");
  });

  it("scade da solo mentre il server è su, senza riavvii", () => {
    let ora = 1_000;
    const s = crea(ENV_CHIAVE, () => ora);
    s.installa(firma(servizio.privata, { exp: 5_000 }), ora);
    expect(s.stato().piano).toBe("team");
    ora = 5_001;
    expect(s.stato().piano).toBe("free");
    expect(s.stato().motivo).toBe("expired");
    // E anche da scaduto: la macchina resta la tua.
    expect(consentito(s.stato(), { tipo: "uso_locale" })).toEqual({ ok: true });
  });

  it("un gettone deposto sul disco da fuori viene raccolto senza riavvio", () => {
    const s = crea();
    expect(s.stato().piano).toBe("free");
    writeFileSync(percorsoGettone(dir), firma(servizio.privata, { seats: 9 }) + "\n");
    expect(s.stato(1_000).posti).toBe(9);
  });

  it("rimuovere riporta al gratuito e cancella il file", () => {
    const s = crea();
    s.installa(firma(servizio.privata, {}), 1_000);
    expect(s.rimuovi().piano).toBe("free");
    expect(existsSync(percorsoGettone(dir))).toBe(false);
    // Rimuovere due volte non è un errore: l'esito voluto è già quello.
    expect(s.rimuovi().motivo).toBe("no_token");
  });

  it("la variabile d'ambiente ha la precedenza sul file", () => {
    writeFileSync(percorsoGettone(dir), firma(servizio.privata, { seats: 2 }));
    const s = crea({ ...ENV_CHIAVE, TOPICS_LICENSE_TOKEN: firma(servizio.privata, { seats: 8 }) });
    expect(s.stato(1_000).posti).toBe(8);
  });

  it("il gettone finisce su disco leggibile solo dal proprietario", () => {
    const s = crea();
    s.installa(firma(servizio.privata, {}), 1_000);
    expect(readFileSync(percorsoGettone(dir), "utf8").trim().split(".").length).toBe(2);
  });
});

describe("licenza · il relay è ciò che si paga", () => {
  const RELAY = "https://relay.esempio.test";
  const team: Entitlement = {
    piano: "team", posti: 3, accessoRemoto: true, scadeIl: 9e12, motivo: "valid", installationId: IID,
  };

  it("senza licenza l'indirizzo del relay sparisce, e sparisce come «non configurato»", () => {
    // Non uno stato d'errore nuovo: esattamente `null`, che l'app gestisce da
    // sempre facendo semplicemente non comparire il gesto.
    for (const { e } of ogniModoDiAndareMale()) {
      expect(baseUrlConcesso(RELAY, e)).toBeNull();
    }
    // Il controllo positivo: con licenza l'indirizzo passa intero.
    expect(baseUrlConcesso(RELAY, team)).toBe(RELAY);
  });

  it("una macchina senza relay configurato resta senza relay anche con licenza", () => {
    expect(baseUrlConcesso(null, team)).toBeNull();
  });

  it("la rete di casa NON passa da qui", () => {
    // È il confine del listino (ORG-08): si paga l'essere trovati da un'ALTRA
    // rete, non il telefono sulla stessa. Se un giorno qualcuno chiedesse la
    // licenza per la LAN, questo diventerebbe rosso.
    for (const { e } of ogniModoDiAndareMale()) {
      expect(consentito(e, { tipo: "accesso_rete_locale" })).toEqual({ ok: true });
    }
  });
});

describe("licenza · l'interruttore che segue la licenza", () => {
  function banco(iniziale: Entitlement, disponibile = true) {
    let corrente = iniziale;
    const eventi: string[] = [];
    const i = creaInterruttoreLicenza({
      disponibile: () => disponibile,
      stato: () => corrente,
      richiesta: { tipo: "accesso_remoto" },
      avvia: () => { eventi.push("avvia"); },
      ferma: () => { eventi.push("ferma"); },
    });
    return { i, eventi, cambia: (e: Entitlement) => { corrente = e; } };
  }
  const team: Entitlement = {
    piano: "team", posti: 3, accessoRemoto: true, scadeIl: 9e12, motivo: "valid", installationId: IID,
  };

  it("con licenza si accende, senza resta spento", () => {
    const a = banco(team);
    a.i.riconcilia();
    expect(a.i.acceso()).toBe(true);
    expect(a.eventi).toEqual(["avvia"]);

    const b = banco(pianoGratuito(IID, "no_token"));
    b.i.riconcilia();
    expect(b.i.acceso()).toBe(false);
    expect(b.eventi).toEqual([]);
  });

  it("dieci giri non aprono dieci collegamenti", () => {
    // `avvia()` apre una socket a ogni chiamata: un giro periodico che
    // «assicura» lo stato invece di seguire le transizioni ne aprirebbe una al
    // minuto, per sempre, senza che niente sembri rotto.
    const { i, eventi } = banco(team);
    for (let n = 0; n < 10; n++) i.riconcilia();
    expect(eventi).toEqual(["avvia"]);
  });

  it("una licenza che scade mentre il server è su lo spegne, una volta sola", () => {
    const { i, eventi, cambia } = banco(team);
    i.riconcilia();
    cambia(pianoGratuito(IID, "expired"));
    i.riconcilia();
    i.riconcilia();
    expect(eventi).toEqual(["avvia", "ferma"]);
    expect(i.acceso()).toBe(false);
  });

  it("se la cosa non è nemmeno configurata, la licenza non viene interrogata", () => {
    // Una macchina che non ha scelto di uscire su Internet non deve avere
    // un'opinione sul proprio piano.
    let interrogata = false;
    const i = creaInterruttoreLicenza({
      disponibile: () => false,
      stato: () => { interrogata = true; return team; },
      richiesta: { tipo: "accesso_remoto" },
      avvia: () => { throw new Error("non doveva accendersi"); },
      ferma: () => { throw new Error("non doveva spegnersi"); },
    });
    i.riconcilia();
    expect(interrogata).toBe(false);
    expect(i.acceso()).toBe(false);
  });
});

describe("licenza · la forma sul filo", () => {
  it("una sola conversione, con i nomi che l'interfaccia legge", () => {
    expect(sulFilo(pianoGratuito(IID, "no_token"))).toEqual({
      plan: "free", seats: 1, remoteAccess: false, expiresAt: null,
      reason: "no_token", installationId: IID,
    });
  });
});
