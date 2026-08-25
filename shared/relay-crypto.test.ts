/**
 * La cifratura delle buste del relay.
 *
 * Non si prova che AES funzioni — quello lo fa chi l'ha scritto. Si prova che
 * lo stiamo usando in un modo che regge le due promesse su cui il prodotto si
 * vende: **il relay non legge**, e **una busta manomessa non si apre**.
 *
 * @covers RELAY-E2E-11
 */
import { describe, expect, it } from "bun:test";
import {
  nuovaChiave, sigilla, apri, componiLink, leggiLink, aB64u, daB64u, BUSTA_V,
} from "./relay-crypto";

describe("cripto · andata e ritorno", () => {
  it("quel che si chiude si riapre", async () => {
    const k = nuovaChiave();
    const b = await sigilla(k, "ciao, sono un frame di chat");
    expect(await apri(k, b)).toBe("ciao, sono un frame di chat");
  });

  it("regge l'unicode e le stringhe lunghe", async () => {
    const k = nuovaChiave();
    const testo = "àèìòù 🇮🇹 — " + "x".repeat(50_000);
    expect(await apri(k, await sigilla(k, testo))).toBe(testo);
  });

  it("il vuoto è un contenuto come un altro", async () => {
    const k = nuovaChiave();
    expect(await apri(k, await sigilla(k, ""))).toBe("");
  });
});

describe("cripto · quello che il relay NON può fare", () => {
  it("non può leggere: il testo non compare nella busta", async () => {
    const k = nuovaChiave();
    const b = await sigilla(k, "SEGRETO-INDUSTRIALE");
    expect(b).not.toContain("SEGRETO");
    // E nemmeno in base64: il controllo ingenuo non basterebbe.
    expect(b).not.toContain(aB64u(new TextEncoder().encode("SEGRETO-INDUSTRIALE")));
  });

  it("non può leggere con la chiave sbagliata", async () => {
    const b = await sigilla(nuovaChiave(), "roba");
    expect(await apri(nuovaChiave(), b)).toBeNull();
  });

  it("non può MODIFICARE: una busta manomessa non si apre", async () => {
    // È il motivo per cui si usa GCM e non una cifratura senza autenticazione.
    // Senza, un relay ostile non leggerebbe — ma potrebbe scrivere.
    const k = nuovaChiave();
    const b = await sigilla(k, "trasferisci 10");
    const parti = b.split(".");
    const ct = daB64u(parti[2]);
    ct[0] ^= 0xff; // un bit girato
    expect(await apri(k, `${parti[0]}.${parti[1]}.${aB64u(ct)}`)).toBeNull();
  });

  it("non può nemmeno cambiare l'IV", async () => {
    const k = nuovaChiave();
    const b = await sigilla(k, "roba");
    const parti = b.split(".");
    const iv = daB64u(parti[1]);
    iv[0] ^= 0x01;
    expect(await apri(k, `${parti[0]}.${aB64u(iv)}.${parti[2]}`)).toBeNull();
  });
});

describe("cripto · l'IV non si ripete, e non lo sceglie il chiamante", () => {
  it("due buste dello STESSO testo sono diverse", async () => {
    // Riusare un IV in GCM non indebolisce la cifratura: la rompe, e rivela
    // anche la chiave di autenticazione. Per questo l'IV non è un parametro.
    const k = nuovaChiave();
    const a = await sigilla(k, "identico");
    const b = await sigilla(k, "identico");
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("su molte buste non si vede mai una collisione", async () => {
    const k = nuovaChiave();
    const iv = new Set<string>();
    for (let i = 0; i < 200; i++) iv.add((await sigilla(k, "x")).split(".")[1]);
    expect(iv.size).toBe(200);
  });

  it("due chiavi generate di seguito sono diverse", () => {
    expect(nuovaChiave()).not.toBe(nuovaChiave());
  });
});

describe("cripto · un rifiuto non racconta niente", () => {
  it("ogni modo di fallire dà lo stesso `null`", async () => {
    // Distinguere «chiave sbagliata» da «busta rotta» nel valore di ritorno
    // vorrebbe dire costruire un oracolo per chi prova.
    const k = nuovaChiave();
    for (const b of ["", "roba", "1.2", "9.abc.def", `${BUSTA_V}...`, `${BUSTA_V}.zzz.zzz`]) {
      expect(`${b}→${await apri(k, b)}`).toBe(`${b}→null`);
    }
  });

  it("una versione futura non si prova a interpretare", async () => {
    const k = nuovaChiave();
    const b = await sigilla(k, "x");
    const parti = b.split(".");
    expect(await apri(k, `${BUSTA_V + 1}.${parti[1]}.${parti[2]}`)).toBeNull();
  });
});

describe("cripto · il link tiene la chiave dove il server non la vede", () => {
  it("la chiave sta nel FRAMMENTO, mai nella query né nel percorso", () => {
    const k = nuovaChiave();
    const link = componiLink("https://topics.esempio.io", "inst-1", "ref-1", k);
    const u = new URL(link);
    // È l'unica parte di un URL che il browser non manda al server: non nella
    // riga di richiesta, non nei log, non nel Referer.
    expect(u.hash).toBe(`#${k}`);
    expect(u.search).toBe("");
    expect(u.pathname).not.toContain(k);
    // E la prova che conta: togliendo il frammento, la chiave sparisce.
    expect(link.split("#")[0]).not.toContain(k);
  });

  it("e si rilegge", () => {
    const k = nuovaChiave();
    const letto = leggiLink(componiLink("https://topics.esempio.io", "punto-1", "ref con spazi", k));
    expect(letto).toEqual({ relayId: "punto-1", shareRef: "ref con spazi", chiave: k });
  });

  it("un link senza frammento non è un link valido", () => {
    // Senza chiave non c'è niente da aprire: meglio dirlo subito che mostrare
    // una pagina che non decifrerà mai.
    expect(leggiLink("https://topics.esempio.io/g/inst-1/ref-1")).toBeNull();
    expect(leggiLink("non-un-url")).toBeNull();
  });

  it("il giro completo: link → chiave → busta aperta", async () => {
    const k = nuovaChiave();
    const link = componiLink("https://topics.esempio.io", "inst-1", "r1", k);
    const busta = await sigilla(k, "il contenuto condiviso");
    const letto = leggiLink(link)!;
    expect(await apri(letto.chiave, busta)).toBe("il contenuto condiviso");
  });
});
