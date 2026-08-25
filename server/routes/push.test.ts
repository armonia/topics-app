/**
 * `/api/push/*` — la porta d'ingresso che finora non aveva clienti.
 *
 * `SELECT COUNT(*) FROM push_subscriptions` dava **0**: il push era completo in
 * ogni suo pezzo (VAPID, service worker, trigger) e nessun dispositivo si era
 * mai iscritto, quindi a porte chiuse non arrivava niente. Il primo test qui
 * sotto è quella misura, al contrario: dopo una subscribe la riga c'è e PORTA IL
 * SUO DISPOSITIVO.
 *
 * Il resto sono le due proprietà che rendono l'iscrizione governabile:
 *   · spegnere un dispositivo non ne spegne un altro (misurato sulle RIGHE,
 *     non a occhio);
 *   · una re-iscrizione non riaccende in silenzio un dispositivo spento — il
 *     browser ruota le chiavi da solo, e se quella rotazione cancellasse le
 *     preferenze l'utente vedrebbe tornare notifiche che aveva tolto.
  * @covers PUSH-01
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { deliverableSubscriptions } from "../push-recipients";
import { createAuthRouter, dimenticaPush } from "./auth";
import { createPushRouter } from "./push";
import type { AppContext } from "../types";

let tmpRoot: string;
let router: ReturnType<typeof createPushRouter>;
let authRouter: ReturnType<typeof createAuthRouter>;

/** L'identità che il gate avrebbe risolto per la richiesta in corso. `null` =
 *  loopback / nessuna identità, cioè il comportamento storico. */
let identita: { role: "owner" | "guest"; deviceId: string | null } | null = null;

function fakeCtx(): AppContext {
  return {
    get db() { return getDatabase(); },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    requestIdentity: () => identita,
  } as unknown as AppContext;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
  const url = new URL(req.url);
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`la rotta non ha risposto: ${method} ${path}`);
  return { status: res.status, body: await res.json() };
}

/** Come sopra, ma sul router dell'autenticazione: è lì che vive la revoca. */
async function callAuth(
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const req = new Request(`http://localhost${path}`, { method, headers });
  const url = new URL(req.url);
  const res = await authRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`la rotta non ha risposto: ${method} ${path}`);
  return { status: res.status, body: await res.json() };
}

/** Una subscribe verosimile: endpoint del push service, chiavi, id del dispositivo. */
function subscribe(deviceId: string, endpoint: string, ua: string) {
  return call("POST", "/api/push/subscribe", {
    endpoint,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    deviceId,
  }, { "user-agent": ua });
}

/** Un dispositivo APPAIATO in `devices`: è quello che si revoca, e non ha
 *  niente a che vedere con il `deviceId` che il client si genera da sé. */
function seedDevice(id: string): void {
  getDatabase().run(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role) " +
      "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'owner')",
    [id, `Telefono ${id}`, `hash-${id}`, Date.now(), Date.now()],
  );
}

/** Come sopra, ma appartenente a una PERSONA: è la sola forma che i gesti di
 *  gruppo (cancellare un'organizzazione, togliere un membro) sanno raggiungere. */
function seedDeviceOf(id: string, personId: string): void {
  getDatabase().run(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role, person_id) " +
      "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'owner', ?)",
    [id, `Telefono ${id}`, `hash-${id}`, Date.now(), Date.now(), personId],
  );
}

function seedPerson(id: string): void {
  const now = Date.now();
  getDatabase().run(
    "INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',1,?)",
    [id, `Persona ${id}`, now, now],
  );
}

/** Un gruppo con un amministratore e un membro. Restituisce l'id del gruppo. */
function seedOrg(orgId: string, admin: string, membro: string): string {
  const now = Date.now();
  const db = getDatabase();
  db.run("INSERT INTO orgs (id, name, created_at, origin, rev, updated_at) VALUES (?,?,?,'local',1,?)", [orgId, `Gruppo ${orgId}`, now, now]);
  db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,'owner',?,1,?)", [orgId, admin, now, now]);
  db.run("INSERT INTO org_members (org_id, person_id, role, joined_at, rev, updated_at) VALUES (?,?,'member',?,1,?)", [orgId, membro, now, now]);
  return orgId;
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

/** La misura della card, così com'è scritta nella barra. */
function countSubscriptions(): number {
  return (getDatabase().query("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n;
}

function rows(): { endpoint: string; device_id: string | null; enabled: number; when_open: string }[] {
  return getDatabase()
    .query("SELECT endpoint, device_id, enabled, when_open FROM push_subscriptions ORDER BY device_id")
    .all() as any[];
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "push-route-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
  router = createPushRouter(fakeCtx());
  authRouter = createAuthRouter(fakeCtx());
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  const db = getDatabase();
  db.run("DELETE FROM push_subscriptions");
  db.run("DELETE FROM devices");
  // Solo le righe di QUESTI test: il database nasce già con la sua
  // organizzazione d'installazione, e `installation` la referenzia — cancellare
  // tutto farebbe fallire la FOREIGN KEY e, peggio, toglierebbe la riga che
  // rende `org-1` un gruppo cancellabile. In quest'ordine perché `org_members`
  // referenzia orgs e people con ON DELETE RESTRICT.
  db.run("DELETE FROM org_members WHERE org_id LIKE 'org-%' OR person_id LIKE 'p-%'");
  db.run("DELETE FROM orgs WHERE id LIKE 'org-%'");
  db.run("DELETE FROM people WHERE id LIKE 'p-%'");
  identita = null;
});

describe("iscrizione — la porta che mancava", () => {
  test("la tabella parte a ZERO: è la diagnosi da cui nasce la card", () => {
    expect(countSubscriptions()).toBe(0);
  });

  test("dopo la subscribe la riga c'è, e porta il suo dispositivo", async () => {
    const r = await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    expect(r.status).toBe(200);
    expect(countSubscriptions()).toBe(1);

    const [row] = rows();
    expect(row.device_id).toBe("dev-iphone");
    expect(row.enabled).toBe(1);
    expect(row.when_open).toBe("native");
    // Il nome è quello che l'utente leggerà nell'elenco: mai l'endpoint.
    expect(r.body.device.label).toBe("iPhone");
    expect(r.body.device.isThisDevice).toBe(true);
  });

  test("una subscription senza chiavi è un 400, non una riga muta che non riceverà mai", async () => {
    const r = await call("POST", "/api/push/subscribe", { endpoint: "https://x/y" });
    expect(r.status).toBe(400);
    expect(countSubscriptions()).toBe(0);
  });

  test("l'endpoint ruotato SPOSTA il dispositivo, non lo raddoppia", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    await subscribe("dev-iphone", "https://web.push.apple.com/DEF-ruotato", IPHONE_UA);
    expect(countSubscriptions()).toBe(1);
    expect(rows()[0].endpoint).toBe("https://web.push.apple.com/DEF-ruotato");
  });
});

describe("preferenze PER DISPOSITIVO", () => {
  test("spegnere il telefono non spegne il Mac — misurato sulle righe", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    await subscribe("dev-mac", "https://fcm.googleapis.com/xyz", MAC_UA);
    expect(countSubscriptions()).toBe(2);

    const r = await call("POST", "/api/push/devices/prefs", { deviceId: "dev-iphone", enabled: false });
    expect(r.status).toBe(200);

    const byId = Object.fromEntries(rows().map(x => [x.device_id, x]));
    expect(byId["dev-iphone"].enabled).toBe(0);
    expect(byId["dev-mac"].enabled).toBe(1);
  });

  test("«ad app aperta» è per dispositivo, e i valori ammessi sono due", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    await subscribe("dev-mac", "https://fcm.googleapis.com/xyz", MAC_UA);

    const ok = await call("POST", "/api/push/devices/prefs", { deviceId: "dev-iphone", whenOpen: "in-app" });
    expect(ok.status).toBe(200);
    expect(ok.body.device.whenOpen).toBe("in-app");

    const byId = Object.fromEntries(rows().map(x => [x.device_id, x]));
    expect(byId["dev-iphone"].when_open).toBe("in-app");
    expect(byId["dev-mac"].when_open).toBe("native");

    const bad = await call("POST", "/api/push/devices/prefs", { deviceId: "dev-mac", whenOpen: "toast" });
    expect(bad.status).toBe(400);
    // Un valore rifiutato NON deve aver scritto niente a metà.
    expect(rows().find(x => x.device_id === "dev-mac")!.when_open).toBe("native");
  });

  test("una re-iscrizione non riaccende un dispositivo spento", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    await call("POST", "/api/push/devices/prefs", { deviceId: "dev-iphone", enabled: false, whenOpen: "in-app" });
    // Il browser ruota le chiavi da solo: è un fatto tecnico, non una revoca.
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    const [row] = rows();
    expect(row.enabled).toBe(0);
    expect(row.when_open).toBe("in-app");
  });

  test("un dispositivo che non esiste è un 404, non un ok che non ha fatto niente", async () => {
    const r = await call("POST", "/api/push/devices/prefs", { deviceId: "fantasma", enabled: false });
    expect(r.status).toBe(404);
  });
});

describe("revoca — il dispositivo revocato smette di ricevere", () => {
  /**
   * La consegna si misura su `deliverableSubscriptions`, che è la funzione da
   * cui `sendPushToAll` prende le righe: zero righe ⇒ zero chiamate al
   * trasporto, perché `webpush.sendNotification` è chiamata solo dentro il
   * `map` su quelle righe (e sopra c'è un `return` anticipato quando sono
   * zero). NON si importa `push-service`: `push-triggers.test.ts` lo sostituisce
   * con un `mock.module`, che in Bun sopravvive al file che lo dichiara — un
   * test che lo importasse riceverebbe il finto e passerebbe senza misurare.
   */
  const destinatari = () => deliverableSubscriptions(getDatabase());

  test("iscritto da un dispositivo appaiato, la riga porta la sua IDENTITÀ — non l'id del corpo", async () => {
    seedDevice("dev-1");
    identita = { role: "owner", deviceId: "dev-1" };
    // Il corpo dichiara un id completamente diverso: è quello del localStorage,
    // e chi scrive la richiesta lo sceglie. Non deve finire nella colonna su
    // cui si decide la revoca.
    await subscribe("localstorage-uuid", "https://web.push.apple.com/abc", IPHONE_UA);

    const row = getDatabase()
      .query("SELECT device_id, auth_device_id FROM push_subscriptions")
      .get() as { device_id: string; auth_device_id: string };
    expect(row.auth_device_id).toBe("dev-1");
    expect(row.device_id).toBe("localstorage-uuid");
  });

  test("revocato il dispositivo: il trasporto non ha piu' niente da spedire, e la riga non c'e' piu'", async () => {
    seedDevice("dev-1");
    identita = { role: "owner", deviceId: "dev-1" };
    await subscribe("localstorage-uuid", "https://web.push.apple.com/abc", IPHONE_UA);
    // Controllo positivo: senza, i due `toHaveLength(0)` qui sotto passerebbero
    // anche con la consegna rotta in partenza.
    expect(destinatari()).toHaveLength(1);

    const r = await callAuth("DELETE", "/api/auth/devices/dev-1");
    expect(r.status).toBe(200);

    expect(destinatari()).toHaveLength(0);
    expect(countSubscriptions()).toBe(0);
  });

  test("anche se la riga sopravvivesse, non le si consegna: il filtro e' nella query", () => {
    // La seconda meta' della difesa. Cancellare alla revoca copre i gesti che
    // passano da qui; questo copre le righe che la revoca non ha visto (una
    // revoca scritta a mano, una migration, un gesto futuro che dimentica
    // `dimenticaPush`).
    seedDevice("dev-1");
    getDatabase().run(
      "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, auth_device_id) VALUES (?, ?, ?, ?, ?)",
      ["https://web.push.apple.com/orfana", "p", "a", "localstorage-uuid", "dev-1"],
    );
    expect(destinatari()).toHaveLength(1);

    getDatabase().run("UPDATE devices SET revoked_at = ? WHERE id = ?", [Date.now(), "dev-1"]);
    expect(destinatari()).toHaveLength(0);
  });

  test("un'iscrizione senza identita' (loopback, o legacy) continua a ricevere", async () => {
    // Il Mac su cui gira il server non ha una riga in `devices` e non si
    // revoca: chiuderlo fuori sarebbe stato un esito peggiore del buco.
    identita = null;
    await subscribe("dev-mac", "https://fcm.googleapis.com/xyz", MAC_UA);
    const row = getDatabase().query("SELECT auth_device_id FROM push_subscriptions").get() as { auth_device_id: string | null };
    expect(row.auth_device_id).toBeNull();
    expect(destinatari()).toHaveLength(1);
  });

  test("lo stesso telefono che si RIAPPAIA dopo una revoca resta una riga sola", async () => {
    // L'id del localStorage sopravvive alla revoca, l'identità appaiata no. Su
    // `device_id` c'è un indice UNIQUE: se la potatura si restringesse
    // all'identità, questa seconda iscrizione sarebbe un
    // `SQLITE_CONSTRAINT_UNIQUE` invece di una riga aggiornata — misurato
    // scrivendo la restrizione e vedendola fallire proprio qui.
    seedDevice("dev-1");
    identita = { role: "owner", deviceId: "dev-1" };
    await subscribe("id-del-localstorage", "https://web.push.apple.com/prima", IPHONE_UA);

    seedDevice("dev-2");
    identita = { role: "owner", deviceId: "dev-2" };
    const r = await subscribe("id-del-localstorage", "https://web.push.apple.com/dopo-il-riappaiamento", IPHONE_UA);

    expect(r.status).toBe(200);
    expect(countSubscriptions()).toBe(1);
    const row = getDatabase().query("SELECT auth_device_id FROM push_subscriptions").get() as { auth_device_id: string };
    expect(row.auth_device_id).toBe("dev-2");
  });
});

describe("togliere dal GRUPPO non è revocare il telefono", () => {
  const destinatari = () => deliverableSubscriptions(getDatabase());

  /** Il telefono di un membro, iscritto alle push, dentro un gruppo che un
   *  amministratore sta per toccare. */
  async function scenario(): Promise<void> {
    seedPerson("p-admin");
    seedPerson("p-membro");
    seedDeviceOf("dev-admin", "p-admin");
    seedDeviceOf("dev-membro", "p-membro");
    seedOrg("org-1", "p-admin", "p-membro");
    identita = { role: "owner", deviceId: "dev-membro" };
    await subscribe("localstorage-membro", "https://web.push.apple.com/membro", IPHONE_UA);
    identita = { role: "owner", deviceId: "dev-admin" };
  }

  test("cancellare un gruppo NON cancella le push dei suoi membri", async () => {
    // Il difetto: questo gesto passava da `dispositiviDelSoggetto`, che per
    // costruzione restituisce solo dispositivi con `revoked_at IS NULL` — cioè
    // telefoni ancora appaiati. La riga di push spariva per sempre e il client
    // continuava a mostrare «iscritto», perché quello stato lo legge dal
    // browser. Sciogliere un gruppo non è ritirare l'hardware a nessuno.
    await scenario();
    expect(destinatari()).toHaveLength(1);

    const r = await callAuth("DELETE", "/api/auth/orgs/org-1");
    expect(r.status).toBe(200);

    // Il dispositivo non è stato revocato…
    const dev = getDatabase().query("SELECT revoked_at FROM devices WHERE id = 'dev-membro'").get() as { revoked_at: number | null };
    expect(dev.revoked_at).toBeNull();
    // …quindi la sua iscrizione deve essere ancora lì, e ancora consegnabile.
    expect(countSubscriptions()).toBe(1);
    expect(destinatari()).toHaveLength(1);
  });

  test("togliere un membro dal gruppo NON gli cancella le push", async () => {
    await scenario();
    const r = await callAuth("DELETE", "/api/auth/orgs/org-1/members?personId=p-membro");
    expect(r.status).toBe(200);

    const dev = getDatabase().query("SELECT revoked_at FROM devices WHERE id = 'dev-membro'").get() as { revoked_at: number | null };
    expect(dev.revoked_at).toBeNull();
    expect(countSubscriptions()).toBe(1);
    expect(destinatari()).toHaveLength(1);
  });

  test("ma REVOCARE quel dispositivo continua a cancellarle — il controllo positivo", async () => {
    // Senza questo, i due test qui sopra passerebbero anche con `dimenticaPush`
    // cancellata da tutte e quattro le chiamate.
    await scenario();
    const r = await callAuth("DELETE", "/api/auth/devices/dev-membro");
    expect(r.status).toBe(200);
    expect(countSubscriptions()).toBe(0);
  });
});

describe("il timbro sulla colonna della revoca", () => {
  const destinatari = () => deliverableSubscriptions(getDatabase());

  test("una riga LEGACY (auth_device_id NULL) viene attribuita all'apertura della card", async () => {
    // Il divario che restava: `auth_device_id` è arrivata dopo, e le righe
    // scritte prima hanno NULL — che vuol dire «consegna comunque», perché è
    // anche il caso del Mac locale. Nessuna revoca le raggiunge, e la nota «si
    // popola alla prima re-iscrizione» era falsa: la subscribe parte solo da un
    // gesto esplicito, all'avvio il client chiama solo `getSubscription()`.
    seedDevice("dev-1");
    getDatabase().run(
      "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, auth_device_id) VALUES (?,?,?,?,NULL)",
      ["https://web.push.apple.com/legacy", "p", "a", "localstorage-uuid"],
    );

    identita = { role: "owner", deviceId: "dev-1" };
    const r = await call("GET", "/api/push/devices?deviceId=localstorage-uuid");
    expect(r.status).toBe(200);

    const row = getDatabase().query("SELECT auth_device_id FROM push_subscriptions").get() as { auth_device_id: string | null };
    expect(row.auth_device_id).toBe("dev-1");

    // E adesso la revoca la raggiunge davvero: è tutto il punto del timbro.
    const rev = await callAuth("DELETE", "/api/auth/devices/dev-1");
    expect(rev.status).toBe(200);
    expect(countSubscriptions()).toBe(0);
  });

  test("il timbro non ruba le righe di un ALTRO dispositivo", async () => {
    seedDevice("dev-1");
    const db = getDatabase();
    db.run(
      "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, auth_device_id) VALUES (?,?,?,?,NULL)",
      ["https://web.push.apple.com/altro", "p", "a", "altro-localstorage"],
    );
    db.run(
      "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, auth_device_id) VALUES (?,?,?,?,?)",
      ["https://web.push.apple.com/gia-timbrata", "p", "a", "mio-localstorage", "dev-9"],
    );

    identita = { role: "owner", deviceId: "dev-1" };
    await call("GET", "/api/push/devices?deviceId=mio-localstorage");

    const byEndpoint = Object.fromEntries(
      (db.query("SELECT endpoint, auth_device_id FROM push_subscriptions").all() as Array<{ endpoint: string; auth_device_id: string | null }>)
        .map(r => [r.endpoint, r.auth_device_id]),
    );
    // Un altro browser resta NULL…
    expect(byEndpoint["https://web.push.apple.com/altro"]).toBeNull();
    // …e una riga già attribuita non si riscrive.
    expect(byEndpoint["https://web.push.apple.com/gia-timbrata"]).toBe("dev-9");
  });

  test("senza identità (loopback) non si timbra niente", async () => {
    getDatabase().run(
      "INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, device_id, auth_device_id) VALUES (?,?,?,?,NULL)",
      ["https://web.push.apple.com/mac", "p", "a", "mac-localstorage"],
    );
    identita = null;
    await call("GET", "/api/push/devices?deviceId=mac-localstorage");
    const row = getDatabase().query("SELECT auth_device_id FROM push_subscriptions").get() as { auth_device_id: string | null };
    expect(row.auth_device_id).toBeNull();
    // E continua a ricevere: il Mac su cui gira il server non si revoca.
    expect(destinatari()).toHaveLength(1);
  });
});

describe("dimenticaPush · uno schema vecchio non è un guasto", () => {
  /** Un db che fallisce sempre, con il messaggio che si vuole provare. */
  function dbCheEsplode(msg: string) {
    return { query: () => ({ run: () => { throw new Error(msg); } }) };
  }

  test("«colonna assente» è silenzio, un errore VERO no", () => {
    // Il `catch {}` muto rendeva i due casi indistinguibili: uno schema più
    // vecchio della colonna e un guasto che lascia la push VIVA su un
    // dispositivo appena revocato producevano lo stesso identico nulla.
    const visti: string[] = [];
    const originale = console.error;
    console.error = (...a: unknown[]) => { visti.push(a.join(" ")); };
    try {
      dimenticaPush(dbCheEsplode("no such column: auth_device_id"), "dev-1");
      dimenticaPush(dbCheEsplode("no such table: push_subscriptions"), "dev-1");
      expect(visti).toHaveLength(0);

      dimenticaPush(dbCheEsplode("database is locked"), "dev-1");
      expect(visti).toHaveLength(1);
      expect(visti[0]).toContain("dev-1");
      expect(visti[0]).toContain("database is locked");
    } finally {
      console.error = originale;
    }
  });

  test("non rilancia: una revoca non deve fallire per la tabella delle notifiche", () => {
    const originale = console.error;
    console.error = () => {};
    try {
      expect(() => dimenticaPush(dbCheEsplode("disk I/O error"), "dev-1")).not.toThrow();
    } finally {
      console.error = originale;
    }
  });
});

describe("elenco", () => {
  test("dice quale sei TU — senza, due iPhone sono indistinguibili", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    await subscribe("dev-mac", "https://fcm.googleapis.com/xyz", MAC_UA);

    const r = await call("GET", "/api/push/devices?deviceId=dev-mac");
    expect(r.status).toBe(200);
    const mine = r.body.devices.filter((d: any) => d.isThisDevice);
    expect(mine).toHaveLength(1);
    expect(mine[0].deviceId).toBe("dev-mac");
    expect(mine[0].label).toBe("Mac");
  });

  test("senza deviceId nessuna riga è «questo dispositivo»: meglio nessuna che quella sbagliata", async () => {
    await subscribe("dev-iphone", "https://web.push.apple.com/abc", IPHONE_UA);
    const r = await call("GET", "/api/push/devices");
    expect(r.body.devices.some((d: any) => d.isThisDevice)).toBe(false);
  });
});
