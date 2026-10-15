/**
 * Come questa installazione si presenta al relay, e se ci si presenta affatto.
 *
 * ── DUE NOMI, PERCHÉ RISPONDONO A DUE DOMANDE ───────────────────────────────
 * `installationId` dice QUALE INSTALLAZIONE è questa: ci si lega la licenza
 * (`licenza.ts` rifiuta un gettone coniato per un'altra) e ci si legano gli
 * eventi di Stripe. Non tocca il relay e non compare in nessun link.
 *
 * `relayId` is the public meeting-point name in links and Worker routes. It is
 * the digest of the persisted public signing key; the host keeps the private
 * key in `relay-identity.json`.
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
import { createRelayIdentity } from "../../shared/relay-identita";

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
 * The signing identity, in a file of its own with mode 0600, apart from the database.
 *
 * Not `relay-secret`: that file holds the shared secret of the previous scheme and nothing here
 * rewrites it. Replacing it at boot, the relay off included, threw away the only key to the links
 * made with it, with no way back.
 */
async function readRelayIdentity(stateDir: string): Promise<{ relayId: string; segreto: string }> {
  const f = join(stateDir, "relay-identity.json");
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as { relayId?: unknown; segreto?: unknown };
    if (typeof v.relayId === "string" && typeof v.segreto === "string") return { relayId: v.relayId, segreto: v.segreto };
  } catch { /* missing or unreadable: create a verifiable key */ }
  const created = await createRelayIdentity();
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(created) + "\n", { mode: 0o600 });
  } catch { /* keep the generated identity in memory for this process */ }
  return created;
}

export async function leggiRelaySegreto(stateDir: string): Promise<string> {
  return (await readRelayIdentity(stateDir)).segreto;
}

export async function leggiRelayConfig(
  env: Record<string, string | undefined>,
  stateDir: string,
): Promise<RelayConfig> {
  const identity = await readRelayIdentity(stateDir);
  return {
    baseUrl: leggiRelayUrl(env),
    installationId: leggiInstallationId(stateDir),
    relayId: identity.relayId,
  };
}
