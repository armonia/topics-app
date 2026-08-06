import { describe, expect, it } from "bun:test";
import {
  isGuestAllowedPath, isGuestSafeFrameType, frameResource, isResourceType, RESOURCE_TYPES,
} from "./grants";
import { REGISTERED_OUTBOUND_TYPES } from "../../shared/ws-outbound";

describe("grants · tipi di risorsa", () => {
  it("solo cio' che ha una riga vera a cui appendere un permesso", () => {
    expect(RESOURCE_TYPES).toEqual(["task", "topic"]);
    expect(isResourceType("task")).toBe(true);
    expect(isResourceType("topic")).toBe(true);
  });

  it("Spazi e tab NON sono risorse: vivono in un blob, non in una riga", () => {
    // Non è una dimenticanza da colmare aggiungendo una stringa: senza una riga
    // e una FK, una concessione punterebbe a un id che il server non sa
    // verificare né cancellare in cascata.
    for (const v of ["space", "pane", "tab", "project", "terminal", "browser", ""]) {
      expect(isResourceType(v)).toBe(false);
    }
  });
});

describe("grants · la superficie HTTP di un ospite", () => {
  it("apre le schede, le chat, la sessione, le anteprime e il socket", () => {
    for (const p of [
      "/api/all-boards/tasks",
      "/api/tasks/abc",
      "/api/tasks/abc/comments",
      "/api/topics/abc",
      "/api/auth/shared",
      "/api/messages/abc",
      "/api/auth/session",
      "/api/auth/logout",
      "/media/anteprima.png",
      "/ws",
    ]) {
      expect(isGuestAllowedPath(p)).toBe(true);
    }
  });

  it("nega tutto il resto — un ospite non è un utente con meno voci di menu", () => {
    // Regression di un buco REALE: col filtro messo nel solo router dei task, un
    // ospite leggeva `/api/topics` per intero. Il posto giusto era il gate, e
    // questa lista è ciò che impedisce di dimenticarsene di nuovo.
    for (const p of [
      // La LISTA delle chat NON è concessa: un endpoint che restituisce un
      // INSIEME non è filtrabile da un gate, che vede il percorso e non il corpo.
      "/api/topics",
      "/api/terminal/sessions",
      "/api/projects",
      "/api/files/read",
      "/api/browser/navigate",
      "/api/auth/devices",
      "/api/auth/shares",
      "/api/all-boards/settings",
      "/api/all-boards/publish-status",
      "/preview/etc/hosts",
      "/uploads/qualcosa.png",
      "/ws/terminal/abc",
      "/ws/browser/abc",
    ]) {
      expect(isGuestAllowedPath(p)).toBe(false);
    }
  });
});

describe("grants · i frame che un ospite può ricevere", () => {
  const ammessi = [
    "task:created", "task:updated", "task:deleted", "task:review-ready", "task:parked",
    "stream:start", "stream:content_chunk", "stream:end", "message", "message:new",
  ];

  it("OGNI tipo in allowlist ESISTE nel registro outbound", () => {
    // Il presidio che vale di più in questo file. Scrivendo l'allowlist a memoria
    // avevo messo `task:comment` e `stream:delta`: nessuno dei due esiste. Un
    // tipo inventato non è un errore rumoroso — è un aggiornamento che non arriva
    // mai a un ospite, e nessuno capisce perché.
    for (const t of ammessi) {
      expect(REGISTERED_OUTBOUND_TYPES).toContain(t);
      expect(isGuestSafeFrameType(t)).toBe(true);
    }
  });

  it("tutto il resto del registro NON parte", () => {
    // ~91 tipi, di cui solo 39 portano un id di entità: un filtro che si affidasse
    // all'id lascerebbe passare i 52 che non ne hanno — git, presenza, capacità di
    // dispatch, stato dei progetti.
    const nonAmmessi = REGISTERED_OUTBOUND_TYPES.filter((t) => !ammessi.includes(t));
    expect(nonAmmessi.length).toBeGreaterThan(50);
    for (const t of nonAmmessi) {
      expect(isGuestSafeFrameType(t)).toBe(false);
    }
  });

  it("un tipo sconosciuto non passa", () => {
    expect(isGuestSafeFrameType("qualcosa:di:nuovo")).toBe(false);
  });
});

describe("grants · a quale entità appartiene un frame", () => {
  it("legge taskId e topicId, che sono i campi che il registro usa già", () => {
    expect(frameResource({ type: "task:updated", taskId: "T1" })).toEqual({ type: "task", id: "T1" });
    expect(frameResource({ type: "stream:end", topicId: "X1" })).toEqual({ type: "topic", id: "X1" });
  });

  it("null quando il frame non parla di una risorsa condivisibile", () => {
    // E `null` significa «non parte»: per un ospite, un frame senza entità non è
    // ambiguo, è escluso.
    expect(frameResource({ type: "git:status", projectPath: "/x" })).toBeNull();
    expect(frameResource({ type: "presence:windows" })).toBeNull();
    expect(frameResource(null)).toBeNull();
    expect(frameResource("stringa")).toBeNull();
    expect(frameResource({ taskId: "" })).toBeNull();
  });
});
