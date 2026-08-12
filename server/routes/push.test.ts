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
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { createPushRouter } from "./push";
import type { AppContext } from "../types";

let tmpRoot: string;
let router: ReturnType<typeof createPushRouter>;

function fakeCtx(): AppContext {
  return {
    get db() { return getDatabase(); },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
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

/** Una subscribe verosimile: endpoint del push service, chiavi, id del dispositivo. */
function subscribe(deviceId: string, endpoint: string, ua: string) {
  return call("POST", "/api/push/subscribe", {
    endpoint,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    deviceId,
  }, { "user-agent": ua });
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
  process.env.DATA_DIR = join(tmpRoot, "data");
  initDatabase(tmpRoot);
  router = createPushRouter(fakeCtx());
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  getDatabase().run("DELETE FROM push_subscriptions");
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
