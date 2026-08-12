import { useState, useEffect, useCallback, useRef } from "react";
import { primeWebNotificationPermission } from "../lib/shell/app";
import { describePushState, type PushStatusView } from "../lib/push/pushStatus";
import { pushDeviceId, pushCapable, readPushEnvironment } from "../lib/push/environment";
import { usePushDeviceStore, type PushWhenOpen } from "../state/pushDevice";

const API_BASE = import.meta.env.DEV ? "http://localhost:3333" : "";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Un dispositivo iscritto, come lo mostra l'elenco delle impostazioni.
 *  Speculare a `PushDeviceView` di `server/push-devices.ts`. */
export interface PushDevice {
  deviceId: string | null;
  label: string;
  enabled: boolean;
  whenOpen: PushWhenOpen;
  createdAt: string | null;
  lastSeenAt: string | null;
  isThisDevice: boolean;
}

/**
 * Web Push — la porta che mancava.
 *
 * Il codice per iscriversi c'era da sempre e non lo montava nessuno:
 * `SELECT COUNT(*) FROM push_subscriptions` dava 0, quindi il server non aveva a
 * chi mandare niente e ad app chiusa non arrivava nulla. Non mancava il push:
 * mancava l'iscrizione.
 *
 * Tre cose nuove rispetto alla versione dormiente:
 *   · il dispositivo si REGISTRA con un id stabile (`pushDeviceId`), così le
 *     preferenze sopravvivono alla rotazione dell'endpoint;
 *   · lo stato è ONESTO — «non iscritto», «negato dal sistema» e «su iPhone
 *     serve la PWA» sono tre cose diverse (`describePushState`), mentre prima si
 *     vedevano tutte e tre allo stesso modo: nessuna notifica;
 *   · l'iscrizione viva viene pubblicata nello store (`usePushDeviceStore`),
 *     perché è la condizione con cui la pagina decide di TACERE sugli eventi che
 *     il push già annuncia (lib/notify/pushVoice.ts).
 */
export function usePushNotifications() {
  const [subscribed, setSubscribed] = useState(false);
  const [status, setStatus] = useState<PushStatusView>(() => describePushState(readPushEnvironment(false)));
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const setPushDevice = usePushDeviceStore((s) => s.setPushDevice);
  // L'ultima risposta vince, non l'ultima che arriva: due letture ravvicinate
  // (mount + subscribe) possono tornare fuori ordine e riscrivere l'elenco con
  // la fotografia più vecchia.
  const listSeqRef = useRef(0);

  const refreshDevices = useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const res = await fetch(`${API_BASE}/api/push/devices?deviceId=${encodeURIComponent(pushDeviceId())}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== listSeqRef.current) return;
      const list: PushDevice[] = Array.isArray(data?.devices) ? data.devices : [];
      setDevices(list);
      const mine = list.find((d) => d.isThisDevice);
      if (mine) setPushDevice({ subscribed: true, whenOpen: mine.whenOpen });
    } catch (err) {
      console.error("[Push] device list failed:", err);
    }
  }, [setPushDevice]);

  const applyState = useCallback((isSubscribed: boolean) => {
    setSubscribed(isSubscribed);
    setStatus(describePushState(readPushEnvironment(isSubscribed)));
    setPushDevice({ subscribed: isSubscribed });
  }, [setPushDevice]);

  useEffect(() => {
    if (!pushCapable()) { applyState(false); return; }

    // Un errore qui NON deve lasciare lo stato a «non supportato»: sarebbe la
    // diagnosi sbagliata (e senza rimedio) per un ambiente che invece potrebbe
    // iscriversi. Si ricade sulla lettura dell'ambiente, che almeno dice il vero
    // sul permesso.
    let alive = true;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!alive) return;
        applyState(!!sub);
        if (sub) void refreshDevices();
      } catch (err) {
        console.error("[Push] init state check failed:", err);
        if (alive) applyState(false);
      }
    })();
    return () => { alive = false; };
  }, [applyState, refreshDevices]);

  const subscribe = useCallback(async () => {
    if (!pushCapable()) return false;
    setLoading(true);
    try {
      const permission = await primeWebNotificationPermission();
      if (permission !== "granted") {
        // Anche un rifiuto va DETTO: `describePushState` legge il permesso vero
        // e trasforma il no in «negato dal sistema, si riattiva da lì» invece di
        // lasciare un interruttore che sembra ancora premibile.
        applyState(false);
        return false;
      }

      const res = await fetch(`${API_BASE}/api/push/vapid-public-key`);
      const { publicKey } = await res.json();

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const saved = await fetch(`${API_BASE}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), deviceId: pushDeviceId() }),
      });
      // Una subscription nel browser che il server non conosce è il peggiore dei
      // due mondi: l'interfaccia direbbe «iscritto» e non arriverebbe niente.
      if (!saved.ok) throw new Error(`subscribe HTTP ${saved.status}`);

      applyState(true);
      await refreshDevices();
      return true;
    } catch (err) {
      console.error("[Push] Subscribe failed:", err);
      applyState(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [applyState, refreshDevices]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(`${API_BASE}/api/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      applyState(false);
      await refreshDevices();
    } catch (err) {
      console.error("[Push] Unsubscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, [applyState, refreshDevices]);

  /** Le preferenze di UN dispositivo — mai di tutti. Il telefono e il Mac devono
   *  poter dire cose diverse, ed è per questo che si indirizza per `deviceId`. */
  const setDevicePrefs = useCallback(async (
    deviceId: string,
    prefs: { enabled?: boolean; whenOpen?: PushWhenOpen },
  ) => {
    // Ottimismo locale: l'interruttore si muove subito, e la lettura successiva
    // è la verità. Senza, un tap su un telefono sembra non aver fatto niente
    // finché la rete non risponde.
    setDevices((prev) => prev.map((d) => (d.deviceId === deviceId ? { ...d, ...prefs } : d)));
    if (prefs.whenOpen && devices.find((d) => d.deviceId === deviceId)?.isThisDevice) {
      setPushDevice({ subscribed: true, whenOpen: prefs.whenOpen });
    }
    try {
      const res = await fetch(`${API_BASE}/api/push/devices/prefs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, ...prefs }),
      });
      if (!res.ok) throw new Error(`prefs HTTP ${res.status}`);
    } catch (err) {
      console.error("[Push] device prefs failed:", err);
    } finally {
      await refreshDevices();
    }
  }, [devices, refreshDevices, setPushDevice]);

  return { status, subscribed, devices, loading, subscribe, unsubscribe, setDevicePrefs, refreshDevices };
}
