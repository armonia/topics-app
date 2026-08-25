/**
 * Il contratto di "archiviato", provato sul servizio che ora lo definisce.
 *
 * Il bug che questi test presidiano non era una riga sbagliata: era che
 * `archiveTopic` (percorso del dispatcher) faceva UN passo su tre, e lo faceva
 * in silenzio. Un test che guardi solo `archived === true` sarebbe passato
 * anche prima. Quindi qui si asserisce lo stato finale COMPLETO — flag, unread,
 * ui_state — perché è quello che la parzialità rompeva.
 * @covers TOPIC-01
 */
import { describe, it, expect } from "bun:test";
import { archiveTopicFully, type ArchiveTopicDeps } from "./archive-topic";
import type { Topic, UnreadData } from "../../shared/types";

function makeTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: "t1",
    title: "Un topic",
    sessionKey: "sk1",
    projectPath: "/tmp/p",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    archived: false,
    ...over,
  } as Topic;
}

interface Harness {
  deps: ArchiveTopicDeps;
  saved: Topic[];
  unread: UnreadData;
  broadcasts: { type: string; [k: string]: unknown }[];
  purged: string[];
  parked: string[];
}

function harness(opts: { topic?: Topic | null; purgeFails?: string } = {}): Harness {
  const topic = opts.topic === undefined ? makeTopic() : opts.topic;
  const saved: Topic[] = [];
  const unread: UnreadData = { t1: { lastReadAt: "2026-07-01T00:00:00.000Z", unreadCount: 7 } };
  const broadcasts: { type: string; [k: string]: unknown }[] = [];
  const purged: string[] = [];
  const parked: string[] = [];
  return {
    saved, unread, broadcasts, purged, parked,
    deps: {
      parkClaudeSession: (sk) => { parked.push(sk); },
      getTopicById: (id) => (topic && topic.id === id ? topic : null),
      saveSingleTopic: (t) => { saved.push(t); },
      loadUnread: () => unread,
      saveUnread: (d) => { Object.assign(unread, d); },
      broadcastToAll: (m) => { broadcasts.push(m as never); },
      purgeFromUiState: (id) => {
        purged.push(id);
        return opts.purgeFails ? { ok: false, error: opts.purgeFails } : { ok: true };
      },
    },
  };
}

describe("archiveTopicFully", () => {
  it("fa tutti e tre i passi: flag, unread a zero, purge di ui_state", () => {
    const h = harness();
    const res = archiveTopicFully(h.deps, "t1");

    expect(res.ok).toBe(true);
    expect(res.topic?.archived).toBe(true);
    expect(h.saved).toHaveLength(1);
    // Il passo che il percorso del dispatcher saltava, e da cui venivano i 427
    // non-letti appesi a 170 topic archiviati.
    expect(h.unread.t1?.unreadCount).toBe(0);
    // Il passo che mancava e faceva risuscitare l'id al reload successivo.
    expect(h.purged).toEqual(["t1"]);
  });

  // Il quarto passo. Senza, la fase Claude del topic resta viva per sempre: una
  // `awaiting-user` non si spegne da sola (per scelta) e un topic archiviato non
  // ha più né riga né tab da cui spegnerla, mentre i due reconcile di boot
  // filtrano `archived = 0`. Misurate il 2026-08-09: 28 sessioni così, 20 su
  // «tocca a te», ultima attività a metà luglio.
  it("parcheggia la sessione Claude del topic", () => {
    const h = harness();
    archiveTopicFully(h.deps, "t1");
    expect(h.parked).toEqual(["sk1"]);
  });

  it("parcheggia ANCHE su un topic già archiviato: ri-archiviare deve riparare", () => {
    // È l'unica leva che le sessioni già trapelate hanno senza una query a mano
    // — stessa logica convergente dei passi 2 e 3.
    const h = harness({ topic: makeTopic({ archived: true }) });
    h.unread.t1 = { lastReadAt: "2026-07-01T00:00:00.000Z", unreadCount: 0 };
    archiveTopicFully(h.deps, "t1");
    expect(h.parked).toEqual(["sk1"]);
  });

  it("un topic senza sessionKey non fa partire nessun parcheggio", () => {
    const h = harness({ topic: makeTopic({ sessionKey: undefined }) });
    archiveTopicFully(h.deps, "t1");
    expect(h.parked).toEqual([]);
  });

  it("broadcasta sia l'archiviazione sia l'unread azzerato", () => {
    const h = harness();
    archiveTopicFully(h.deps, "t1");
    const types = h.broadcasts.map((b) => b.type);
    expect(types).toContain("topic:archived");
    // Senza questo, il badge resta acceso nei client già connessi finché non
    // ricaricano: lo stato sul disco è giusto e quello a schermo no.
    expect(types).toContain("unread:updated");
    const u = h.broadcasts.find((b) => b.type === "unread:updated");
    expect(u).toMatchObject({ topicId: "t1", unreadCount: 0 });
  });

  it("già archiviato e pulito: non riscrive il flag né ribroadcasta", () => {
    const h = harness({ topic: makeTopic({ archived: true }) });
    h.unread.t1 = { lastReadAt: "2026-07-01T00:00:00.000Z", unreadCount: 0 };
    const res = archiveTopicFully(h.deps, "t1");

    expect(res.ok).toBe(true);
    expect(res.alreadyArchived).toBe(true);
    expect(res.repaired).toBe(false);
    expect(h.saved).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("già archiviato ma con badge appeso: RIPARA (è la bonifica del 03/08)", () => {
    // Lo stato che il percorso del dispatcher lasciava dietro: archiviato sì,
    // ma con l'unread ancora acceso su una conversazione non più apribile.
    const h = harness({ topic: makeTopic({ archived: true }) });
    expect(h.unread.t1?.unreadCount).toBe(7);

    const res = archiveTopicFully(h.deps, "t1");

    expect(res.repaired).toBe(true);
    expect(h.unread.t1?.unreadCount).toBe(0);
    // Il flag non si tocca (era già giusto): niente `topic:archived` di troppo.
    expect(h.saved).toHaveLength(0);
    expect(h.broadcasts.map((b) => b.type)).toEqual(["unread:updated"]);
    // La purge gira comunque: il ghost-topic è indipendente dall'unread.
    expect(h.purged).toEqual(["t1"]);
  });

  it("topic inesistente: notFound, nessuna scrittura", () => {
    const h = harness({ topic: null });
    const res = archiveTopicFully(h.deps, "t1");

    expect(res.ok).toBe(false);
    expect(res.notFound).toBe(true);
    expect(h.saved).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("purge fallita: il topic resta archiviato ma l'errore ESCE, non si perde", () => {
    const h = harness({ purgeFails: "disco pieno" });
    const res = archiveTopicFully(h.deps, "t1");

    // Archiviato davvero: i primi due passi sono già committati.
    expect(res.ok).toBe(true);
    expect(res.topic?.archived).toBe(true);
    expect(h.unread.t1?.unreadCount).toBe(0);
    // Ma il chiamante DEVE poterlo sapere: è il caso in cui l'id fantasma
    // ritorna al reload, e un fallimento silenzioso qui è indistinguibile dal
    // successo finché l'utente non vede la tab risorgere.
    expect(res.purgeError).toBe("disco pieno");
  });

  it("l'unread degli altri topic non viene toccato", () => {
    const h = harness();
    h.unread.altro = { lastReadAt: "2026-07-01T00:00:00.000Z", unreadCount: 3 };
    archiveTopicFully(h.deps, "t1");
    expect(h.unread.altro?.unreadCount).toBe(3);
  });
});
