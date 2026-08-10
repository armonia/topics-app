/**
 * Come questa installazione si presenta al relay, e se ci si presenta affatto.
 *
 * ── DUE NOMI, PERCHÉ RISPONDONO A DUE DOMANDE ───────────────────────────────
 * `installationId` dice QUALE INSTALLAZIONE è questa: ci si lega la licenza
 * (`licenza.ts` rifiuta un gettone coniato per un'altra) e ci si legano gli
 * eventi di Stripe. Non tocca il relay e non compare in nessun link.
 *
 * `relayId` è il nome del PUNTO D'INCONTRO sul relay: sta nei link condivisi,
 * nell'indirizzo che si apre dal telefono, nelle tre porte del Worker. È il
 * digest di `relay-secret` (vedi `shared/relay-identita.ts`), e questa è la
 * proprietà che regge tutto il resto — chi riceve un link ha il digest, e la
 * macchina è l'unica ad avere la preimmagine.
 *
 * Prima era UN nome solo per entrambe le cose, e da lì veniva il difetto:
 * l'identificativo che si mostrava nei link era anche la credenziale con cui ci
 * si dichiarava la macchina su `/agent/:id`. Il commento che sta qui sopra
 * diceva «l'identificativo non è un segreto», e per gli ospiti era vero; per
 * quella porta era falso, e nessuno dei due lo diceva. Tenerli separati
 * significa che mostrarne uno non concede l'altro.
 *
 * Il segreto NON entra in `RelayConfig`. È deliberato: quell'oggetto finisce
 * dentro `/api/auth/relay` e `/api/account`, e un campo che non esiste non può
 * essere spanto in una risposta da una `...` di troppo.
 *
 * ── SPENTO È IL DEFAULT ─────────────────────────────────────────────────────
 * Senza `TOPICS_RELAY_URL` il relay non esiste: nessuna connessione in uscita,
 * nessun link generabile, e l'app locale identica a prima. Raggiungere il mondo
 * è una cosa che si sceglie, non che capita.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { derivaRelayId } from "../../shared/relay-identita";

export interface RelayConfig {
  /** `null` = relay spento. */
  baseUrl: string | null;
  /** Quale installazione: licenza e fatturazione. Mai in un link. */
  installationId: string;
  /** Il punto d'incontro sul relay: link, porte, indirizzo del telefono. */
  relayId: string;
}

/** Legge l'identificativo, generandolo la prima volta. Un file e non una riga
 *  nel database: deve sopravvivere a un ripristino del DB da un backup, o
 *  tutti i link già in giro smetterebbero di funzionare insieme. */
export function leggiInstallationId(stateDir: string): string {
  const f = join(stateDir, "installation-id");
  try {
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) return v;
    }
  } catch { /* si rigenera */ }

  const nuovo = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, nuovo + "\n", { mode: 0o600 });
  } catch { /* in memoria per questa esecuzione: meglio di un errore */ }
  return nuovo;
}

/**
 * L'URL del relay, se configurato.
 *
 * Si normalizza togliendo la barra finale e si rifiuta ciò che non è
 * `http`/`https`: un valore storto qui diventerebbe un link storto in mano a
 * qualcun altro, e quello non si ritira.
 */
export function leggiRelayUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.TOPICS_RELAY_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Il segreto del punto d'incontro, generato la prima volta.
 *
 * Un file suo e non una riga nel database, per la stessa ragione
 * dell'identificativo: deve sopravvivere a un ripristino da backup, o ogni link
 * già consegnato smetterebbe di funzionare insieme. Modo `600` perché a
 * differenza dell'altro questo è davvero un segreto — chi lo legge può
 * spacciarsi per questa macchina sul relay.
 *
 * 32 byte casuali in base64url. Se il file non è scrivibile si tiene il valore
 * in memoria per questa esecuzione: il relay funziona finché il processo vive e
 * cambierà nome al riavvio, che è meglio di un avvio che fallisce.
 */
export function leggiRelaySegreto(stateDir: string): string {
  const f = join(stateDir, "relay-secret");
  try {
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (/^[A-Za-z0-9_-]{16,512}$/.test(v)) return v;
    }
  } catch { /* si rigenera */ }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const nuovo = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, nuovo + "\n", { mode: 0o600 });
  } catch { /* in memoria per questa esecuzione: meglio di un errore */ }
  return nuovo;
}

export async function leggiRelayConfig(
  env: Record<string, string | undefined>,
  stateDir: string,
): Promise<RelayConfig> {
  return {
    baseUrl: leggiRelayUrl(env),
    installationId: leggiInstallationId(stateDir),
    relayId: await derivaRelayId(leggiRelaySegreto(stateDir)),
  };
}
