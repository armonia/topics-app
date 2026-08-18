/**
 * Un'installazione e le sue sessioni, dentro un Durable Object.
 *
 * ── UNA SESSIONE È UN CANALE, NON UN LINK ───────────────────────────────────
 * Ogni capo che si aggancia riceve un identificatore, e su quello si consegna:
 * l'installazione può averne addosso molte insieme — ospiti di link e
 * dispositivi appaiati da un'altra rete — e nessuna aspetta le altre. Il RUOLO
 * di ognuna nasce dal percorso da cui si è entrati (`worker.ts`) e viaggia
 * nell'involucro: è la sola cosa che il relay aggiunge di suo, perché è la sola
 * che sa senza guardare dentro niente.
 *
 * ── QUESTO FILE SI ESEGUE ───────────────────────────────────────────────────
 * `relay-do.run.test.ts` istanzia questa classe e la guida come la guida il
 * runtime — `fetch()` e poi i metodi — con un contorno finto (coppia di socket,
 * tag, storage). Serve perché `relay-contract.test.ts` legge questo file come
 * una STRINGA: presidia i due difetti che non hanno sintomi, ma approverebbe
 * anche un instradamento sbagliato scritto con le parole giuste.
 *
 * ── L'IBERNAZIONE È UN REQUISITO, NON UN'OTTIMIZZAZIONE (RELAY-02) ──────────
 * Si usa `state.acceptWebSocket()` e MAI `ws.accept()`. La differenza non è di
 * stile: con `accept()` l'oggetto resta vivo in memoria per tutto il tempo in
 * cui la socket è aperta, e si paga la durata anche mentre nessuno parla.
 * L'esempio ufficiale di Cloudflare misura lo stesso identico carico nei due
 * modi: **$416/mese contro $10**. Quaranta volte, appese a quale funzione si
 * chiama.
 *
 * La conseguenza è che i gestori sono metodi dell'oggetto (`webSocketMessage`,
 * `webSocketClose`) e non `addEventListener`: fra un messaggio e l'altro
 * l'istanza può essere sfrattata dalla memoria, quindi **non si può tenere
 * niente in un campo**. Chi è ogni socket si ricava dai TAG che le si sono
 * attaccati all'accettazione, che sopravvivono all'ibernazione.
 *
 * L'unico campo che c'è — il capo ospite del PONTE — non è un'eccezione a
 * questa regola: non ci si ricorda niente sopra. Vive quanto una `fetch()` in
 * volo, che è proprio ciò che impedisce lo sfratto, e ciò che lo sfratto
 * porterebbe via lo si rifà da zero dichiarandolo. Il perché sta sul campo.
 *
 * ── IL RELAY NON CAPISCE (RELAY-03) ─────────────────────────────────────────
 * `payload` è opaco: si guarda solo l'involucro per sapere dove consegnare. La
 * chiave sta nel frammento dell'URL, che il browser non manda mai al server —
 * quindi non passa nemmeno di qui.
 */
import {
  leggiMessaggio, RELAY_PROTOCOL_VERSION,
  type MessaggioRelay, type Rifiutato, type RuoloSessione,
} from "../../shared/relay-protocol";
import {
  creaPonte, macchinaSpenta, PERCORSO_PONTE, SID_PONTE, upgradeRifiutato,
  WS_PONTE_GIU, WS_PONTE_RIPARTITO, type SocketPonte,
} from "./ponte";

/** I tag identificano una socket DOPO l'ibernazione: sono l'unico stato che
 *  sopravvive allo sfratto dalla memoria. */
const TAG_MACCHINA = "host";

/**
 * Il tag dei socket del PONTE, e quello che porta il loro nome.
 *
 * Due tag e non uno, per la stessa ragione delle sessioni: `p` dice CHE COSA è
 * questa socket — e serve a riconoscerla prima di leggerne il contenuto,
 * perché ciò che ci passa sopra è traffico dell'applicazione e non il
 * protocollo del relay — mentre `w:…` è il suo NOME dentro il tubo. Tenerli
 * separati vuol dire che spazzare via gli orfani non richiede di sapere come
 * si chiamano.
 *
 * ── IL NOME PORTA ANCHE LA GENERAZIONE, E NON È UN ORNAMENTO ────────────────
 * Il numero di stream da solo NON identifica un filo: la numerazione riparte da
 * capo a ogni ponte nuovo (`creaContatoreStream("guest")` comincia sempre da 1),
 * quindi dopo uno sfratto il PRIMO socket dell'istanza nuova prende esattamente
 * il numero che l'orfano dell'istanza vecchia si porta addosso. Se il runtime
 * consegna la chiusura dell'orfano dopo — e lo fa, perché la chiusura arriva
 * quando arriva — quel numero indicherebbe un filo VIVO, e lo taglierebbe.
 *
 * Basta un giro senza richieste in mezzo perché i due numeri coincidano: un
 * upgrade fa nascere il ponte nuovo senza consumare nessuno stream prima. La
 * generazione è ciò che rende quel nome irripetibile.
 */
const TAG_PONTE = "p";
const tagFilo = (gen: string, s: number) => `w:${gen}:${s}`;

/** Una generazione del ponte: irripetibile, e senza `:` così il nome del filo
 *  resta leggibile in due pezzi. */
const nuovaGenerazione = () => crypto.randomUUID().replace(/-/g, "");

/** Il nome del socket, riletto dai tag. `null` = non ne ha uno, e allora non
 *  c'è niente a cui consegnare. Si legge STRETTO anche se lo scrive il relay:
 *  un `Number()` accetta `""` come zero e `1e3` come mille, e un nome che
 *  cambia forma è un nome che un giorno indica un altro filo. */
function filoDelTag(tags: string[]): { gen: string; filo: number } | null {
  const t = tags.find((x) => x.startsWith("w:"));
  if (t === undefined) return null;
  const pezzi = /^w:([0-9a-f]{8,64}):([0-9]+)$/.exec(t);
  if (!pezzi) return null;
  const n = Number(pezzi[2]);
  return Number.isSafeInteger(n) ? { gen: pezzi[1]!, filo: n } : null;
}

/**
 * Due tag per ogni sessione, e non uno solo con dentro tutto.
 *
 * `s:<id>` è l'INDIRIZZO: è su questo che si consegna, ed è l'unica chiave che
 * serve per instradare. `r:<ruolo>` è la porta da cui si è entrati. Tenerli
 * separati vuol dire che consegnare non richiede di sapere che tipo di sessione
 * sia — se fossero un tag solo (`guest:<id>`), aggiungere una seconda porta
 * costringerebbe ogni consegna a provare tutte le forme, e la forma dimenticata
 * sarebbe una sessione a cui non arriva più niente.
 */
const tagSessione = (sid: string) => `s:${sid}`;
const tagRuolo = (r: RuoloSessione) => `r:${r}`;

/**
 * Lo stato del Durable Object, ridotto a ciò che il relay usa DAVVERO.
 *
 * C'era anche `storage`, e non lo leggeva nessuno: il relay non persiste
 * niente, per la stessa ragione per cui non tiene campi (l'ibernazione, sopra).
 * Un membro che nessuno chiama è una forma che nessun test controlla — e qui
 * lo sarebbe stata due volte, perché il tipo `DurableObjectStorage` è
 * dichiarato a mano in `../workers-runtime.d.ts`, dove entra solo ciò che ha un
 * chiamante.
 */
interface Stato {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

export class SessioneRelay {
  constructor(private state: Stato) {}

  /**
   * Il capo ospite del PONTE, uno per istanza.
   *
   * ── UN CAMPO, QUI, CON L'IBERNAZIONE DI MEZZO: PERCHÉ REGGE ───────────────
   * La regola è che fra un messaggio e l'altro l'istanza può essere sfrattata,
   * quindi un campo non si può usare come memoria. Qui non lo è. Ogni richiesta
   * tradotta vive dentro una `fetch()` ancora in volo, e un oggetto con una
   * richiesta in volo non viene sfrattato: chi ha chiesto e chi risponde stanno
   * sempre nella stessa istanza, per costruzione.
   *
   * Ciò che lo sfratto porta via è solo la NUMERAZIONE degli stream, che
   * ripartirebbe da capo mentre la macchina si ricorda fin dove era arrivata —
   * e un numero già visto lei lo rifiuta, per sempre. Per questo la sessione
   * del ponte si annuncia CHIUSA appena la si crea: la macchina butta quella
   * vecchia, e l'istanza nuova riparte pulita invece di parlare a un
   * interlocutore che la contraddice.
   *
   * ── E I SOCKET, CHE INVECE DURANO ORE? ────────────────────────────────────
   * Quelli SOPRAVVIVONO allo sfratto — li tiene il runtime, non l'oggetto — ma
   * il loro capo dentro il tubo no. Un socket rimasto da un'istanza precedente
   * è perciò un filo che non arriva più da nessuna parte: si chiude dicendolo
   * (`WS_PONTE_RIPARTITO`), e chi sta di là riapre. Il suo NOME sta in un tag,
   * che è l'unica memoria che lo sfratto non porta via, e serve proprio a
   * riconoscerlo per chiuderlo.
   *
   * La GENERAZIONE sta qui accanto al ponte e non da un'altra parte: è il suo
   * nome, nasce e muore con lui, e due campi che vanno tenuti d'accordo sono
   * due campi che un giorno non lo sono.
   */
  private ponte: { capo: ReturnType<typeof creaPonte>; gen: string } | null = null;

  /** La macchina, o `null` se non è collegata. */
  private macchina(): WebSocket | undefined {
    return this.state.getWebSockets(TAG_MACCHINA)[0];
  }

  /**
   * Il congedo della sessione del ponte, detto alla macchina.
   *
   * È una frase sola e sta in un posto solo perché ha DUE mittenti — l'istanza
   * nuova che ricomincia, e ogni socket orfano che si chiude — e due copie
   * della stessa frase sono due cose che un giorno dicono nomi diversi. Di là
   * questo congedo chiude TUTTO ciò che era appeso a quella sessione: è l'unica
   * cosa che si può ancora dire quando i singoli fili non hanno più uno stream
   * su cui dichiarare la propria chiusura.
   *
   * Ripeterlo non fa danno: una sessione che di là non c'è più si lascia cadere
   * in silenzio, e questa non ne può prendere il posto di nessun'altra — il suo
   * nome è fisso e non è un UUID, quindi non collide con nessuna sessione vera.
   */
  private congedaPonte(): void {
    this.macchina()?.send(JSON.stringify(
      { t: "guest-left", sessionId: SID_PONTE, ruolo: "guest" } satisfies MessaggioRelay,
    ));
  }

  private ponteVivo(): { capo: ReturnType<typeof creaPonte>; gen: string } {
    if (this.ponte) return this.ponte;
    // I socket sopravvissuti allo sfratto non hanno più un capo: la sessione
    // che li teneva sta per essere congedata, e i loro numeri di stream la
    // macchina non li riaccetterà mai più. Si chiudono dicendolo — restare
    // aperti sarebbe peggio, perché somiglia a funzionare — e chi sta di là
    // riapre.
    //
    // Se il runtime facesse rientrare `webSocketClose` da queste chiusure, con
    // `ponte` ancora nullo, quel gestore direbbe la STESSA frase che si dice
    // due righe più giù: un congedo in più, che di là si lascia cadere in
    // silenzio. E se invece rientra più tardi, il ponte nuovo c'è già e quella
    // chiusura porta il nome di una generazione PRECEDENTE, che non indica
    // nessun filo vivo: si posa su niente. È esattamente per questo che il nome
    // porta la generazione — senza, indicherebbe il primo filo di questo ponte.
    this.spazzaOrfani();
    // Prima parola dell'istanza nuova: la sessione di prima non esiste più.
    // Vedi il commento sul campo — senza questo, una numerazione che riparte da
    // capo si scontra con quella che la macchina ricorda.
    this.congedaPonte();
    this.ponte = {
      gen: nuovaGenerazione(),
      capo: creaPonte({
        invia: (payload) => {
          // Si rilegge la macchina a ogni frame invece di tenersela: fra una
          // richiesta e l'altra può essere stata sostituita, e scrivere sulla
          // socket di prima vorrebbe dire parlare a nessuno senza accorgersene.
          this.macchina()?.send(JSON.stringify({ t: "to-guest", to: SID_PONTE, payload } satisfies MessaggioRelay));
        },
      }),
    };
    return this.ponte;
  }

  /**
   * I socket del ponte, chiusi dicendo che il loro capo è ripartito.
   *
   * Una frase sola in un posto solo perché ha DUE mittenti — l'istanza nuova
   * che ricomincia, e la fine di una visita che arriva a istanza sfrattata — e
   * due copie della stessa chiusura sono due chiusure che un giorno dicono
   * codici diversi. Chiudere una socket già chiusa non fa niente, quindi
   * ripassarci sopra è al più un giro sprecato.
   */
  private spazzaOrfani(): void {
    for (const orfano of this.state.getWebSockets(TAG_PONTE)) {
      try { orfano.close(WS_PONTE_RIPARTITO, "relay bridge restarted"); } catch { /* già chiusa */ }
    }
  }

  /**
   * La macchina se n'è andata o è stata sostituita: chi aspettava una risposta
   * non la aspetta più, e la sessione del ponte va rifatta da zero.
   *
   * ── E I SOCKET DEI BROWSER SI CHIUDONO COMUNQUE ───────────────────────────
   * Con un ponte vivo li ha già chiusi `abbandona()`, con questo stesso codice
   * e questa stessa parola: ripassarci non cambia niente. Ma dopo uno sfratto
   * il ponte non c'è, e allora `abbandona()` non ha niente da chiudere mentre i
   * socket verso i browser sono ancora tutti aperti — una scheda che resta lì a
   * guardare qualcosa che non si aggiornerà mai più, cioè il modo peggiore di
   * guastarsi, perché somiglia a funzionare.
   *
   * I socket, allo sfratto, SOPRAVVIVONO: li tiene il runtime, non l'oggetto, e
   * si ritrovano dal tag — l'unica memoria che lo sfratto non porta via.
   *
   * Sta qui e non nel gestore della chiusura perché le strade sono DUE, e una
   * sola delle due passa da lì: una macchina che viene sostituita da un'altra è
   * congedata da `fetch()`, e il suo `webSocketClose` non arriva mai.
   */
  private scollegaPonte(): void {
    this.ponte?.capo.abbandona();
    this.ponte = null;
    for (const b of this.state.getWebSockets(TAG_PONTE)) {
      try { b.close(WS_PONTE_GIU, "installation offline"); } catch { /* già chiusa */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── IL PONTE: una richiesta HTTPS normale, non un upgrade.
    //
    // Va guardato PRIMA del cancello dell'upgrade, che per le tre porte è
    // giusto e qui sarebbe esattamente ciò che tiene fuori un browser.
    const ponte = url.pathname.match(PERCORSO_PONTE);
    if (ponte) {
      const host = this.macchina();
      if (!host) return macchinaSpenta();
      // Il percorso che la macchina rigioca è ciò che resta DOPO
      // l'installazione, con la query di chi ha chiesto attaccata intatta. Il
      // tratto d'ingresso serve solo a rimettere in piedi i rimandi relativi.
      const percorso = `${ponte[2] && ponte[2].length > 0 ? ponte[2] : "/"}${url.search}`;
      const p = this.ponteVivo();

      // ── UN SOCKET DAL PONTE.
      //
      // Il client ne apre quattro per pannello — quello dell'applicazione,
      // quello di ogni terminale, quello di ogni pannello browser — e ognuno ha
      // vita sua sopra lo stesso tubo. Si ASPETTA l'esito prima di rispondere:
      // un `101` dato subito e poi chiuso è, per chi guarda, un socket morto
      // senza motivo, e il sottoprotocollo scelto lo decide la macchina.
      if (req.headers.get("upgrade") === "websocket") {
        const e = await p.capo.apriWs(req, percorso);
        if (!e.ok) return upgradeRifiutato(e.stato);
        const coppia = new WebSocketPair();
        // `acceptWebSocket` e mai `accept()`: l'ibernazione è il motivo per cui
        // il conto è $10 invece di $416. Il NOME del socket sta in un tag,
        // perché è l'unica memoria che sopravvive allo sfratto — e porta la
        // generazione del ponte, perché il numero da solo si ripete.
        this.state.acceptWebSocket(coppia[1], [TAG_PONTE, tagFilo(p.gen, e.sIn)]);
        p.capo.collegaWs(e.sIn, coppia[1] as unknown as SocketPonte);
        const apertura: Record<string, unknown> = { status: 101, webSocket: coppia[0] };
        // Un browser che aveva chiesto un sottoprotocollo e non se lo vede
        // tornare rifiuta la connessione: la scelta è della macchina, e qui si
        // riporta la sua.
        if (e.sp !== undefined) apertura.headers = { "sec-websocket-protocol": e.sp };
        return new Response(null, apertura as ResponseInit);
      }

      return p.capo.servi(req, percorso, `/i/${ponte[1]}`);
    }

    const ruolo = url.searchParams.get("ruolo");
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("serve un upgrade websocket", { status: 426 });
    }

    const coppia = new WebSocketPair();
    const [client, mio] = [coppia[0], coppia[1]];

    if (ruolo === "host") {
      // Una macchina sola per installazione: se ne arriva una seconda, la
      // prima se ne va. Due host sullo stesso oggetto vorrebbe dire due
      // risposte alla stessa domanda, e nessun modo di sapere quale è viva.
      for (const vecchia of this.state.getWebSockets(TAG_MACCHINA)) {
        try { vecchia.close(4000, "sostituita"); } catch { /* già chiusa */ }
      }
      // La macchina di prima non risponderà più: chi stava aspettando lo deve
      // sapere adesso, e la sessione del ponte va rifatta con quella nuova.
      this.scollegaPonte();
      this.state.acceptWebSocket(mio, [TAG_MACCHINA]);
      mio.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION } satisfies MessaggioRelay));
    } else {
      const host = this.state.getWebSockets(TAG_MACCHINA);
      if (host.length === 0) {
        // Un motivo suo, non un errore generico: all'ospite va detto che la
        // macchina è spenta, invece di lasciarlo davanti a una pagina vuota
        // che si legge come «non ti hanno condiviso niente» (RELAY-05).
        return new Response(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
      // Il ruolo lo decide il PERCORSO, che è roba del relay: non si legge da
      // niente che il capo abbia scritto. Tutto ciò che non è la porta dei
      // dispositivi è un ospite — un valore inventato non promuove nessuno.
      const sessione: RuoloSessione = ruolo === "device" ? "device" : "guest";
      const sid = crypto.randomUUID();
      this.state.acceptWebSocket(mio, [tagSessione(sid), tagRuolo(sessione)]);
      mio.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, sessionId: sid } satisfies MessaggioRelay));
      host[0].send(JSON.stringify({ t: "guest-joined", sessionId: sid, ruolo: sessione } satisfies MessaggioRelay));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** I tag di una socket: l'unica memoria che sopravvive allo sfratto dalla
   *  memoria, e quindi l'unico modo di sapere chi è. */
  private tagDi(ws: WebSocket): string[] {
    return (this.state as unknown as { getTags(ws: WebSocket): string[] }).getTags(ws);
  }

  /** Chi è questa socket, letto dai tag. L'unico modo: fra un messaggio e
   *  l'altro l'istanza può essere stata sfrattata dalla memoria. */
  private chiE(ws: WebSocket): { host: true } | { sid: string; ruolo: RuoloSessione } | null {
    const tags = this.tagDi(ws);
    if (tags.includes(TAG_MACCHINA)) return { host: true };
    const g = tags.find((t) => t.startsWith("s:"));
    if (!g) return null;
    return {
      sid: g.slice("s:".length),
      ruolo: tags.includes(tagRuolo("device")) ? "device" : "guest",
    };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // ── UN SOCKET DEL PONTE, prima di tutto il resto.
    //
    // Ciò che ci passa sopra è traffico dell'APPLICAZIONE, non il protocollo
    // del relay: leggerlo come una busta vorrebbe dire rispondere `denied` a
    // ogni messaggio di una chat. Va riconosciuto dal tag, che è l'unica cosa
    // che il relay sa di suo, e girato dentro il tubo senza aprirlo.
    //
    // Qui i binari PASSANO, e non è la porta che si apre: è un terminale. Il
    // client mette `binaryType = "arraybuffer"` sul socket dei terminali, e i
    // suoi byte sono il contenuto di una sessione — mentre sulle altre tre
    // porte un binario non fa parte del protocollo e resta scartato, due righe
    // più sotto. Il tubo li porta come tutto il resto, con il credito che li
    // misura: un flusso non ha modo di crescere senza che qualcuno lo consumi.
    const tags = this.tagDi(ws);
    if (tags.includes(TAG_PONTE)) {
      const nome = filoDelTag(tags);
      const dato = typeof raw === "string" ? raw : new Uint8Array(raw);
      // Il nome vale solo dentro la sua generazione: un filo di un ponte
      // precedente porta un numero che questo ponte ha già dato a un altro.
      const suo = nome !== null && nome.gen === this.ponte?.gen ? nome.filo : null;
      if (suo === null || !this.ponte?.capo.messaggioWs(suo, dato)) {
        // Il ponte non conosce questo socket: o l'istanza è stata sfrattata, o
        // la sessione è stata rifatta. In tutti e due i casi il filo non arriva
        // più da nessuna parte, e restare aperti somiglia a funzionare.
        try { ws.close(WS_PONTE_RIPARTITO, "relay bridge restarted"); } catch { /* già chiusa */ }
      }
      return;
    }

    if (typeof raw !== "string") return; // i binari non fanno parte del protocollo
    let m: MessaggioRelay | null = null;
    try { m = leggiMessaggio(JSON.parse(raw)); } catch { m = null; }
    if (!m) {
      // Un capo che accetta ciò che quasi capisce è un capo che un giorno
      // accetta ciò che non capisce affatto.
      ws.send(JSON.stringify({ t: "denied", motivo: "bad-version" } satisfies Rifiutato));
      return;
    }

    const chi = this.chiE(ws);
    if (!chi) return;

    if ("host" in chi && m.t === "to-guest") {
      const dest = this.state.getWebSockets(tagSessione(m.to));
      if (dest.length > 0) {
        // Per una sessione con una socket dietro si inoltra e basta, byte per
        // byte: il relay non guarda dentro ciò che non è suo.
        dest[0]?.send(raw);
        return;
      }
      // …la sola busta che è INDIRIZZATA al relay: quella della sessione del
      // ponte, di cui il relay è il capo ospite. Se nessuno sta aspettando —
      // istanza nuova, o ponte già abbandonato — cade come tutte le altre.
      if (m.to === SID_PONTE) this.ponte?.capo.ricevi(m.payload);
      // Una busta per un ospite che se n'è andato si lascia cadere in silenzio:
      // non è un errore della macchina, è il mondo che è cambiato.
      return;
    }

    if ("sid" in chi && m.t === "to-host") {
      const host = this.state.getWebSockets(TAG_MACCHINA);
      if (host.length === 0) {
        ws.send(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato));
        return;
      }
      // È il RELAY ad attaccare il mittente, non l'ospite: se lo scegliesse lui
      // potrebbe spacciarsi per un'altra sessione.
      host[0].send(JSON.stringify({ t: "to-guest", to: chi.sid, payload: m.payload } satisfies MessaggioRelay));
    }
  }

  async webSocketClose(ws: WebSocket, codice?: number, motivo?: string): Promise<void> {
    // Un socket del ponte porta il proprio codice fino alla macchina: senza,
    // da fuori rete ogni chiusura si leggerebbe uguale, e chi si riconnette non
    // saprebbe se deve. Non si chiama `ponteVivo` da qui, e non è perché non ci
    // sia niente da riferire — ce n'è, ed è qui sotto: è che rifare la sessione
    // per raccontarne la fine vorrebbe dire aprirne una nuova nell'istante in
    // cui si sta chiudendo quella vecchia, e le due si contraddirebbero.
    const tags = this.tagDi(ws);
    if (tags.includes(TAG_PONTE)) {
      const nome = filoDelTag(tags);
      if (this.ponte) {
        // Solo un filo di QUESTA generazione ha qualcosa da chiudere qui. Uno
        // di prima non è «uno che il ponte non conosce»: il suo numero è
        // proprio quello che il ponte nuovo ha già dato al suo primo socket —
        // la numerazione riparte da capo — quindi senza il confronto sulla
        // generazione questa chiusura taglierebbe un filo VIVO. Della sua
        // sessione è già stato detto tutto: `ponteVivo` l'ha congedata prima
        // di nascere, e di là non è rimasto niente da spegnere.
        if (nome !== null && nome.gen === this.ponte.gen) {
          this.ponte.capo.chiudiWs(nome.filo, codice, motivo);
        }
        return;
      }
      // ── IL BROWSER SE N'È ANDATO DOPO UNO SFRATTO.
      //
      // Questo socket è l'orfano di un'istanza che non c'è più, e il suo filo
      // dentro il tubo se n'è andato con lei: la chiusura si dichiara sullo
      // stream di quel filo, e quello stream la macchina non lo riaccetterà mai
      // più. Senza dire NIENT'ALTRO, di là resta un socket vero — un terminale
      // che continua a girare davanti a nessuno — e nessuno lo chiuderà, perché
      // l'unico che poteva era il ponte che è stato sfrattato.
      //
      // L'unica cosa ancora dicibile è che la SESSIONE del ponte è finita, e di
      // là quella parola chiude tutto ciò che le era appeso. Vale per ogni
      // orfano, non solo per l'ultimo: sono tutti orfani della stessa istanza,
      // per la stessa ragione, quindi il congedo è lo stesso — e ripeterlo è un
      // messaggio in più una volta per sfratto, non un costo per frame.
      this.congedaPonte();
      // …e la stessa parola vale di QUA. Il congedo di là chiude TUTTI i fili
      // di quella sessione, non solo questo: una visita è più di un socket — un
      // pannello del client ne apre quattro — e i fratelli restano aperti su
      // qualcosa che non esiste più. Chi non manda mai niente non passerà mai
      // dal controllo di `webSocketMessage`: un terminale che scrive e basta,
      // o il socket dell'applicazione che riceve gli aggiornamenti, resterebbe
      // aperto e muto finché non capita una richiesta che rifà il ponte. Aperto
      // e muto è il modo peggiore di guastarsi, perché somiglia a funzionare.
      this.spazzaOrfani();
      return;
    }

    const chi = this.chiE(ws);
    if (!chi) return;

    if ("host" in chi) {
      // Chi stava aspettando una risposta tradotta non l'avrà: meglio dirlo
      // adesso che lasciare girare una scheda del browser fino alla scadenza.
      this.scollegaPonte();
      // La macchina se n'è andata: gli ospiti devono saperlo, o restano a
      // guardare qualcosa che non si aggiorna più senza capire perché.
      for (const g of this.state.getWebSockets()) {
        const suo = this.chiE(g);
        if (suo && "sid" in suo) {
          try { g.send(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato)); } catch { /* va bene */ }
        }
      }
      return;
    }

    const host = this.state.getWebSockets(TAG_MACCHINA);
    host[0]?.send(JSON.stringify({ t: "guest-left", sessionId: chi.sid, ruolo: chi.ruolo } satisfies MessaggioRelay));
  }
}
