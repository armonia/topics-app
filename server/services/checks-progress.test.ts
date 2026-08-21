/**
 * IL PROGRESSO DEI CONTROLLI, e il parser che lo legge.
 *
 * IL DIFETTO CHE CHIUDE. La card diceva «check in corso» dall'inizio alla fine
 * della corsa. Segnalato: «vedo che c'e' qualcosa in corso, ma se c'e'
 * qualcosa in corso dovrebbe esserci un progress». Il dato c'era gia' —
 * `runReviewChecks` espone `onProgress` e i comandi girano uno per uno — e non
 * lo leggeva nessuno.
 *
 * PERCHE' SI PROVA IL PARSER. Il progresso viaggia dentro `checks_json`, che
 * fino a ieri conteneva SOLO un array di run: la stessa colonna ora porta due
 * forme diverse. Un parser che le confonde e' il modo esatto in cui questo
 * cambiamento puo' rompere qualcosa di vecchio — e lo farebbe in silenzio, con
 * i risultati dei controlli che spariscono da un drawer.
 */
import { describe, test, expect } from "bun:test";
import { parseChecksJson, parseChecksProgress } from "./tasks";

describe("parseChecksJson — le due forme convivono", () => {
  test("la forma VECCHIA (array nudo) continua a leggersi", () => {
    const runs = [{ cmd: "bun test", ok: true, code: 0, ms: 10 }];
    expect(parseChecksJson(JSON.stringify(runs))).toEqual(runs as never);
  });

  test("la forma NUOVA porta i run parziali, non li nasconde", () => {
    // Un comando gia' rosso deve vedersi subito, non a fine giro.
    const runs = [{ cmd: "bun test", ok: false, code: 1, ms: 10 }];
    expect(parseChecksJson(JSON.stringify({ progress: { done: 1, total: 3 }, runs }))).toEqual(runs as never);
  });

  test("nessun run = null, non un array vuoto", () => {
    // `[]` e `null` si leggono diversi a valle: uno dice «misurato, niente»,
    // l'altro «non misurato».
    expect(parseChecksJson(JSON.stringify([]))).toBeNull();
    expect(parseChecksJson(JSON.stringify({ progress: { done: 0, total: 3 }, runs: [] }))).toBeNull();
  });

  test("un JSON storto vale «nessuna evidenza», non un'eccezione", () => {
    // Una riga scritta a mano non deve far esplodere OGNI lettura del task.
    expect(parseChecksJson("{non json")).toBeNull();
    expect(parseChecksJson("")).toBeNull();
    expect(parseChecksJson(null)).toBeNull();
  });
});

describe("parseChecksProgress — i numeri o niente", () => {
  test("legge done/total dalla forma nuova", () => {
    expect(parseChecksProgress(JSON.stringify({ progress: { done: 2, total: 5 }, runs: [] })))
      .toEqual({ done: 2, total: 5 });
  });

  test("zero su N e' un progresso VALIDO: la corsa e' appena partita", () => {
    expect(parseChecksProgress(JSON.stringify({ progress: { done: 0, total: 4 }, runs: [] })))
      .toEqual({ done: 0, total: 4 });
  });

  test("la forma vecchia non ha progresso, e non lo inventa", () => {
    expect(parseChecksProgress(JSON.stringify([{ cmd: "x", ok: true }]))).toBeNull();
  });

  test("numeri incoerenti = null: «3 su 0» a schermo e' peggio del silenzio", () => {
    for (const p of [
      { done: 3, total: 0 },   // totale impossibile
      { done: 5, total: 3 },   // piu' fatti che dichiarati
      { done: -1, total: 3 },  // negativo
      { done: 1 },             // manca il totale
      { total: 3 },            // manca il fatto
    ]) {
      expect(parseChecksProgress(JSON.stringify({ progress: p, runs: [] })), JSON.stringify(p)).toBeNull();
    }
  });

  test("un NaN non passa: attraverserebbe tutto fino alla card", () => {
    // `JSON.stringify` scrive `null` per NaN, ed e' proprio il caso da fermare.
    expect(parseChecksProgress('{"progress":{"done":null,"total":3},"runs":[]}')).toBeNull();
    expect(parseChecksProgress('{"progress":{"done":"2","total":"5"},"runs":[]}')).toBeNull();
  });

  test("JSON storto o vuoto: null, senza esplodere", () => {
    expect(parseChecksProgress("{rotto")).toBeNull();
    expect(parseChecksProgress("")).toBeNull();
    expect(parseChecksProgress(undefined)).toBeNull();
  });
});
