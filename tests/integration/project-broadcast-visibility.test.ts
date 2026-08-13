/**
 * IL FILO, NON L'ELENCO.
 *
 * `projects-org-visibility.test.ts` prova che `GET /api/projects` non consegna
 * più tutto a chiunque. Questo prova la metà che mancava: che il BROADCAST
 * subito dopo la stessa mutazione non lo rimetta in chiaro. Fino a questa
 * consegna `project:new`/`project:updated`/`project:archived` uscivano da
 * `broadcastToAll` — un payload solo, uguale per ogni socket connessa, con nome
 * e path dentro — quindi l'elenco filtrato durava fino al primo rename.
 *
 * Si guarda la STRINGA che parte, non l'oggetto che il codice pensa di mandare:
 * il difetto è una fuga, e una fuga si misura su ciò che entra nel socket. Per
 * questo le asserzioni che contano sono `not.toContain(NOME)` e
 * `not.toContain(PATH)` sui payload grezzi.
 *
 * Le socket sono finte perché l'unica cosa che serve di una `ServerWebSocket` è
 * `readyState`, `data` (dove sta il dispositivo, timbrato all'upgrade) e `send`.
 * Il resto della catena è vero: la rotta vera, la fan-out vera, il DB vero con
 * le migration vere.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import * as fs from "node:fs";
import type { Database } from "bun:sqlite";
import type { AppContext, RouteHandler } from "../../server/types";
import { isGuestSafeFrameType, frameResource } from "../../server/lib/grants";
import { join } from "node:path";
import { PROJECT_ROOT, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("project-broadcast");
const TEST_DATA = join(ROOT, "data");
const DIR_CONDIVISO = join(ROOT, "condiviso");
const DIR_SEGRETO = join(ROOT, "segreto");

// ── Socket finte ───────────────────────────────────────────────────────────

interface SocketFinta {
  readyState: number;
  data: {
    id: string;
    deviceId: string | null;
    deviceRole: "owner" | "guest" | null;
    focusedTopicId: null;
    lastPong: number;
  };
  /** I payload COSÌ COME SONO PARTITI: è lì che si vede se un nome è uscito. */
  grezzi: string[];
  send(payload: string): void;
}

function socketFinta(
  id: string,
  deviceId: string | null,
  deviceRole: "owner" | "guest" | null = "owner",
): SocketFinta {
  const s: SocketFinta = {
    readyState: 1,
    data: { id, deviceId, deviceRole, focusedTopicId: null, lastPong: 0 },
    grezzi: [],
    send(payload: string) { s.grezzi.push(payload); },
  };
  return s;
}

interface FrameProgetto {
  type: string;
  project: { id: string; name?: string; path?: string };
  payload_version?: number;
}
const frames = (s: SocketFinta): FrameProgetto[] => s.grezzi.map((g) => JSON.parse(g) as FrameProgetto);
const tipi = (s: SocketFinta): string[] => frames(s).map((f) => f.type);
const tutto = (s: SocketFinta): string => s.grezzi.join("\n");

// ── Abitanti ───────────────────────────────────────────────────────────────

/** Una persona in più, col suo dispositivo. `proprietario` = sta in
 *  `installation_owners`, che è l'unica cosa che decide il ruolo (084). */
function collega(
  db: Database,
  id: string,
  orgId: string,
  opts: { proprietario?: boolean; ruoloDispositivo?: "owner" | "guest" } = {},
): string {
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [id, id]);
  db.run(
    "INSERT INTO org_members (org_id, person_id, role, joined_at, updated_at) VALUES (?, ?, 'member', 0, 0)",
    [orgId, id],
  );
  if (opts.proprietario) {
    db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES (?, 0, 0)", [id]);
  }
  const dev = `dev-${id}`;
  db.run(
    `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, role, person_id)
     VALUES (?, ?, ?, 0, 0, ?, ?)`,
    [dev, `Mac di ${id}`, `hash-${id}`, opts.ruoloDispositivo ?? "owner", id],
  );
  return dev;
}

// ── Chiamate alla rotta vera ───────────────────────────────────────────────

function chiama(router: RouteHandler, path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://127.0.0.1:3333${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

describe("i frame di un progetto sanno chi hanno davanti", () => {
  let ctx: AppContext;
  let router: RouteHandler;
  let orgId: string;
  let devMircea: string;   // stessa org, NON proprietario dell'installazione
  let devEstraneo: string; // un'altra org
  let devOspite: string;   // dispositivo appaiato come ospite

  beforeAll(async () => {
    // Il DB di `server/db.ts` è un singleton di processo: chiuderlo prima di
    // puntare DATA_DIR è l'unico modo per non ereditare quello aperto da un
    // altro file di test (e per non lasciare il mio a chi viene dopo).
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
    setupTestDataDir(TEST_DATA);
    for (const d of [DIR_CONDIVISO, DIR_SEGRETO]) fs.mkdirSync(d, { recursive: true });

    const { createAppContext } = await import("../../server/utils");
    const { createProjectsRouter } = await import("../../server/routes/projects");
    ctx = createAppContext(PROJECT_ROOT);
    router = createProjectsRouter(ctx);

    // L'org e la persona che la 084 crea da sé: lette, non indovinate.
    orgId = (ctx.db.query("SELECT org_id FROM installation WHERE singleton = 1").get() as { org_id: string }).org_id;
    devMircea = collega(ctx.db, "mircea", orgId);
    ctx.db.run("INSERT INTO orgs (id, name, created_at, updated_at) VALUES ('altra', 'Altra', 0, 0)");
    devEstraneo = collega(ctx.db, "estraneo", "altra");
    devOspite = collega(ctx.db, "ospite", orgId, { ruoloDispositivo: "guest" });
  });

  afterAll(async () => {
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    ctx.db.run("DELETE FROM projects");
    ctx.wsClients.clear();
    ctx.setGuestBroadcastFilter(null);
  });

  /** Le tre socket che contano, già collegate. */
  function collega3() {
    const macchina = socketFinta("ws-loopback", null);
    const mircea = socketFinta("ws-mircea", devMircea);
    const estraneo = socketFinta("ws-estraneo", devEstraneo);
    for (const s of [macchina, mircea, estraneo]) ctx.wsClients.add(s as never);
    return { macchina, mircea, estraneo };
  }

  /** Crea un progetto dalla rotta (loopback = la macchina) e torna la riga. */
  async function crea(name: string, path: string): Promise<{ id: string }> {
    const r = await chiama(router, "/api/projects", "POST", { name, path });
    expect(r!.status).toBe(201);
    return (await r!.json()) as { id: string };
  }

  test("un progetto d'org: la riga a chi è dell'org, la ritratta all'estraneo", async () => {
    const { macchina, mircea, estraneo } = collega3();
    const p = await crea("Condiviso", DIR_CONDIVISO);

    expect(frames(macchina)).toEqual([
      expect.objectContaining({ type: "project:new", project: expect.objectContaining({ name: "Condiviso" }) }),
    ]);
    expect(frames(mircea)[0]!.project.name).toBe("Condiviso");
    // Chi non ha nessuna org in comune riceve l'id e nient'altro.
    expect(frames(estraneo)).toEqual([{ type: "project:deleted", project: { id: p.id }, payload_version: 1 }]);
    expect(tutto(estraneo)).not.toContain("Condiviso");
    expect(tutto(estraneo)).not.toContain(DIR_CONDIVISO);
  });

  test("marcato incognito: al compagno d'org parte la RITRATTA, non la riga", async () => {
    const p = await crea("Segreto", DIR_SEGRETO);
    // Le socket entrano DOPO la creazione: qui si guarda solo la modifica.
    const { macchina, mircea, estraneo } = collega3();

    const r = await chiama(router, `/api/projects/${p.id}`, "PATCH", { incognito: true });
    expect(r!.status).toBe(200);

    // La macchina — che è chi l'ha marcato — continua a vedere la riga intera.
    expect(frames(macchina)[0]).toEqual(
      expect.objectContaining({ type: "project:updated", project: expect.objectContaining({ name: "Segreto" }) }),
    );
    // E il compagno d'org, che fino a un istante prima lo vedeva, riceve la
    // sparizione: senza, la riga gli resterebbe sullo schermo — con nome e path
    // — fino al prossimo `GET /api/projects`.
    expect(frames(mircea)).toEqual([{ type: "project:deleted", project: { id: p.id }, payload_version: 1 }]);
    for (const s of [mircea, estraneo]) {
      expect(tutto(s)).not.toContain("Segreto");
      expect(tutto(s)).not.toContain(DIR_SEGRETO);
    }
  });

  test("un incognito che cambia nome o si archivia non torna in chiaro", async () => {
    const p = await crea("Segreto", DIR_SEGRETO);
    await chiama(router, `/api/projects/${p.id}`, "PATCH", { incognito: true });
    const { macchina, mircea, estraneo } = collega3();

    const rinomina = await chiama(router, `/api/projects/${p.id}`, "PATCH", { name: "Segreto rinominato" });
    expect(rinomina!.status).toBe(200);
    const archivia = await chiama(router, `/api/projects/${p.id}/archive`, "POST");
    expect(archivia!.status).toBe(200);
    const ripristina = await chiama(router, `/api/projects/${p.id}/restore`, "POST");
    expect(ripristina!.status).toBe(200);

    expect(tipi(macchina)).toEqual(["project:updated", "project:archived", "project:updated"]);
    // Tre mutazioni, tre ritratte: nessuna scorciatoia che salta il filtro.
    for (const s of [mircea, estraneo]) {
      expect(tipi(s)).toEqual(["project:deleted", "project:deleted", "project:deleted"]);
      expect(tutto(s)).not.toContain("Segreto");
      expect(tutto(s)).not.toContain(DIR_SEGRETO);
    }
  });

  test("un OSPITE non riceve nemmeno la ritratta", async () => {
    // Il filtro vero, nella forma che innesta `server.ts`: `project:*` non è fra
    // i tipi ammessi a un ospite, quindi cade prima di qualunque valutazione di
    // visibilità. Il filtro degli ospiti resta il primo dei due.
    ctx.setGuestBroadcastFilter({
      mayReceiveFrame(_deviceId, message) {
        const tipo = (message as { type?: unknown }).type;
        if (typeof tipo !== "string" || !isGuestSafeFrameType(tipo)) return false;
        return frameResource(message) !== null;
      },
      mayReadTopic: () => false,
    });
    const ospite = socketFinta("ws-ospite", devOspite, "guest");
    ctx.wsClients.add(ospite as never);
    const { macchina } = collega3();

    await crea("Condiviso", DIR_CONDIVISO);

    expect(ospite.grezzi).toEqual([]);
    expect(tipi(macchina)).toEqual(["project:new"]);
  });

  test("due finestre dello stesso dispositivo ricevono entrambe", async () => {
    // L'osservatore è in cache PER DISPOSITIVO, non per socket: la cache deve
    // risparmiare due query, non saltare una finestra.
    const uno = socketFinta("ws-mircea-1", devMircea);
    const due = socketFinta("ws-mircea-2", devMircea);
    const chiusa = socketFinta("ws-mircea-chiusa", devMircea);
    chiusa.readyState = 3;
    for (const s of [uno, due, chiusa]) ctx.wsClients.add(s as never);

    await crea("Condiviso", DIR_CONDIVISO);

    expect(frames(uno)[0]!.project.name).toBe("Condiviso");
    expect(frames(due)[0]!.project.name).toBe("Condiviso");
    expect(chiusa.grezzi).toEqual([]);
  });

  test("la cancellazione porta solo l'id, e va a tutti", async () => {
    // `project:deleted` resta su `broadcastToAll`: è già la forma ridotta, e la
    // riga non c'è più — non ci sarebbe niente da valutare.
    const p = await crea("Condiviso", DIR_CONDIVISO);
    const { macchina, mircea, estraneo } = collega3();

    const r = await chiama(router, `/api/projects/${p.id}`, "DELETE");
    expect(r!.status).toBe(200);
    for (const s of [macchina, mircea, estraneo]) {
      expect(frames(s)).toEqual([{ type: "project:deleted", project: { id: p.id }, payload_version: 1 }]);
    }
  });
});
