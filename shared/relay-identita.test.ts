/**
 * Il nome del punto d'incontro è il digest di un segreto: cosa deve reggere.
 *
 * Il valore di questo modulo è tutto in una proprietà — chi ha il nome non può
 * risalire al segreto — e quella proprietà non si prova con un test: la regge
 * SHA-256. Qui si prova il contorno, che è dove le cose si rompono davvero: che
 * la derivazione sia stabile e uguale da entrambe le parti, che non accetti
 * come valido ciò che non lo è, e che i casi limite cadano dal lato del
 * rifiuto.
 *
 * @covers RELAY-E2E-12
 */
import { describe, expect, it } from "bun:test";
import {
  derivaRelayId, FORMA_RELAY_ID, INTESTAZIONE_SEGRETO,
  LUNGHEZZA_RELAY_ID, segretoCorrisponde,
} from "./relay-identita";

const SEGRETO = "un-segreto-di-prova-abbastanza-lungo-0123456789";

describe("nome · si deriva sempre allo stesso modo", () => {
  it("lo stesso segreto dà sempre lo stesso nome", async () => {
    // Se non fosse stabile, la macchina cambierebbe indirizzo a ogni riavvio e
    // ogni link consegnato smetterebbe di funzionare.
    expect(await derivaRelayId(SEGRETO)).toBe(await derivaRelayId(SEGRETO));
  });

  it("segreti diversi danno nomi diversi", async () => {
    const a = await derivaRelayId(SEGRETO);
    const b = await derivaRelayId(SEGRETO + "!");
    expect(a).not.toBe(b);
  });

  it("il nome ha la forma che il percorso del relay pretende", async () => {
    const id = await derivaRelayId(SEGRETO);
    expect(id).toHaveLength(LUNGHEZZA_RELAY_ID);
    expect(FORMA_RELAY_ID.test(id)).toBe(true);
    // base64url e non base64: `+` e `/` in un percorso vorrebbero dire un
    // segmento che si rompe o si ricodifica lungo la strada.
    expect(id).not.toMatch(/[+/=]/);
  });

  it("è un valore FISSO, non solo «stabile in questa esecuzione»", async () => {
    // Il caso sopra passerebbe anche se la derivazione cambiasse formula fra
    // una versione e l'altra: entrambi i lati la calcolerebbero uguale DENTRO
    // lo stesso processo, e a rompersi sarebbe solo il mondo già installato —
    // ogni macchina che si riaggancia con un nome nuovo, e ogni link vecchio
    // che punta a un punto d'incontro senza nessuno.
    //
    // Questo valore è il contratto. Se cambia, è una migrazione, non una
    // modifica: va cambiato di proposito sapendo cosa si sta rompendo.
    // Il valore atteso NON viene da questa implementazione: è stato calcolato
    // fuori, con openssl, per la ragione ovvia — un valore copiato dall'output
    // del codice che si sta provando fissa qualunque cosa il codice faccia,
    // compreso lo sbaglio.
    //
    //   printf 'topics-relay-id-v1\nsegreto-fisso-per-il-contratto' \
    //     | openssl dgst -sha256 -binary | openssl base64 -A \
    //     | tr '+/' '-_' | tr -d '=' | cut -c1-24
    expect(await derivaRelayId("segreto-fisso-per-il-contratto")).toBe("ja15H8kOSyyKkdsAZT9huDdk");
  });
});

describe("prova · corrisponde solo ciò che corrisponde", () => {
  it("il segreto giusto sul proprio nome", async () => {
    const id = await derivaRelayId(SEGRETO);
    expect(await segretoCorrisponde(SEGRETO, id)).toBe(true);
  });

  it("il segreto giusto sul nome di un ALTRO non passa", async () => {
    // È il caso che conta: due installazioni sullo stesso relay, e nessuna
    // delle due può agganciarsi al punto d'incontro dell'altra.
    const altrui = await derivaRelayId("il-segreto-di-qualcun-altro-9876543210");
    expect(await segretoCorrisponde(SEGRETO, altrui)).toBe(false);
  });

  it("un segreto quasi giusto non passa", async () => {
    const id = await derivaRelayId(SEGRETO);
    for (const quasi of [SEGRETO.slice(0, -1), SEGRETO + " ", SEGRETO.toUpperCase()]) {
      expect(`${quasi}→${await segretoCorrisponde(quasi, id)}`).toBe(`${quasi}→false`);
    }
  });

  it("assente, vuoto, o di un tipo che non è una stringa", async () => {
    const id = await derivaRelayId(SEGRETO);
    for (const no of [null, undefined, "", "corto", 42, {}, []]) {
      expect(`${String(no)}→${await segretoCorrisponde(no as never, id)}`).toBe(`${String(no)}→false`);
    }
  });

  it("un segreto assurdamente lungo si rifiuta invece di digerirlo", async () => {
    // Un'intestazione la scrive chi bussa: senza un tetto, il costo del digest
    // lo sceglie lui.
    const id = await derivaRelayId(SEGRETO);
    expect(await segretoCorrisponde("x".repeat(100_000), id)).toBe(false);
  });

  it("un NOME storto non passa, nemmeno col segreto giusto", async () => {
    // Il nome arriva dal percorso. Confrontarlo senza guardarne la forma
    // vorrebbe dire che una stringa qualunque può essere il bersaglio del
    // confronto — e il bersaglio è ciò che sceglie quale punto d'incontro
    // svegliare.
    for (const storto of ["", "corto", "con spazio!", "x".repeat(200)]) {
      expect(`${storto}→${await segretoCorrisponde(SEGRETO, storto)}`).toBe(`${storto}→false`);
    }
  });
});

describe("intestazione · il nome con cui viaggia", () => {
  it("è minuscolo, perché è così che si confronta a valle", () => {
    expect(INTESTAZIONE_SEGRETO).toBe(INTESTAZIONE_SEGRETO.toLowerCase());
  });

  it("non è una delle intestazioni che il tubo spoglia", async () => {
    // `intestazioniRichiesta` butta via tutto ciò che dichiara un indirizzo o
    // un salto. Se un giorno il segreto finisse in quella lista, l'aggancio
    // smetterebbe di funzionare in un modo che non nomina mai il segreto.
    const { intestazioniRichiesta } = await import("./relay-http");
    const passate = intestazioniRichiesta([[INTESTAZIONE_SEGRETO, "v"]]);
    expect(passate).toEqual([[INTESTAZIONE_SEGRETO, "v"]]);
  });
});
