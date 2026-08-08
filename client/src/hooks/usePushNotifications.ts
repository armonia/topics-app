import { useState, useEffect, useCallback } from "react";
import { primeWebNotificationPermission, webNotificationPermission } from "../lib/shell/app";

const API_BASE = import.meta.env.DEV ? "http://localhost:3333" : "";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type PushState = "unsupported" | "default" | "denied" | "granted" | "subscribed";

/**
 * Web Push per gli ALTRI dispositivi. Oggi nessuno monta questo hook (la UI è
 * stata tolta per decisione di prodotto, vedi NotificationsSection), ma il
 * permesso lo chiedeva comunque dall'API `Notification` nuda — cioè con la
 * stessa trappola che faceva ripartire il prompt a ogni avvio sotto Tauri, in
 * agguato per il giorno in cui l'hook torna montato. Ora passa dalla porta
 * unica (`lib/shell/app`), che il guard nativo se lo porta dietro da sé.
 */
export function usePushNotifications() {
  const [state, setState] = useState<PushState>("unsupported");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported");
      return;
    }

    // Check current state. Wrap in try/catch: if serviceWorker.ready or
    // getSubscription() rejects, an unhandled rejection here would strand
    // `state` at its initial "unsupported" and dead-end subscribe(). Fall back
    // to "default" (not "unsupported") so a supported-but-init-failed
    // environment can still attempt to subscribe.
    (async () => {
      try {
        const permission = webNotificationPermission();
        if (permission === "denied") { setState("denied"); return; }
        // 'unsupported' = niente API `Notification` (o guscio nativo, dove i
        // banner passano dal comando `notify`): non c'è niente da sottoscrivere.
        if (permission === "unsupported") { setState("unsupported"); return; }

        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setState(sub ? "subscribed" : permission === "granted" ? "granted" : "default");
      } catch (err) {
        console.error("[Push] init state check failed:", err);
        setState(webNotificationPermission() === "denied" ? "denied" : "default");
      }
    })();
  }, []);

  const subscribe = useCallback(async () => {
    if (state === "unsupported" || state === "denied") return;
    setLoading(true);
    try {
      const permission = await primeWebNotificationPermission();
      if (permission !== "granted") { setState("denied"); return; }

      const res = await fetch(`${API_BASE}/api/push/vapid-public-key`);
      const { publicKey } = await res.json();

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      await fetch(`${API_BASE}/api/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      setState("subscribed");
    } catch (err) {
      console.error("[Push] Subscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, [state]);

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
      setState("default");
    } catch (err) {
      console.error("[Push] Unsubscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  return { state, loading, subscribe, unsubscribe };
}
