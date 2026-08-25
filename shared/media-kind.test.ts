/**
 * @covers MEDIA-04
 */
import { describe, test, expect } from "bun:test";
import { isVideoPath, isImagePath, isPdfPath, isPreviewablePath } from "./media-kind";

describe("media-kind — che cosa è un allegato", () => {
  test("i tre rami del protocollo si riconoscono, con query e hash addosso", () => {
    expect(isImagePath("/m/schermata.png")).toBe(true);
    expect(isImagePath("/m/schema.svg?v=2")).toBe(true);
    expect(isVideoPath("/m/clip.webm#t=3")).toBe(true);
    expect(isVideoPath("/m/prova.MP4")).toBe(true);
  });

  test("un video non è un'immagine e viceversa: era la confusione che rompeva il drawer", () => {
    expect(isImagePath("/m/clip.webm")).toBe(false);
    expect(isVideoPath("/m/schermata.png")).toBe(false);
  });

  test("il PDF si riconosce, ma NON è un'anteprima", () => {
    expect(isPdfPath("/m/relazione.pdf")).toBe(true);
    // La distinzione che mancava al server: allegato sì, anteprima no. Messo in
    // `preview_image` finiva in un `<img src=…pdf>`, cioè un'icona rotta.
    expect(isPreviewablePath("/m/relazione.pdf")).toBe(false);
  });

  test("mostrabile = esiste un elemento che lo apre; tutto il resto no", () => {
    expect(isPreviewablePath("/m/schermata.png")).toBe(true);
    expect(isPreviewablePath("/m/schema.svg")).toBe(true);
    expect(isPreviewablePath("/m/clip.webm")).toBe(true);
    expect(isPreviewablePath("/m/consegna.zip")).toBe(false);
    expect(isPreviewablePath("/m/note")).toBe(false);
    expect(isPreviewablePath(null)).toBe(false);
    expect(isPreviewablePath(undefined)).toBe(false);
  });

  test("l'estensione si legge in fondo, non ovunque: un .pdf nel NOME non basta", () => {
    expect(isPdfPath("/m/pdf-del-piano.png")).toBe(false);
    expect(isPreviewablePath("/m/pdf-del-piano.png")).toBe(true);
  });
});
