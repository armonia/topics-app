/**
 * Il protocollo del relay.
 *
 * Il caso che vale più di tutti è uno: **il relay non deve poter leggere quello
 * che inoltra**, e qui lo si verifica invece di prometterlo. Se un giorno
 * qualcuno aggiungesse un campo in chiaro «tanto serve per il log», il test
 * sull'involucro fallisce — che è l'unico modo perché una promessa di
 * riservatezza resti vera nel tempo.
 *
 * @covers RELAY-E2E-04
 */
import { describe, expect, it } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION, leggiMessaggio, involucro, haContenutoOpaco,
  TUBO_BYTE_PER_FRAME, TUBO_DATI_MAX, TUBO_LIMITE_CLOUDFLARE,
  aBase64url, daBase64url, componiStream, creaContatoreStream, creaRiassemblatore,
  dividiBinario, dividiTesto, latoDiStream, leggiFrame, leggiFramePayload, scriviFrame,
  type EsitoTubo, type FrameTubo, type MessaggioRelay,
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

  it("il RUOLO di una sessione è una parola del vocabolario, o non passa", () => {
    // Il ruolo decide la POSTURA di chi riceve: un dispositivo appaiato ha
    // davanti l'installazione intera, un ospite di link una risorsa sola.
    // Sceglierne uno a caso davanti a una parola sconosciuta è il modo in cui
    // si finisce per trattare un estraneo come un dispositivo di casa.
    expect(leggiMessaggio({ t: "guest-joined", sessionId: "s1", ruolo: "device" }))
      .toEqual({ t: "guest-joined", sessionId: "s1", ruolo: "device" });
    expect(leggiMessaggio({ t: "guest-left", sessionId: "s1", ruolo: "guest" }))
      .toEqual({ t: "guest-left", sessionId: "s1", ruolo: "guest" });
    expect(leggiMessaggio({ t: "guest-joined", sessionId: "s1", ruolo: "padrone" })).toBeNull();
    expect(leggiMessaggio({ t: "guest-joined", sessionId: "s1", ruolo: 7 })).toBeNull();
  });

  it("un ruolo ASSENTE si accetta, e vuol dire ospite", () => {
    // Un relay più vecchio non lo manda: pretenderlo vorrebbe dire smettere di
    // parlare con un deploy che non è ancora stato aggiornato.
    expect(leggiMessaggio({ t: "guest-joined", sessionId: "s1" }))
      .toEqual({ t: "guest-joined", sessionId: "s1" });
  });

  it("l'involucro mostra il ruolo, che è instradamento, e mai il contenuto", () => {
    // Il ruolo il relay lo sa perché è nel percorso da cui ci si aggancia:
    // dichiararlo qui è la differenza fra «lo aggiunge lui» e «lo ha dedotto
    // guardando dentro qualcosa».
    expect(involucro({ t: "guest-joined", sessionId: "s1", ruolo: "device" }))
      .toEqual({ t: "guest-joined", sessionId: "s1", ruolo: "device" });
    expect(JSON.stringify(involucro({ t: "to-guest", to: "s1", payload: "SEGRETO" })))
      .not.toContain("SEGRETO");
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

// ───────────────────────────────────────────────────────────────────────────
// IL TUBO
// ───────────────────────────────────────────────────────────────────────────

/** Un capo che riceve, con l'elenco di cosa gli è arrivato. */
function ricevente(opts: Parameters<typeof creaRiassemblatore>[0]) {
  const r = creaRiassemblatore(opts);
  const esiti: EsitoTubo[] = [];
  return {
    r,
    esiti,
    passa(frames: FrameTubo[]) { for (const f of frames) esiti.push(r.ricevi(f)); return esiti.at(-1)!; },
  };
}

const completo = (e: EsitoTubo) => (e.esito === "completo" ? e : null);

describe("tubo · resta DENTRO il payload, dove il relay non guarda", () => {
  it("l'involucro non mostra né lo stream né il contenuto", () => {
    // È il punto dell'intero strato: multiplare senza che chi instrada impari a
    // descrivere il traffico. Se un domani `streamId` finisse accanto a `to`, il
    // relay saprebbe quanti stream ci sono, quali sono grossi e quanto durano.
    const frame = scriviFrame({ f: "open", s: 42, n: 0, k: "req", e: "u", d: "SEGRETISSIMO", fin: true });
    const m: MessaggioRelay = { t: "to-guest", to: "s1", payload: frame };
    const busta = JSON.stringify(involucro(m));

    expect(busta).not.toContain("SEGRETISSIMO");
    expect(busta).not.toContain("42");
    expect(busta).not.toContain("open");
    // Controllo POSITIVO: il canale di osservazione funziona davvero, cioè
    // l'involucro contiene ciò che serve a consegnare. Senza questo, le tre
    // righe sopra passerebbero anche su un involucro vuoto per sbaglio.
    expect(involucro(m)).toEqual({ t: "to-guest", to: "s1" });
    expect(busta).toContain("s1");
  });

  it("il frame è una stringa: per il relay `payload` resta un campo solo", () => {
    // `leggiMessaggio` deve continuare ad accettare la busta esterna senza
    // sapere che dentro c'è una struttura — altrimenti il tubo sarebbe
    // diventato affare del relay.
    const dentro = scriviFrame({ f: "data", s: 3, n: 1, e: "u", d: "x", fin: true });
    expect(leggiMessaggio({ t: "to-host", payload: dentro })).toEqual({ t: "to-host", payload: dentro });
  });
});

describe("tubo · si accetta solo un frame che sta in piedi", () => {
  it("i frame buoni passano", () => {
    const buoni: FrameTubo[] = [
      { f: "open", s: 0, n: 0, k: "req" },
      { f: "open", s: 2, n: 0, k: "req", h: "GET /api/topics", fin: true },
      { f: "open", s: 4, n: 0, k: "ws", e: "u", d: "ciao" },
      { f: "data", s: 4, n: 1, e: "b", d: aBase64url(new Uint8Array([1, 2, 3])) },
      { f: "data", s: 4, n: 2, e: "u", d: "fine", fin: true },
      { f: "reset", s: 4, motivo: "aborted" },
    ];
    for (const b of buoni) {
      expect(`${b.f}/${b.s}→${leggiFrame(JSON.parse(scriviFrame(b))) !== null}`).toBe(`${b.f}/${b.s}→true`);
    }
  });

  it("un `open` non è al posto di un `data`, e viceversa", () => {
    // Il numero di sequenza non è decorativo: `open` è sempre lo zero, e un
    // `data` con lo zero vorrebbe dire due frame che si contendono l'inizio.
    expect(leggiFrame({ f: "open", s: 0, n: 1, k: "req" })).toBeNull();
    expect(leggiFrame({ f: "data", s: 0, n: 0, e: "u", d: "x" })).toBeNull();
  });

  it("dati senza codifica, o codifica senza dati, non passano", () => {
    // Byte di cui non si sa cosa siano da una parte, una promessa vuota
    // dall'altra.
    expect(leggiFrame({ f: "open", s: 0, n: 0, k: "req", d: "x" })).toBeNull();
    expect(leggiFrame({ f: "open", s: 0, n: 0, k: "req", e: "u" })).toBeNull();
    expect(leggiFrame({ f: "data", s: 0, n: 1, d: "x" })).toBeNull();
    expect(leggiFrame({ f: "open", s: 0, n: 0, k: "req", e: "z", d: "x" })).toBeNull();
  });

  it("un frame più grosso del tetto non si alloca nemmeno", () => {
    // Il tetto sta PRIMA della memoria: un capo ostile che manda 32 MiB in un
    // colpo va fermato mentre è ancora una stringa da rifiutare.
    const troppo = "a".repeat(TUBO_DATI_MAX + 1);
    expect(leggiFrame({ f: "data", s: 0, n: 1, e: "u", d: troppo })).toBeNull();
    // Controllo positivo: esattamente al tetto passa, quindi il rifiuto sopra
    // è dovuto alla misura e non a qualcos'altro.
    expect(leggiFrame({ f: "data", s: 0, n: 1, e: "u", d: "a".repeat(TUBO_DATI_MAX) })).not.toBeNull();
  });

  it("un identificatore che non è un numero intero non passa", () => {
    for (const s of ["1", -1, 1.5, null, undefined, NaN]) {
      expect(`${String(s)}→${leggiFrame({ f: "open", s, n: 0, k: "req" })}`).toBe(`${String(s)}→null`);
    }
  });

  it("un motivo di chiusura inventato non passa", () => {
    expect(leggiFrame({ f: "reset", s: 0, motivo: "boh" })).toBeNull();
    expect(leggiFrame({ f: "reset", s: 0, motivo: "overflow" })).not.toBeNull();
  });

  it("un tipo sconosciuto, o ciò che non è un oggetto, non passa", () => {
    expect(leggiFrame({ f: "esegui", s: 0, k: "x" })).toBeNull();
    for (const v of [null, undefined, "stringa", 42, []]) {
      expect(`${typeof v}→${leggiFrame(v)}`).toBe(`${typeof v}→null`);
    }
  });

  it("un payload che non è JSON non diventa un'eccezione", () => {
    // Succede: una busta troncata, un capo che parla un'altra versione. Deve
    // valere `null`, non un `throw` in mezzo a un `onmessage`.
    expect(leggiFramePayload("{non json")).toBeNull();
    expect(leggiFramePayload(scriviFrame({ f: "open", s: 0, n: 0, k: "req", fin: true }))).not.toBeNull();
  });
});

describe("tubo · le misure sono scelte, non capitate", () => {
  it("un frame pieno codificato sta largamente sotto il tetto di Cloudflare", () => {
    // 32 MiB è il taglio del singolo messaggio ricevuto da un Durable Object.
    // Un capo che lo supera non lo scopre dai suoi test: lo scopre un utente.
    const pieno = aBase64url(new Uint8Array(TUBO_BYTE_PER_FRAME));
    expect(pieno.length).toBeLessThanOrEqual(TUBO_DATI_MAX);
    expect(TUBO_DATI_MAX * 8).toBeLessThan(TUBO_LIMITE_CLOUDFLARE);
    // E il +33% della base64 è misurato, non ricordato a memoria.
    expect(pieno.length).toBe(Math.ceil((TUBO_BYTE_PER_FRAME * 4) / 3));
  });

  it("base64url va e torna byte per byte", () => {
    const b = new Uint8Array(777);
    for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
    expect(Array.from(daBase64url(aBase64url(b))!)).toEqual(Array.from(b));
    // Anche le code che non sono multiple di 3, dove il riempimento cambia.
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const p = b.subarray(0, n);
      expect(`${n}→${daBase64url(aBase64url(p))!.length}`).toBe(`${n}→${n}`);
    }
  });

  it("una stringa che non è base64url dà `null`, non byte inventati", () => {
    expect(daBase64url("non+valido/")).toBeNull(); // `+` e `/` sono l'altra base64
    expect(daBase64url("AAAAAA")).not.toBeNull();  // 6 caratteri: lecito
    // Una lunghezza ≡1 (mod 4) non può uscire da nessuna codifica: sei bit
    // avanzati da soli non sono mai stati un byte.
    expect(daBase64url("A")).toBeNull();
    expect(daBase64url("AAAAA")).toBeNull();
  });
});

describe("tubo · spezzare non deve rovinare il contenuto", () => {
  it("il testo si taglia sui confini dei caratteri, non dei byte", () => {
    // Tagliare in mezzo a una sequenza UTF-8 non dà un errore: dà un carattere
    // sbagliato in mezzo al testo, che si scopre mesi dopo su una lingua che
    // nessuno aveva provato.
    const testo = "àèìòù 日本語 🙂".repeat(40);
    const pezzi = dividiTesto(testo, 7);
    expect(pezzi.length).toBeGreaterThan(10);
    expect(pezzi.join("")).toBe(testo);
    // Nessun pezzo contiene il carattere di sostituzione: se il taglio fosse
    // sui byte, questo sarebbe pieno di U+FFFD.
    expect(pezzi.some((p) => p.includes("�"))).toBe(false);
    // E ogni pezzo rispetta davvero il tetto di byte.
    const enc = new TextEncoder();
    expect(pezzi.every((p) => enc.encode(p).length <= 7)).toBe(true);
  });

  it("il testo corto resta un pezzo solo, e quello vuoto nessuno", () => {
    expect(dividiTesto("breve")).toEqual(["breve"]);
    expect(dividiTesto("")).toEqual([]);
  });

  it("un carattere che in `max` non ci sta si sfora, non si spacca", () => {
    // `max` è un parametro pubblico — sta su `componiStream` e su `CapoTuboOpts`,
    // e i test stessi lo abbassano. Quando è più piccolo di UN carattere non c'è
    // nessun taglio lecito: emettere i byte a metà darebbe U+FFFD, cioè
    // esattamente il guasto che questo taglio esiste per evitare. Si sfora di al
    // più tre byte, e il testo torna indietro identico.
    const enc = new TextEncoder();
    for (const c of ["à", "日", "🙂"]) {          // 2, 3, 4 byte
      const largo = enc.encode(c).length;
      for (const max of [1, 2, 3, 4]) {
        const testo = c.repeat(3);
        const pezzi = dividiTesto(testo, max);
        const eti = `${c}/${max}`;
        expect(`${eti}→${pezzi.join("")}`).toBe(`${eti}→${testo}`);
        expect(`${eti}→${pezzi.some((p) => p.includes("�"))}`).toBe(`${eti}→false`);
        // Lo sforo è limitato al carattere: mai un pezzo più largo di così.
        const tetto = Math.max(max, largo);
        expect(`${eti}→${pezzi.every((p) => enc.encode(p).length <= tetto)}`).toBe(`${eti}→true`);
      }
    }
  });

  it("i casi esatti che si spaccavano", () => {
    expect(dividiTesto("🙂", 3)).toEqual(["🙂"]);
    expect(dividiTesto("🙂🙂", 2)).toEqual(["🙂", "🙂"]);
    // Controllo positivo: da 4 byte in su il taglio è quello normale e non
    // sfora mai, quindi sopra si sta misurando la soglia giusta.
    const enc = new TextEncoder();
    const pezzi = dividiTesto("🙂🙂🙂", 4);
    expect(pezzi).toEqual(["🙂", "🙂", "🙂"]);
    expect(pezzi.every((p) => enc.encode(p).length <= 4)).toBe(true);
  });

  it("una misura assurda non manda in giro a vuoto chi spezza", () => {
    // `max: 0` avanzerebbe di zero byte per giro: un ciclo che non finisce mai
    // è peggio di un errore, perché non si vede.
    expect(dividiTesto("abc", 0).join("")).toBe("abc");
    const b = new Uint8Array([1, 2, 3]);
    const pezzi = dividiBinario(b, 0);
    const rimesso: number[] = [];
    for (const p of pezzi) rimesso.push(...daBase64url(p)!);
    expect(rimesso).toEqual([1, 2, 3]);
  });

  it("i byte si spezzano e si rimettono insieme identici", () => {
    const b = new Uint8Array(1000);
    for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
    const pezzi = dividiBinario(b, 96);
    expect(pezzi.length).toBe(Math.ceil(1000 / 96));
    const rimesso: number[] = [];
    for (const p of pezzi) rimesso.push(...daBase64url(p)!);
    expect(rimesso).toEqual(Array.from(b));
  });
});

describe("tubo · comporre uno stream", () => {
  it("una cosa piccola è UN frame solo", () => {
    // Su un Durable Object che si paga a messaggio, due frame dove ne basta uno
    // non è un dettaglio estetico.
    const f = componiStream({ s: 0, k: "req", h: "GET /api/topics", dati: "{}" });
    expect(f).toEqual([{ f: "open", s: 0, n: 0, k: "req", h: "GET /api/topics", e: "u", d: "{}", fin: true }]);
  });

  it("una cosa grossa è una fila numerata, con il `fin` solo in fondo", () => {
    const f = componiStream({ s: 2, k: "req", dati: "x".repeat(250), max: 100 });
    expect(f.map((x) => x.f)).toEqual(["open", "data", "data"]);
    expect(f.map((x) => ("n" in x ? x.n : -1))).toEqual([0, 1, 2]);
    expect(f.filter((x) => "fin" in x && x.fin === true).length).toBe(1);
    expect(f.at(-1)).toMatchObject({ fin: true, n: 2 });
  });

  it("uno stream senza dati esiste: è chi apre per RICEVERE", () => {
    expect(componiStream({ s: 0, k: "ws" })).toEqual([{ f: "open", s: 0, n: 0, k: "ws", fin: true }]);
  });

  it("i due capi non possono scegliere lo stesso numero", () => {
    // Pari la macchina, dispari l'ospite. Senza questo, due capi che aprono
    // nello stesso istante si sovrascrivono lo stream a vicenda.
    const h = creaContatoreStream("host");
    const g = creaContatoreStream("guest");
    expect([h(), h(), h()]).toEqual([0, 2, 4]);
    expect([g(), g(), g()]).toEqual([1, 3, 5]);
    expect(latoDiStream(4)).toBe("host");
    expect(latoDiStream(5)).toBe("guest");
  });
});

describe("tubo · rimettere insieme", () => {
  it("il testo torna esattamente com'era, anche spezzato in venti frame", () => {
    const testo = "riga うたた ✂".repeat(300);
    const r = ricevente({ latoRemoto: "guest" });
    const fine = r.passa(componiStream({ s: 1, k: "req", h: "POST /x", dati: testo, max: 64 }));
    expect(completo(fine)).toMatchObject({ esito: "completo", s: 1, k: "req", h: "POST /x", e: "u", dati: testo });
    // I frame di mezzo dicono «parziale» e non completano nulla: se lo dicessero,
    // il destinatario servirebbe mezza richiesta.
    expect(r.esiti.filter((e) => e.esito === "completo").length).toBe(1);
    expect(r.esiti.filter((e) => e.esito === "parziale").length).toBeGreaterThan(5);
    expect(r.r.apertiOra()).toBe(0);
  });

  it("i byte tornano identici", () => {
    const b = new Uint8Array(5000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7) & 0xff;
    const r = ricevente({ latoRemoto: "guest" });
    const fine = r.passa(componiStream({ s: 1, k: "blob", dati: b, max: 300 }));
    const c = completo(fine);
    expect(c?.e).toBe("b");
    expect(Array.from(c?.e === "b" ? c.dati : new Uint8Array())).toEqual(Array.from(b));
  });

  it("DUE stream intrecciati non si mescolano — è tutto il motivo per cui esiste", () => {
    // Con una sola corsia, la richiesta lunga bloccherebbe la corta e la
    // risposta che torna non si saprebbe a chi appartiene.
    const r = ricevente({ latoRemoto: "guest" });
    const a = componiStream({ s: 1, k: "req", h: "A", dati: "AAAA".repeat(20), max: 16 });
    const b = componiStream({ s: 3, k: "req", h: "B", dati: "BBBB".repeat(20), max: 16 });

    const esiti: EsitoTubo[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) esiti.push(r.r.ricevi(a[i]!));
      if (b[i]) esiti.push(r.r.ricevi(b[i]!));
    }
    const finiti = esiti.filter((e) => e.esito === "completo");
    expect(finiti.length).toBe(2);
    expect(finiti.map((e) => (e.esito === "completo" ? `${e.h}:${e.dati}` : ""))).toEqual([
      `A:${"AAAA".repeat(20)}`, `B:${"BBBB".repeat(20)}`,
    ]);
    expect(esiti.some((e) => e.esito === "errore")).toBe(false);
  });

  it("un buco nella sequenza non si tira a indovinare", () => {
    // Un numero saltato vuol dire che qualcosa si è perso o è stato infilato.
    // In nessuno dei due casi si prova lo stesso.
    const r = ricevente({ latoRemoto: "guest" });
    const f = componiStream({ s: 1, k: "req", dati: "x".repeat(300), max: 100 });
    r.r.ricevi(f[0]!);
    expect(r.r.ricevi(f[2]!)).toEqual({ esito: "errore", s: 1, motivo: "bad-frame" });
    // Controllo positivo: la stessa fila SENZA il buco arriva in fondo.
    const r2 = ricevente({ latoRemoto: "guest" });
    expect(r2.passa(f).esito).toBe("completo");
  });

  it("dati per uno stream che non è aperto non hanno dove attaccarsi", () => {
    const r = ricevente({ latoRemoto: "guest" });
    expect(r.r.ricevi({ f: "data", s: 9, n: 1, e: "u", d: "x" })).toEqual({
      esito: "errore", s: 9, motivo: "bad-frame",
    });
  });

  it("un numero di stream della parità sbagliata si rifiuta", () => {
    // È il modo in cui un capo si prende i numeri dell'altro, e da lì nascono
    // due stream con lo stesso identificatore.
    const r = ricevente({ latoRemoto: "guest" });
    expect(r.r.ricevi({ f: "open", s: 2, n: 0, k: "req", fin: true })).toMatchObject({ esito: "errore" });
    expect(r.r.ricevi({ f: "open", s: 3, n: 0, k: "req", fin: true })).toMatchObject({ esito: "completo" });
  });

  it("un identificatore già usato non si riapre", () => {
    // Riusarne uno vuol dire poter scrivere dentro lo stream di prima.
    const r = ricevente({ latoRemoto: "guest" });
    expect(r.r.ricevi({ f: "open", s: 5, n: 0, k: "req", fin: true }).esito).toBe("completo");
    expect(r.r.ricevi({ f: "open", s: 5, n: 0, k: "req", fin: true })).toMatchObject({ esito: "errore" });
    expect(r.r.ricevi({ f: "open", s: 3, n: 0, k: "req", fin: true })).toMatchObject({ esito: "errore" });
    // Controllo positivo: uno più alto sì.
    expect(r.r.ricevi({ f: "open", s: 7, n: 0, k: "req", fin: true }).esito).toBe("completo");
  });

  it("uno stream non può crescere per sempre", () => {
    // Il tubo non sa quanto è grande ciò che trasporta finché non finisce, e
    // «finché non finisce» non può voler dire «per sempre».
    const r = ricevente({ latoRemoto: "guest", maxByteStream: 250 });
    const f = componiStream({ s: 1, k: "req", dati: "x".repeat(1000), max: 100 });
    const esiti = f.map((x) => r.r.ricevi(x));
    expect(esiti.some((e) => e.esito === "errore" && e.motivo === "overflow")).toBe(true);
    expect(esiti.some((e) => e.esito === "completo")).toBe(false);
    // Controllo positivo: sotto il tetto lo stesso stream arriva in fondo.
    const r2 = ricevente({ latoRemoto: "guest", maxByteStream: 250 });
    expect(r2.passa(componiStream({ s: 1, k: "req", dati: "x".repeat(200), max: 100 })).esito).toBe("completo");
  });

  it("non si aprono stream all'infinito", () => {
    const r = ricevente({ latoRemoto: "guest", maxStream: 2 });
    for (const s of [1, 3]) expect(r.r.ricevi({ f: "open", s, n: 0, k: "req" }).esito).toBe("aperto");
    expect(r.r.ricevi({ f: "open", s: 5, n: 0, k: "req" })).toEqual({
      esito: "errore", s: 5, motivo: "too-many-streams",
    });
    expect(r.r.apertiOra()).toBe(2);
  });

  it("uno stream non cambia codifica a metà", () => {
    // Mescolare testo e byte vorrebbe dire non sapere cosa si sta rimettendo
    // insieme.
    const r = ricevente({ latoRemoto: "guest" });
    r.r.ricevi({ f: "open", s: 1, n: 0, k: "req", e: "u", d: "testo" });
    expect(r.r.ricevi({ f: "data", s: 1, n: 1, e: "b", d: "AAAA", fin: true })).toMatchObject({
      esito: "errore", motivo: "bad-frame",
    });
  });

  it("un `reset` chiude, e non è un errore", () => {
    const r = ricevente({ latoRemoto: "guest" });
    r.r.ricevi({ f: "open", s: 1, n: 0, k: "req" });
    expect(r.r.ricevi({ f: "reset", s: 1, motivo: "aborted" })).toEqual({
      esito: "chiuso", s: 1, motivo: "aborted",
    });
    expect(r.r.apertiOra()).toBe(0);
    // Vale anche su uno che qui non esiste: i due capi possono mollare nello
    // stesso istante, e nessuno dei due ha sbagliato.
    expect(r.r.ricevi({ f: "reset", s: 99, motivo: "aborted" }).esito).toBe("chiuso");
  });

  it("un `reset` sulla PROPRIA corsia non chiude in faccia all'altra", () => {
    // Il caso normale «chi riceve rinuncia»: l'ospite chiude la scheda mentre la
    // macchina gli sta mandando una risposta lunga, e manda un `reset` su uno
    // stream PARI — aperto dalla macchina, non suo. Pari e dispari condividono
    // lo stesso spazio numerico: se quel reset spostasse il segnaposto dei numeri
    // già visti, ogni `open` remoto più basso morirebbe con `bad-frame`. Sarebbe
    // l'esatto contrario della promessa del tubo, dove un rifiuto muore su UNO
    // stream solo.
    const r = ricevente({ latoRemoto: "guest" });
    expect(r.r.ricevi({ f: "reset", s: 18, motivo: "aborted" })).toEqual({
      esito: "chiuso", s: 18, motivo: "aborted",
    });
    // La PRIMA richiesta dell'ospite, e tutte quelle sotto il 18, devono ancora
    // poter arrivare.
    for (const s of [1, 3, 5]) {
      expect(`${s}→${r.r.ricevi({ f: "open", s, n: 0, k: "req", fin: true }).esito}`).toBe(`${s}→completo`);
    }
  });

  it("un `reset` sulla corsia REMOTA continua a bruciare quel numero", () => {
    // L'altra metà della stessa regola: sulla corsia di chi manda, un numero
    // chiuso resta chiuso, o riaprirlo vorrebbe dire scrivere dentro lo stream
    // di prima.
    const r = ricevente({ latoRemoto: "guest" });
    expect(r.r.ricevi({ f: "reset", s: 7, motivo: "aborted" }).esito).toBe("chiuso");
    expect(r.r.ricevi({ f: "open", s: 7, n: 0, k: "req", fin: true })).toMatchObject({ esito: "errore" });
    expect(r.r.ricevi({ f: "open", s: 5, n: 0, k: "req", fin: true })).toMatchObject({ esito: "errore" });
    // Controllo positivo: uno più alto sì.
    expect(r.r.ricevi({ f: "open", s: 9, n: 0, k: "req", fin: true }).esito).toBe("completo");
  });

  it("dimenticare uno stream ne libera il pendente, e lo rende inesistente", () => {
    // Serve a chi si accorge che la cosa dall'altra parte non arriverà mai:
    // tenerla in memoria non la fa arrivare.
    const r = ricevente({ latoRemoto: "guest" });
    r.r.ricevi({ f: "open", s: 1, n: 0, k: "req", e: "u", d: "meta" });
    expect(r.r.apertiOra()).toBe(1);
    r.r.dimentica(1);
    expect(r.r.apertiOra()).toBe(0);
    // E il seguito non si riattacca a un buffer che non c'è più.
    expect(r.r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "!", fin: true })).toMatchObject({
      esito: "errore", motivo: "bad-frame",
    });
  });

  it("un errore su uno stream non fa cadere gli altri", () => {
    // È la promessa che rende utile il multiplexing: trenta richieste in volo,
    // una storta, ventinove che continuano.
    const r = ricevente({ latoRemoto: "guest" });
    r.r.ricevi({ f: "open", s: 1, n: 0, k: "req", e: "u", d: "primo" });
    r.r.ricevi({ f: "open", s: 3, n: 0, k: "req", e: "u", d: "secondo" });
    expect(r.r.ricevi({ f: "data", s: 1, n: 9, e: "u", d: "buco" })).toMatchObject({ esito: "errore" });
    expect(r.r.ricevi({ f: "data", s: 3, n: 1, e: "u", d: "!", fin: true })).toMatchObject({
      esito: "completo", dati: "secondo!",
    });
  });
});
