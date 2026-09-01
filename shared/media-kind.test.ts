/**
 * @covers MEDIA-04
 */
import { describe, test, expect } from "bun:test";
import { isVideoPath, isImagePath, isPdfPath, isPreviewablePath, isAutoCapturedPreview, isDeliverySheetPath } from "./media-kind";

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

describe("a photo we took ourselves is not somebody's evidence", () => {
  // The difference is not provenance, it is what the photo PROVES. The agent's
  // evidence is a screen chosen to show the change; an auto-capture is the app
  // booted from the right branch and photographed wherever it was — usually its
  // own landing page. Measured 2026-09-01 on two cards in review: the «account
  // panel» one portrayed the «Welcome to Topics» screen, the «remove profile
  // tab» one portrayed the kanban.
  test("the server's own screenshots are recognised by their directory", () => {
    expect(isAutoCapturedPreview("/Users/x/.openclaw/media/task-previews/abc.png")).toBe(true);
    expect(isAutoCapturedPreview("/Users/x/.openclaw/media/task-previews/abc.jpeg")).toBe(true);
    expect(isAutoCapturedPreview("/Users/x/.openclaw/media/task-previews/abc.webp?v=2")).toBe(true);
  });

  test("evidence the agent attached is NOT an auto-capture", () => {
    expect(isAutoCapturedPreview("/Users/x/.topics/media/schermata-account.png")).toBe(false);
    expect(isAutoCapturedPreview("/Users/x/Projects/topics-app/test-results/shot.png")).toBe(false);
  });

  test("a delivery sheet is neither, and the two predicates never overlap", () => {
    const sheet = "/Users/x/.openclaw/media/task-sheets/abc.svg";
    expect(isDeliverySheetPath(sheet)).toBe(true);
    expect(isAutoCapturedPreview(sheet)).toBe(false);
    const shot = "/Users/x/.openclaw/media/task-previews/abc.png";
    expect(isAutoCapturedPreview(shot)).toBe(true);
    expect(isDeliverySheetPath(shot)).toBe(false);
  });

  test("nothing is not an auto-capture, and a bare name is not either", () => {
    expect(isAutoCapturedPreview(null)).toBe(false);
    expect(isAutoCapturedPreview("")).toBe(false);
    // Without the directory the name decides nothing: `task-previews` is the fact.
    expect(isAutoCapturedPreview("abc.png")).toBe(false);
  });
});
