import { StringDecoder } from "node:string_decoder";

/**
 * Piegare byte arbitrari in righe NDJSON, in tempo LINEARE.
 *
 * Il taglia-righe che questo modulo sostituisce viveva dentro
 * `wireBrokerHandlers` (claude-code.ts) ed era scritto così:
 *
 *     lineBuf += chunk.toString();
 *     while ((nl = lineBuf.indexOf("\n")) !== -1) {
 *       onLine(lineBuf.slice(0, nl));
 *       lineBuf = lineBuf.slice(nl + 1);   // ← ricopia TUTTO il resto, per riga
 *     }
 *
 * Su un chunk piccolo non si nota. Su un REPLAY non è un chunk piccolo: la
 * fase 1 di `reattach` fa `attach(offset 0)`, cioè si fa consegnare l'intero
 * store del broker — in produzione fino a 6,9 MB — e fino a ieri il daemon lo
 * spediva in UN frame solo. Quel `slice` per riga rende il costo quadratico
 * nella dimensione del chunk: uno store da 7 MB con righe da ~500 byte sono
 * ~14.000 righe, ognuna che ricopia in media 3,5 MB → decine di GB di copie
 * per UN attach, tutte dentro un unico giro di event loop, con l'intero
 * server fermo. È metà della firma della raffica di «ack timeout»: i waiter
 * non scadono perché il daemon tace, scadono perché il processo che deve
 * leggerne la risposta è bloccato qui dentro.
 *
 * Qui l'indice scorre e si copia solo la riga: il totale copiato è pari al
 * totale dei byte, una volta.
 *
 * `StringDecoder` invece di `chunk.toString()` per un guasto diverso e più
 * silenzioso: i chunk arrivano su confini di byte arbitrari — sempre, dallo
 * stdout del figlio, e ora anche dal replay a fette — e `toString()` su una
 * sequenza UTF-8 tagliata a metà produce U+FFFD. Una `à` spezzata a cavallo
 * di due chunk diventava spazzatura dentro il JSON, e la riga intera si
 * perdeva nel `catch` del parser. Il decoder tiene i byte incompleti da parte
 * fino al chunk successivo.
 */
export type LineFolder = ((chunk: Buffer) => void) & {
  /**
   * Riallinea il cursore dei byte a `atOffset` e butta il mezzo pezzo di riga
   * rimasto in sospeso. Serve quando la consegna RIPARTE da un punto diverso —
   * un `attach` da un offset arbitrario — e quindi i byte tenuti da parte non
   * sono più contigui con quelli che stanno per arrivare.
   */
  reset(atOffset: number): void;
};

/**
 * `onLine` riceve la riga E l'offset assoluto del primo byte DOPO il suo `\n`.
 *
 * Perché l'offset, e perché per RIGA. Chi riadotta un turno vivo riparte da
 * «subito dopo l'ultimo `result`». Prima quell'offset veniva letto dal cursore
 * del CHUNK — che si aggiorna a fold FINITO, quindi mentre le righe scorrono
 * vale ancora quello del giro precedente: su un replay consegnato in un frame
 * solo, zero. La riadozione si rispediva l'intero store una terza volta e lo
 * ripiegava non muta, con i turni vecchi che tornavano nella bolla nuova.
 * Anche prendendolo alla fine della fetta sarebbe stato sbagliato al contrario:
 * tutto ciò che nella stessa fetta veniva DOPO il result — la testa del turno
 * ancora aperto — resterebbe prima del punto di ripartenza e non verrebbe mai
 * rispedito, e la fase 2 dichiarerebbe «completed» un turno in volo.
 *
 * Il conto è esatto per costruzione: `byteLength(riga) + 1` (l'`\n`), sommato
 * riga per riga. I byte ancora in sospeso — mezza riga, o una sequenza UTF-8
 * spezzata dentro il decoder — semplicemente non sono ancora contati.
 */
export function createLineFolder(
  onLine: (line: string, endOffset: number) => void,
  startOffset = 0,
): LineFolder {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  // Offset assoluto del primo byte di `carry`, cioè del prossimo byte da piegare.
  let cursor = startOffset;
  const fold = ((chunk: Buffer): void => {
    const s = carry + decoder.write(chunk);
    let start = 0;
    let nl = s.indexOf("\n", start);
    if (nl === -1) { carry = s; return; }
    while (nl !== -1) {
      const line = s.slice(start, nl);
      cursor += Buffer.byteLength(line) + 1;
      onLine(line, cursor);
      start = nl + 1;
      nl = s.indexOf("\n", start);
    }
    carry = s.slice(start);
  }) as LineFolder;
  fold.reset = (atOffset: number): void => {
    carry = "";
    decoder.end(); // butta via i byte UTF-8 incompleti: sono di un'altra regione
    cursor = atOffset;
  };
  return fold;
}
