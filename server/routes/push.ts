import type { AppContext, RouteHandler } from "../types";
import { getVapidPublicKey } from "../push-service";
import {
  deviceLabelFromUserAgent,
  parseWhenOpen,
  toDeviceView,
  type PushDeviceRow,
} from "../push-devices";

export function createPushRouter(ctx: AppContext): RouteHandler {
  const { db, json, readJSON } = ctx;

  return async function pushRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/push/vapid-public-key
    if (method === "GET" && pathname === "/api/push/vapid-public-key") {
      return json({ publicKey: getVapidPublicKey() });
    }

    // GET /api/push/devices?deviceId=… — l'elenco che le impostazioni mostrano.
    // `deviceId` serve solo a marcare quale riga sei TU: senza, due iPhone nella
    // lista sono indistinguibili e si spegne quello sbagliato.
    if (method === "GET" && pathname === "/api/push/devices") {
      const thisDeviceId = url.searchParams.get("deviceId");
      // BACKFILL della colonna su cui si decide la revoca.
      //
      // `auth_device_id` è stata aggiunta dopo, quindi le righe scritte prima
      // ce l'hanno NULL — e NULL è «consegna comunque», perché è anche il caso
      // del Mac su cui gira il server. Una revoca non le raggiunge:
      // `dimenticaPush` filtra su quella colonna. La nota «si popola alla prima
      // re-iscrizione» non reggeva: `POST /api/push/subscribe` parte solo da un
      // gesto esplicito dell'utente, mentre all'avvio il client si limita a
      // `pushManager.getSubscription()`.
      //
      // Qui invece si passa ogni volta che si apre la card delle notifiche, con
      // l'identità già risolta dal gate. Se la riga porta lo stesso `device_id`
      // del localStorage che sta chiedendo l'elenco, quel browser È questo
      // dispositivo appaiato: la si timbra, e da quel momento la revoca la
      // vede. Non si tocca nessuna riga già attribuita.
      const authDeviceId = ctx.requestIdentity?.(req)?.deviceId ?? null;
      if (authDeviceId && thisDeviceId) {
        db.run(
          "UPDATE push_subscriptions SET auth_device_id = ? WHERE device_id = ? AND auth_device_id IS NULL",
          [authDeviceId, thisDeviceId],
        );
      }
      const rows = db.query(
        `SELECT endpoint, device_id, device_label, enabled, when_open, user_agent, created_at, last_seen_at
           FROM push_subscriptions
          ORDER BY datetime(COALESCE(last_seen_at, created_at)) DESC`
      ).all() as PushDeviceRow[];
      return json({ devices: rows.map(r => toDeviceView(r, thisDeviceId)) });
    }

    // POST /api/push/subscribe
    if (method === "POST" && pathname === "/api/push/subscribe") {
      const body = await readJSON(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const { endpoint, keys, deviceId, label } = body;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return json({ error: "Invalid subscription" }, 400);
      }

      const userAgent = req.headers.get("user-agent") || null;
      const deviceLabel = typeof label === "string" && label.trim()
        ? label.trim().slice(0, 60)
        : deviceLabelFromUserAgent(userAgent);
      const id = typeof deviceId === "string" && deviceId.trim() ? deviceId.trim().slice(0, 64) : null;

      // Il dispositivo APPAIATO, e viene dall'identità della richiesta — mai dal
      // corpo. `deviceId` qui sopra è un UUID che il client si genera nel
      // localStorage: tiene insieme le righe di uno stesso browser e dice
      // «questo sei tu» nell'elenco, ma chi scrive la richiesta lo sceglie,
      // quindi non può reggere una revoca. Questo sì: è `devices.id`, ed è ciò
      // su cui `sendPushToAll` verifica che il dispositivo sia ancora vivo.
      // `null` = loopback (questa macchina) o nessuna identità risolta.
      const authDeviceId = ctx.requestIdentity?.(req)?.deviceId ?? null;

      // Un dispositivo = una riga. Il browser rigenera l'endpoint quando gli
      // pare (chiavi ruotate, PWA reinstallata): senza questa potatura la
      // vecchia riga resta nell'elenco come un secondo telefono che non esiste,
      // e riceve push che nessuno consegnerà mai. Prima dell'insert, e solo
      // sull'endpoint DIVERSO, così una re-iscrizione identica non si cancella
      // da sola le preferenze.
      //
      // La potatura NON si restringe all'identità, ed è deliberato: su
      // `device_id` c'è un indice UNIQUE (migration 101), quindi «prima riga
      // vince» non sarebbe una difesa ma un `SQLITE_CONSTRAINT_UNIQUE` — cioè
      // un 500 sul telefono che si RIAPPAIA dopo una revoca, che è il caso
      // legittimo in cui lo stesso id del localStorage torna con un'identità
      // nuova. Misurato: il test «un dispositivo non cancella l'iscrizione di un
      // altro» falliva esattamente così. Chi arriva qui ha comunque un'identità
      // appaiata, e per colpire dovrebbe indovinare un UUID altrui.
      if (id) db.run("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint != ?", [id, endpoint]);

      // `enabled` e `when_open` NON si toccano sul conflitto: una re-iscrizione
      // (il browser che ruota le chiavi, un reload della PWA) è un fatto
      // tecnico, non una revoca delle preferenze dell'utente. Riscriverli ai
      // default qui vorrebbe dire riaccendere in silenzio un dispositivo che
      // l'utente aveva spento.
      db.run(
        `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, user_agent, device_id, device_label, auth_device_id, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(endpoint) DO UPDATE SET
           keys_p256dh = ?, keys_auth = ?, user_agent = ?, device_id = ?, device_label = ?, auth_device_id = ?, last_seen_at = datetime('now')`,
        [endpoint, keys.p256dh, keys.auth, userAgent, id, deviceLabel, authDeviceId,
         keys.p256dh, keys.auth, userAgent, id, deviceLabel, authDeviceId]
      );

      const row = db.query(
        `SELECT endpoint, device_id, device_label, enabled, when_open, user_agent, created_at, last_seen_at
           FROM push_subscriptions WHERE endpoint = ?`
      ).get(endpoint) as PushDeviceRow | null;

      return json({ ok: true, device: row ? toDeviceView(row, id) : null });
    }

    // POST /api/push/devices/prefs — l'interruttore PER DISPOSITIVO.
    // Si indirizza per `deviceId` (stabile, quello che l'elenco mostra) o per
    // `endpoint` (chi ha appena finito di iscriversi e non ha ancora riletto la
    // lista). Uno dei due basta; nessuno dei due tocca gli altri dispositivi —
    // ed è tutto il punto della card.
    if (method === "POST" && pathname === "/api/push/devices/prefs") {
      const body = await readJSON(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const { deviceId, endpoint, enabled, whenOpen } = body;
      if (typeof deviceId !== "string" && typeof endpoint !== "string") {
        return json({ error: "deviceId or endpoint required" }, 400);
      }

      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (typeof enabled === "boolean") { sets.push("enabled = ?"); args.push(enabled ? 1 : 0); }
      if (whenOpen !== undefined) {
        const parsed = parseWhenOpen(whenOpen);
        if (!parsed) return json({ error: "whenOpen must be 'native' or 'in-app'" }, 400);
        sets.push("when_open = ?"); args.push(parsed);
      }
      if (sets.length === 0) return json({ error: "nothing to update" }, 400);

      const where = typeof deviceId === "string" ? "device_id = ?" : "endpoint = ?";
      args.push(typeof deviceId === "string" ? deviceId : (endpoint as string));
      db.run(`UPDATE push_subscriptions SET ${sets.join(", ")} WHERE ${where}`, args);

      const row = db.query(
        `SELECT endpoint, device_id, device_label, enabled, when_open, user_agent, created_at, last_seen_at
           FROM push_subscriptions WHERE ${where}`
      ).get(args[args.length - 1] as string) as PushDeviceRow | null;
      if (!row) return json({ error: "device not found" }, 404);

      return json({ ok: true, device: toDeviceView(row, typeof deviceId === "string" ? deviceId : row.device_id) });
    }

    // POST /api/push/unsubscribe
    if (method === "POST" && pathname === "/api/push/unsubscribe") {
      const body = await readJSON(req);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const { endpoint } = body;

      if (!endpoint) {
        return json({ error: "endpoint required" }, 400);
      }

      db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
      return json({ ok: true });
    }

    return null;
  };
}
