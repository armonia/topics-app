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
export function createLineFolder(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  return (chunk: Buffer): void => {
    const s = carry + decoder.write(chunk);
    let start = 0;
    let nl = s.indexOf("\n", start);
    if (nl === -1) { carry = s; return; }
    while (nl !== -1) {
      onLine(s.slice(start, nl));
      start = nl + 1;
      nl = s.indexOf("\n", start);
    }
    carry = s.slice(start);
  };
}
