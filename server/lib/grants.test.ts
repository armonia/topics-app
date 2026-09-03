/**
 * The three allowlists a guest's traffic is filtered through: which HTTP paths
 * it may reach, which methods, and which WebSocket frame types may leave
 * towards it (plus which socket is confined at all).
 *
 * @covers GUEST-01, GUEST-02, GUEST-04
 */
import { describe, expect, it } from "bun:test";
import {
  isGuestAllowedPath, isGuestSafeFrameType, frameResource, isResourceType, RESOURCE_TYPES,
  isGuestSocketData, isGuestAllowedMethod, isGuestHandshakeFrame, isGuestInboundFrameAllowed,
} from "./grants";
import { REGISTERED_OUTBOUND_TYPES } from "../../shared/ws-outbound";
import { chatWsInboundSchema } from "../schemas/chat-ws-inbound";

describe("grants · tipi di risorsa", () => {
  it("solo cio' che ha una riga vera a cui appendere un permesso", () => {
    expect(RESOURCE_TYPES).toEqual(["task", "topic", "project"]);
    expect(isResourceType("task")).toBe(true);
    expect(isResourceType("topic")).toBe(true);
    // `project` è entrato con 20260816230500. La regola non è cambiata, è
    // cambiato il fatto: `projects` È una tabella vera (migration 016) con id
    // stabile, quindi una concessione ha una riga a cui appendersi. Ciò che
    // resta fuori è fuori per la stessa ragione di prima.
    expect(isResourceType("project")).toBe(true);
  });

  it("Spazi e tab NON sono risorse: vivono in un blob, non in una riga", () => {
    // Non è una dimenticanza da colmare aggiungendo una stringa: senza una riga
    // e una FK, una concessione punterebbe a un id che il server non sa
    // verificare né cancellare in cascata.
    //
    // `project` è uscito da questa lista quando ha smesso di essere vero per
    // lui: ha la sua tabella. Gli altri no — uno spazio e una tab vivono dentro
    // un blob di ui_state, e un terminale o un browser sono processi, non righe.
    for (const v of ["space", "pane", "tab", "terminal", "browser", ""]) {
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
      "/api/topics/abc/messages",
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

  it("a shared chat opens its messages, NOT the project's introspection routes", () => {
    // A prefix match on `/api/topics/` let a guest holding one chat GET the
    // project's CLAUDE.md/README/AGENTS.md (`context-preview`), the agent's
    // tool and MCP configuration (`environment`) and the checkpoint history:
    // all GETs, all carrying the granted id, so neither the method axis nor
    // the entity axis could refuse them. Only the path can, and only if it is
    // exact.
    for (const p of [
      "/api/topics/abc",
      "/api/topics/abc/context-preview",
      "/api/topics/abc/context-snapshots",
      "/api/topics/abc/environment",
      "/api/topics/abc/checkpoints",
      "/api/topics/abc/turn-checkpoints",
      "/api/topics/abc/project-id",
      "/api/topics/abc/goal",
      "/api/topics/abc/messages/extra",
      "/api/topics/messages",
    ]) {
      expect(`${p}:${isGuestAllowedPath(p)}`).toBe(`${p}:false`);
    }
    expect(isGuestAllowedPath("/api/topics/abc/messages")).toBe(true);
    expect(isGuestAllowedPath("/api/topics/topic%3Aabc/messages")).toBe(true);
  });
});

describe("grants · i frame che un ospite può MANDARE", () => {
  // The inbound mirror of the outbound allowlist. Every type of the inbound
  // schema is listed on one side or the other, so a new frame type has to be
  // placed deliberately, and lands on the closed side by default.
  const inboundTypes = chatWsInboundSchema.options.map((o) => o.shape.type.value as string);
  const allowed = ["ping", "hello", "focus", "subscribe"];

  it("keepalive, handshake and routing hints pass", () => {
    for (const t of allowed) {
      expect(inboundTypes).toContain(t);
      expect(isGuestInboundFrameAllowed(t)).toBe(true);
    }
  });

  it("typing, drag and presence do NOT: they reach the owner's windows without a grant", () => {
    // `typing` fans out to every socket focused on the topic named in the
    // frame, shared or not; `drag:drop` can close a panel in an owner window
    // whose id it names; `presence:announce` fills the owner's roster.
    const refused = inboundTypes.filter((t) => !allowed.includes(t));
    expect(refused.sort()).toEqual(["drag:drop", "drag:end", "drag:start", "presence:announce", "typing"]);
    for (const t of refused) {
      expect(`${t}:${isGuestInboundFrameAllowed(t)}`).toBe(`${t}:false`);
    }
  });

  it("an unknown type does not pass", () => {
    expect(isGuestInboundFrameAllowed("qualcosa:di:nuovo")).toBe(false);
  });
});

describe("grants · i frame che un ospite può ricevere", () => {
  const ammessi = [
    "task:created", "task:updated", "task:deleted", "task:review-ready", "task:parked",
    "stream:start", "stream:content_chunk", "stream:end", "stream:catchup",
    "message", "message:new",
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
    const notAllowed = REGISTERED_OUTBOUND_TYPES.filter((t) => !ammessi.includes(t));
    expect(notAllowed.length).toBeGreaterThan(50);
    for (const t of notAllowed) {
      expect(isGuestSafeFrameType(t)).toBe(false);
    }
  });

  it("un tipo sconosciuto non passa", () => {
    expect(isGuestSafeFrameType("qualcosa:di:nuovo")).toBe(false);
  });
});

describe("grants · la stretta di mano, che scavalca il confinamento", () => {
  // Questa lista è una DEROGA: ciò che sta qui arriva a un ospite senza nessun
  // controllo di entità. Il criterio non è «serve al client» — è «non contiene
  // niente di nessuno». I test qui sotto sono la guardia contro il modo in cui
  // una lista così si allarga: un frame che serviva, aggiunto senza guardare
  // cosa porta dentro.
  it("è corta, e ci sta solo protocollo", () => {
    for (const t of ["connected", "welcome", "ui:bundle-rev"]) {
      expect(isGuestHandshakeFrame(t)).toBe(true);
    }
  });

  it("NON ci sta niente che porti dati: sono i tre frame del buco vero", () => {
    // Questi tre erano ciò che la raffica di apertura consegnava a un ospite
    // prima che passasse dal filtro: il pane-store del proprietario coi titoli
    // e gli id di ogni chat, i non-letti di tutte, e la configurazione della
    // macchina. Se un giorno uno di questi finisce nella deroga, questo test
    // muore — ed è l'unico posto in cui morirebbe.
    for (const t of ["ui-state:init", "unread:init", "providers:snapshot"]) {
      expect(isGuestHandshakeFrame(t)).toBe(false);
    }
  });

  it("la deroga è CHIUSA: tutto il resto del registro ne resta fuori", () => {
    // `connected` e `welcome` stanno nel registro outbound e nella deroga: è
    // giusto, sono protocollo. Quindi l'invariante non è «niente del registro»
    // — è che la deroga sia esattamente questi tre nomi e nient'altro.
    // Aggiungerne uno costringe a cambiare QUESTA riga, che è la deliberazione
    // che si vuole.
    const deroga = ["connected", "welcome", "ui:bundle-rev"];
    for (const t of REGISTERED_OUTBOUND_TYPES.filter((x) => !deroga.includes(x))) {
      expect(`${t}:${isGuestHandshakeFrame(t)}`).toBe(`${t}:false`);
    }
  });

  it("un frame della deroga non porta MAI un'entità dentro di sé", () => {
    // È il criterio dietro la lista, reso eseguibile: se un frame di stretta di
    // mano cominciasse a portare un `topicId` o un `taskId`, vorrebbe dire che
    // ha smesso di essere trasporto — e passerebbe comunque, senza controllo.
    for (const f of [
      { type: "connected", clientId: "x" },
      { type: "welcome", serverVersion: "1", protocolVersion: 1 },
      { type: "ui:bundle-rev", rev: "/assets/a.js" },
    ]) {
      expect(frameResource(f)).toBeNull();
    }
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

describe("grants · quale socket va confinata", () => {
  it("il loopback non è un ospite: è il computer stesso", () => {
    expect(isGuestSocketData({ deviceId: null, deviceRole: null })).toBe(false);
    expect(isGuestSocketData({})).toBe(false);
  });

  it("un PROPRIETARIO remoto non va filtrato — ed è il guasto che questo test presidia", () => {
    // L'upgrade timbra `deviceId` su ogni dispositivo appaiato, proprietari
    // compresi. Finché la domanda era «ha un id?», il telefono del proprietario
    // rispondeva sì, non aveva concessioni (non gliene servono) e si vedeva
    // cadere OGNI frame: l'app viva sul computer e ferma sul telefono.
    expect(isGuestSocketData({ deviceId: "d-telefono", deviceRole: "owner" })).toBe(false);
  });

  it("un ospite va filtrato", () => {
    expect(isGuestSocketData({ deviceId: "d-ospite", deviceRole: "guest" })).toBe(true);
  });

  it("un ruolo che non riconosciamo vale OSPITE", () => {
    // Il verso prudente è quello che consegna meno: l'altro consegna tutto.
    expect(isGuestSocketData({ deviceId: "d", deviceRole: undefined })).toBe(true);
    expect(isGuestSocketData({ deviceId: "d", deviceRole: null })).toBe(true);
  });
});

describe("grants · un ospite legge e basta", () => {
  it("le letture passano", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isGuestAllowedMethod("/api/tasks/abc", m)).toBe(true);
    }
  });

  it("le SCRITTURE no — è il terzo asse, e mancava", () => {
    // `level='read'` esisteva nello schema, nel CHECK e nel tipo, e nessuno lo
    // faceva valere: il gate autorizzava il sostantivo (il percorso, poi
    // l'entità) e mai il verbo. Un ospite poteva quindi modificare, commentare
    // o cancellare la scheda che gli avevi condiviso — mentre la sua schermata
    // gli diceva «sola lettura».
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isGuestAllowedMethod("/api/tasks/abc", m)).toBe(false);
      expect(isGuestAllowedMethod("/api/topics/abc", m)).toBe(false);
      expect(isGuestAllowedMethod("/api/messages/abc", m)).toBe(false);
    }
  });

  it("uscire è l'unica scrittura concessa", () => {
    // Negarla vorrebbe dire che l'unico modo per un ospite di andarsene è che
    // qualcun altro lo revochi.
    expect(isGuestAllowedMethod("/api/auth/logout", "POST")).toBe(true);
    // E vale solo per quel percorso, non per tutto ciò che sta sotto /api/auth.
    expect(isGuestAllowedMethod("/api/auth/shares", "POST")).toBe(false);
    expect(isGuestAllowedMethod("/api/auth/devices/x", "DELETE")).toBe(false);
  });
});
