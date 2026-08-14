/**
 * Le risposte JSON escono da questo server NON compresse. Su loopback non si
 * nota; dal telefono sono secondi di schermo vuoto.
 *
 * Misurato il 2026-08-14 su questa macchina, con `curl --compressed`: nessuna
 * risposta porta `Content-Encoding`, cioè il server ignora `Accept-Encoding` e
 * spedisce i byte com'erano. E il JSON di questa app comprime bene, perché è
 * fatto di chiavi che si ripetono a ogni riga:
 *
 *   GET /api/history/:key?limit=0   5,17 MB → 1,39 MB   (3,8×)   60 ms
 *   GET /api/all-boards/tasks       1,37 MB →  339 KB   (4,1×)   13 ms
 *
 * Su una LAN da ~20 Mbit effettivi quei 3,8 MB in meno sono circa un secondo e
 * mezzo in cui la chat non c'è.
 *
 * ## Perché solo per chi NON è locale
 *
 * Comprimere costa 60 ms di CPU sul payload più grosso. Verso un peer di
 * loopback — il guscio Tauri sulla stessa macchina, la CLI, il banco di prova —
 * quei 60 ms sono un ritardo che compra ZERO: il trasferimento su loopback è già
 * gratis. Verso un telefono in LAN comprano un secondo e mezzo.
 *
 * La domanda è quindi «c'è una rete in mezzo», e si risponde con l'indirizzo del
 * peer: loopback = crudo, tutto il resto = compresso. NON è la stessa domanda di
 * `isLocalTransport` (server/lib/tunnel.ts), che chiede «di chi mi fido» e per
 * cui il tunnel è remoto anche col peer a 127.0.0.1. Sul tunnel una rete non c'è:
 * dall'altro capo del socket sta `relay-client.ts`, su questa stessa macchina,
 * che rigioca la richiesta con `fetch` e la scompatta subito — misurato, Bun
 * scompatta da sé — e infatti `intestazioniRisposta` toglie `content-encoding`
 * perché il corpo che riparte verso l'ospite è di nuovo testo. Comprimere lì
 * vuol dire pagare due volte per consegnare gli stessi byte.
 *
 * ## Cosa NON si tocca
 *
 * · `text/event-stream` — è lo streaming della chat. Comprimerlo vorrebbe dire
 *   bufferarlo, cioè trasformare un flusso in un blocco: la ragione per cui
 *   esiste. Qui si guarda solo `application/json`, e lo streaming non lo è.
 * · Le risposte già codificate (`Content-Encoding` presente).
 * · `HEAD` — il corpo lo svuota `Bun.serve` da sé, e una lunghezza compressa su
 *   un corpo vuoto sarebbe una bugia.
 * · Tutto ciò che sta sotto la soglia: un MTU. Sotto un pacchetto non si
 *   risparmia un viaggio, si spende solo CPU.
 */

/** Un pacchetto. Sotto, comprimere non toglie nemmeno un viaggio di rete. */
export const SOGLIA_BYTE = 1400;

/**
 * Byte su un buffer NON condiviso: `Bun.gzipSync` e il corpo di una `Response`
 * rifiutano entrambi un `SharedArrayBuffer`, e `Uint8Array` da solo li
 * ammetterebbe entrambi.
 */
type Byte = Uint8Array<ArrayBuffer>;

/** Gli stati che per specifica non possono avere un corpo. */
const SENZA_CORPO = new Set([101, 204, 205, 304]);

/**
 * Questa risposta va compressa?
 *
 * Funzione pura, separata dall'applicazione, perché è QUI che stanno le
 * decisioni da provare una per una — e provarle richiederebbe altrimenti un
 * server vero.
 */
export function vaCompressa(args: {
  metodo: string;
  stato?: number;
  acceptEncoding: string | null;
  contentType: string | null;
  contentEncoding: string | null;
  /** `false` per loopback: vedi la nota in testa al file. */
  remoto: boolean;
  /** Byte del corpo, quando già noti. `null` = ancora da leggere. */
  byte: number | null;
  soglia?: number;
}): boolean {
  const soglia = args.soglia ?? SOGLIA_BYTE;
  if (!args.remoto) return false;
  if (args.metodo === "HEAD") return false;
  // Gli stati che per specifica NON hanno corpo. Su Bun ricostruirli non lancia
  // (verificato: `new Response(new Uint8Array(0), {status: 304})` passa), quindi
  // oggi il ramo sarebbe innocuo — ma un 304 riscritto con `Content-Length: 20`
  // e `Content-Encoding: gzip` racconterebbe di un corpo che non c'è, e questa
  // funzione gira su OGNI risposta del server. Si esce prima e non se ne parla.
  if (args.stato !== undefined && SENZA_CORPO.has(args.stato)) return false;
  if (args.contentEncoding) return false;
  if (!(args.contentType ?? "").toLowerCase().startsWith("application/json")) return false;
  // `gzip` come token, non come sottostringa: `Accept-Encoding: gzipx` non è gzip,
  // e `x-gzip` è un altro nome dello stesso schema che qui non promettiamo.
  if (!/(^|[\s,])gzip\s*(;|,|$)/i.test(args.acceptEncoding ?? "")) return false;
  if (args.byte !== null && args.byte < soglia) return false;
  return true;
}

/**
 * La stessa risposta, compressa quando conviene.
 *
 * Il corpo si legge una volta sola: una `Response` letta è consumata, quindi
 * anche il ramo «troppo piccola, lascia stare» deve ricostruirla dai byte già
 * letti. Leggerlo tutto va bene solo perché qui si arriva unicamente per
 * `application/json`, che è già una stringa intera in memoria.
 */
export async function comprimiJson(
  req: Request,
  res: Response,
  remoto: boolean,
  opts?: { soglia?: number; gzip?: (b: Byte) => Byte },
): Promise<Response> {
  const primoVaglio = vaCompressa({
    metodo: req.method,
    stato: res.status,
    acceptEncoding: req.headers.get("accept-encoding"),
    contentType: res.headers.get("content-type"),
    contentEncoding: res.headers.get("content-encoding"),
    remoto,
    byte: null,
    soglia: opts?.soglia,
  });
  if (!primoVaglio) return res;

  const crudo = new Uint8Array(await res.arrayBuffer()) as Byte;
  if (crudo.byteLength < (opts?.soglia ?? SOGLIA_BYTE)) {
    return new Response(crudo, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const gzip = opts?.gzip ?? ((b: Byte) => Bun.gzipSync(b) as Byte);
  const compresso = gzip(crudo);
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compresso.byteLength));
  // Senza `Vary`, una cache intermedia servirebbe la risposta compressa a un
  // client che non sa scompattarla.
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Accept-Encoding");
  else if (!/\baccept-encoding\b/i.test(vary)) headers.set("Vary", `${vary}, Accept-Encoding`);
  return new Response(compresso, { status: res.status, statusText: res.statusText, headers });
}
