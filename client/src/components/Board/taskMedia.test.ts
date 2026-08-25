/**
 * @covers KANBAN-54
 */
import { describe, test, expect } from "bun:test";
import { collectTaskMediaPaths } from "./taskMedia";
import { isVideoPath, isImagePath, isPdfPath } from "../../lib/mediaKind";
import { mediaPaneIdFor } from "./constants";

/**
 * «All'anteprima attuale dovresti aggiungere la possibilità di aprirla su tab»
 * (Attilio, 2026-08-03).
 *
 * La tab non andava inventata: il drawer del task compone già una pane per
 * ogni allegato. Mancava che l'anteprima FOSSE un allegato — arrivando da
 * `previewImage` e non da un commento, restava fuori dalla lista e quindi
 * fuori dalle tab.
 */

describe("collectTaskMediaPaths", () => {
  test("l'anteprima c'è, ed è la prima", () => {
    const out = collectTaskMediaPaths("/m/shot.png", [{ media: ["/m/a.pdf"] }]);
    expect(out[0]).toBe("/m/shot.png");
    expect(out).toEqual(["/m/shot.png", "/m/a.pdf"]);
  });

  test("l'anteprima ha comunque UNA sola tab anche se è pure allegata al thread", () => {
    // Il caso vero: l'agente allega lo screenshot al commento di consegna E lo
    // imposta come previewImage. Due tab identiche sarebbero un difetto.
    const out = collectTaskMediaPaths("/m/shot.png", [{ media: ["/m/shot.png", "/m/log.txt"] }]);
    expect(out).toEqual(["/m/shot.png", "/m/log.txt"]);
  });

  test("i commenti vengono dal più recente", () => {
    const out = collectTaskMediaPaths(null, [{ media: ["/m/vecchio.png"] }, { media: ["/m/nuovo.png"] }]);
    expect(out).toEqual(["/m/nuovo.png", "/m/vecchio.png"]);
  });

  test("senza anteprima e senza allegati: lista vuota, non una voce fantasma", () => {
    expect(collectTaskMediaPaths(null, [])).toEqual([]);
    expect(collectTaskMediaPaths(undefined, [{}, { media: [] }])).toEqual([]);
  });

  test("ogni path diventa un pane id stabile", () => {
    const out = collectTaskMediaPaths("/m/shot.png", []);
    expect(out.map(mediaPaneIdFor)).toEqual(["media:/m/shot.png"]);
  });
});

describe("mediaKind", () => {
  test("una clip di review è un video, non un'immagine", () => {
    // Era il difetto: il drawer renderizzava un <img> su un .webm (icona rotta)
    // e il visore delle tab non lo conosceva affatto.
    for (const p of ["/m/x.webm", "/m/x.mp4", "/m/x.MOV", "/m/x.m4v"]) {
      expect(isVideoPath(p)).toBe(true);
      expect(isImagePath(p)).toBe(false);
    }
  });

  test("immagini e PDF restano quello che sono", () => {
    expect(isImagePath("/m/x.png")).toBe(true);
    expect(isImagePath("/m/x.JPEG")).toBe(true);
    expect(isPdfPath("/m/x.pdf")).toBe(true);
    expect(isVideoPath("/m/x.png")).toBe(false);
  });

  test("tollera query e hash: il controllo gira anche su url già costruite", () => {
    // `getMediaUrl` produce sia /api/media/<file> sia ?path=<file>: in tutti e
    // due i casi il tipo si deve leggere lo stesso, altrimenti la stessa clip
    // si comporta diversamente a seconda di chi ha costruito l'url.
    expect(isVideoPath("/api/media/x.webm?v=2")).toBe(true);
    expect(isVideoPath("/api/media?path=/m/x.webm")).toBe(true);
    expect(isImagePath("/api/media/x.png#top")).toBe(true);
    // Un'estensione che compare a metà strada NON conta: decide il suffisso.
    expect(isVideoPath("/m/webm-notes/x.png")).toBe(false);
  });

  test("niente path, niente tipo", () => {
    expect(isVideoPath(null)).toBe(false);
    expect(isImagePath(undefined)).toBe(false);
    expect(isPdfPath("")).toBe(false);
  });
});
