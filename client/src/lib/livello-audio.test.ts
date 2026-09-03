/**
 * La sonda del livello: la frase, la soglia, e le due superfici che la usano.
 *
 * Il pezzo che decide sta tutto in `messaggioTrascrittoVuoto`, che e' puro. La
 * cattura vera (`ascoltaLivello`) vuole un `AudioContext` e uno stream, quindi
 * si prova a mano nella app; qui si prova cio' che sbaglierebbe in silenzio: la
 * scelta fra le due diagnosi, e il fatto che entrambe le superfici la chiedano
 * allo stesso posto.
 *
 * @covers CHAT-04
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOGLIA_TRACCIA_MUTA, messaggioTrascrittoVuoto, type SondaLivello } from "./livello-audio";

function sonda(picco: number): SondaLivello {
  return { picco: () => picco, muta: () => picco < SOGLIA_TRACCIA_MUTA, livello: () => picco, chiudi: () => {} };
}

describe("quale delle due diagnosi", () => {
  test("traccia muta: manda a controllare l'INGRESSO, non a parlare piu' forte", () => {
    const m = messaggioTrascrittoVuoto({ sonda: sonda(0.002), provider: "local", durataMs: 3000 });
    expect(m).toContain("non ha prodotto suono");
    expect(m).toContain("Ingresso");
    // La frase sbagliata da dare a chi ha l'ingresso staccato: parlerebbe piu'
    // forte per sempre senza che cambi niente.
    expect(m).not.toContain("piu' vicino");
  });

  test("il picco misurato entra nel messaggio: senza numero non e' una misura", () => {
    expect(messaggioTrascrittoVuoto({ sonda: sonda(0.002), provider: "local", durataMs: 3000 })).toContain("0.2%");
  });

  test("segnale c'era: allora e' il modello che non ha capito, e si dice chi era", () => {
    const m = messaggioTrascrittoVuoto({ sonda: sonda(0.35), provider: "elevenlabs", durataMs: 1200 });
    expect(m).toContain("Non ho sentito parole");
    expect(m).toContain("elevenlabs");
    expect(m).toContain("1.2s");
    expect(m).not.toContain("Ingresso");
  });

  test("senza sonda si resta sul messaggio generico invece di accusare a caso", () => {
    // `ascoltaLivello` restituisce null dove non c'e' AudioContext. Una
    // diagnosi inventata la' sarebbe peggio di nessuna diagnosi.
    const m = messaggioTrascrittoVuoto({ sonda: null, provider: "openai", durataMs: 900 });
    expect(m).toContain("Non ho sentito parole");
    expect(m).not.toContain("non ha prodotto suono");
  });

  test("la soglia separa il silenzio DIGITALE dalla stanza silenziosa", () => {
    // Appena sotto e appena sopra devono cadere da due parti diverse: una
    // soglia che non separa e' una costante decorativa.
    expect(sonda(SOGLIA_TRACCIA_MUTA - 0.0001).muta()).toBe(true);
    expect(sonda(SOGLIA_TRACCIA_MUTA).muta()).toBe(false);
    // Il fondo di una stanza ferma sta sopra la soglia: se non fosse cosi', la
    // diagnosi accuserebbe l'ingresso audio a ogni dettatura silenziosa.
    expect(sonda(0.03).muta()).toBe(false);
  });
});

describe("le due superfici chiedono la frase allo stesso posto", () => {
  // PERCHE' ESISTE. Dettatura (campo task) e nota vocale (chat) sono due hook
  // gemelli che registrano allo stesso modo, e il 14/08 sono divergiuti TRE
  // volte sullo stesso ramo: nota vuota, segnalazione, trascritto vuoto. Ogni
  // volta uno spiegava e l'altro taceva. Il difetto non era la frase, era che
  // ce n'erano due.
  const sorgente = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  for (const file of ["hooks/useDictation.ts", "components/Chat/useVoiceRecording.ts"]) {
    test(`${file} usa messaggioTrascrittoVuoto e apre la sonda`, () => {
      const src = sorgente(file);
      expect(src).toContain("messaggioTrascrittoVuoto");
      expect(src).toContain("ascoltaLivello(stream)");
      // Un AudioContext non chiuso resta vivo in WebKit a ogni registrazione.
      expect(src).toContain("chiudi()");
    });
  }
});
