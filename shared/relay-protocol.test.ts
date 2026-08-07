/**
 * Il protocollo del relay.
 *
 * Il caso che vale più di tutti è uno: **il relay non deve poter leggere quello
 * che inoltra**, e qui lo si verifica invece di prometterlo. Se un giorno
 * qualcuno aggiungesse un campo in chiaro «tanto serve per il log», il test
 * sull'involucro fallisce — che è l'unico modo perché una promessa di
 * riservatezza resti vera nel tempo.
 */
import { describe, expect, it } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION, leggiMessaggio, involucro, haContenutoOpaco,
  type MessaggioRelay,
} from "./relay-protocol";

const V = RELAY_PROTOCOL_VERSION;

describe("relay · il relay non capisce quello che inoltra", () => {
  it("l'involucro non contiene il contenuto", () => {
    const m: MessaggioRelay = { t: "to-guest", to: "s1", payload: "SEGRETISSIMO" };
    const busta = involucro(m);
    expect(JSON.stringify(busta)).not.toContain("SEGRETISSIMO");
    // E contiene ciò che serve a consegnarla, o non si potrebbe instradare.
    expect(busta).toEqual({ t: "to-guest", to: "s1" });
  });

  it("vale in tutte e due le direzioni", () => {
    const m: MessaggioRelay = { t: "to-host", payload: "ALTRETTANTO SEGRETO" };
    expect(JSON.stringify(involucro(m))).not.toContain("SEGRETO");
  });

  it("le buste opache si riconoscono come tali", () => {
    expect(haContenutoOpaco({ t: "to-guest", to: "s", payload: "x" })).toBe(true);
    expect(haContenutoOpaco({ t: "to-host", payload: "x" })).toBe(true);
    expect(haContenutoOpaco({ t: "guest-left", sessionId: "s" })).toBe(false);
  });

  it("il segreto del link NON viaggia nel protocollo", () => {
    // La chiave sta nel FRAMMENTO dell'URL, che il browser non manda al server.
    // `shareRef` serve a instradare e a far scadere; non apre niente.
    const m: MessaggioRelay = { t: "guest-open", v: V, installationId: "i1", shareRef: "r1" };
    expect(Object.keys(m)).not.toContain("key");
    expect(Object.keys(m)).not.toContain("secret");
  });
});

describe("relay · si accetta solo ciò che si capisce davvero", () => {
  it("i messaggi buoni passano", () => {
    const buoni: MessaggioRelay[] = [
      { t: "hello", v: V, installationId: "i1", token: "tok" },
      { t: "guest-open", v: V, installationId: "i1", shareRef: "r1" },
      { t: "to-guest", to: "s1", payload: "x" },
      { t: "to-host", payload: "x" },
      { t: "ready", v: V },
      { t: "ready", v: V, sessionId: "s1" },
      { t: "guest-joined", sessionId: "s1" },
      { t: "guest-left", sessionId: "s1" },
      { t: "denied", motivo: "host-offline" },
    ];
    for (const b of buoni) {
      expect(`${b.t}→${leggiMessaggio(JSON.parse(JSON.stringify(b))) !== null}`).toBe(`${b.t}→true`);
    }
  });

  it("una versione diversa NON si arrangia: si chiude", () => {
    // Due capi che si arrangiano sono il modo in cui un formato smette di avere
    // una definizione.
    expect(leggiMessaggio({ t: "hello", v: V + 1, installationId: "i", token: "t" })).toBeNull();
    expect(leggiMessaggio({ t: "guest-open", v: 0, installationId: "i", shareRef: "r" })).toBeNull();
  });

  it("un campo mancante non passa per «quasi giusto»", () => {
    expect(leggiMessaggio({ t: "hello", v: V, installationId: "i1" })).toBeNull();
    expect(leggiMessaggio({ t: "to-guest", payload: "x" })).toBeNull();
    expect(leggiMessaggio({ t: "guest-joined" })).toBeNull();
  });

  it("una stringa vuota non è un identificatore", () => {
    expect(leggiMessaggio({ t: "hello", v: V, installationId: "", token: "t" })).toBeNull();
    expect(leggiMessaggio({ t: "to-guest", to: "", payload: "x" })).toBeNull();
  });

  it("un motivo di rifiuto inventato non passa", () => {
    // Il motivo è una parola del vocabolario, non una frase: chi la legge deve
    // poterci decidere sopra.
    expect(leggiMessaggio({ t: "denied", motivo: "boh" })).toBeNull();
    expect(leggiMessaggio({ t: "denied", motivo: "expired" })).not.toBeNull();
  });

  it("un tipo sconosciuto non passa", () => {
    expect(leggiMessaggio({ t: "esegui-questo", payload: "rm -rf /" })).toBeNull();
  });

  it("ciò che non è nemmeno un oggetto non passa", () => {
    for (const v of [null, undefined, "stringa", 42, []]) {
      expect(`${typeof v}→${leggiMessaggio(v)}`).toBe(`${typeof v}→null`);
    }
  });

  it("un payload che non è una stringa non passa", () => {
    // Un oggetto qui vorrebbe dire che qualcuno ha messo dati strutturati in
    // chiaro dove deve esserci contenuto cifrato.
    expect(leggiMessaggio({ t: "to-host", payload: { a: 1 } })).toBeNull();
  });
});

describe("relay · la macchina spenta ha un nome suo", () => {
  it("`host-offline` è un motivo, non un errore generico", () => {
    // Perché all'ospite va detto proprio quello, invece di una pagina vuota che
    // si legge come «non ti hanno condiviso niente».
    const m = leggiMessaggio({ t: "denied", motivo: "host-offline" });
    expect(m).toEqual({ t: "denied", motivo: "host-offline" });
  });
});
