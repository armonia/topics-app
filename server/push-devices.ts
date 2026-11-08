/**
 * I dispositivi iscritti al push, come DATI — senza DB e senza rete.
 *
 * La tabella `push_subscriptions` è nata come rubrica di endpoint da spedire.
 * Da questa card è l'elenco dei DISPOSITIVI che l'utente governa uno per uno
 * (migration 101), e un elenco che si mostra a un umano ha due bisogni che una
 * rubrica di endpoint non ha: un nome leggibile, e una regola sola su chi
 * riceve. Vivono qui, puri, perché sono esattamente le due cose che vale la
 * pena testare senza montare un database.
 */

// Il tipo, il default e il parser vivono in `shared/push-device.ts`: lo stesso
// insieme di valori serve alla colonna, alla rotta e al payload della push, e
// due copie sono il modo normale in cui un terzo valore compare da una parte
// sola. Ri-esportati perché i chiamanti server importano da qui.
export { DEFAULT_WHEN_OPEN, parseWhenOpen } from "../shared/push-device";
export type { PushWhenOpen } from "../shared/push-device";
import { DEFAULT_WHEN_OPEN, parseWhenOpen } from "../shared/push-device";
import type { PushWhenOpen } from "../shared/push-device";

/** La riga come sta in SQLite dopo la migration 101. */
export interface PushDeviceRow {
  endpoint: string;
  device_id: string | null;
  device_label: string | null;
  enabled: number;
  when_open: string | null;
  user_agent: string | null;
  created_at: string | null;
  last_seen_at: string | null;
}

/** La forma che il client legge nell'elenco delle impostazioni. */
export interface PushDeviceView {
  /** Identità stabile del dispositivo attraverso le re-iscrizioni. Può mancare
   *  su una riga scritta prima della migration 101. */
  deviceId: string | null;
  /** Chi è, in parole. Mai l'endpoint: è un URL di 200 caratteri. */
  label: string;
  enabled: boolean;
  whenOpen: PushWhenOpen;
  createdAt: string | null;
  lastSeenAt: string | null;
  /** True per il dispositivo che sta CHIEDENDO l'elenco. Serve a dire «questo
   *  sei tu»: senza, due iPhone nella lista sono indistinguibili e l'utente
   *  spegne quello sbagliato. */
  isThisDevice: boolean;
}

/**
 * Un nome leggibile per un dispositivo, dal suo user agent.
 *
 * Non è device fingerprinting ed è volutamente grossolano: serve solo a
 * distinguere «iPhone» da «Mac» in una lista di due o tre righe. Quando lo user
 * agent non dice niente di utile il nome è "Dispositivo" — che è onesto —
 * invece di una stringa tecnica che l'utente non sa mappare su niente.
 */
export function deviceLabelFromUserAgent(ua: string | null | undefined): string {
  const s = (ua ?? "").trim();
  if (!s) return "Dispositivo";
  // L'ordine conta: iPadOS 13+ si dichiara "Macintosh", quindi il ramo iPad va
  // provato PRIMA di Mac e deve guardare anche il marcatore touch.
  if (/iPhone/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? "Android" : "Tablet Android";
  if (/Macintosh|Mac OS X/i.test(s)) return "Mac";
  if (/Windows/i.test(s)) return "Windows";
  if (/CrOS/i.test(s)) return "ChromeOS";
  if (/Linux/i.test(s)) return "Linux";
  return "Dispositivo";
}

/** La riga → la vista del client, con i default applicati una volta sola qui.
 *  `thisDeviceId` è l'id che il chiamante ha dichiarato di essere (query
 *  string): `null` quando chi chiede non è iscritto, e allora nessuna riga è
 *  «questo dispositivo» — meglio nessuna evidenziazione che una sbagliata. */
export function toDeviceView(row: PushDeviceRow, thisDeviceId: string | null): PushDeviceView {
  return {
    deviceId: row.device_id,
    label: row.device_label?.trim() || deviceLabelFromUserAgent(row.user_agent),
    enabled: row.enabled !== 0,
    whenOpen: parseWhenOpen(row.when_open) ?? DEFAULT_WHEN_OPEN,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    isThisDevice: thisDeviceId != null && row.device_id === thisDeviceId,
  };
}
