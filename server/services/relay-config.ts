/**
 * Come questa installazione si presenta al relay, e se ci si presenta affatto.
 *
 * ── L'IDENTIFICATIVO NON È UN SEGRETO ───────────────────────────────────────
 * `installationId` serve al relay per far incontrare questa macchina e i suoi
 * ospiti: è un NOME, e chi lo indovina non ottiene niente — senza un `ref` e
 * senza la chiave nel frammento non c'è nulla da aprire. Per questo si può
 * mettere in un link e mostrarlo.
 *
 * È comunque casuale e non derivato da qualcosa di riconoscibile (il nome
 * della macchina, l'utente, un percorso): un identificativo che racconta chi
 * sei è un identificativo che, apparendo in un URL condiviso, racconta chi sei
 * a chiunque riceva quel link.
 *
 * ── SPENTO È IL DEFAULT ─────────────────────────────────────────────────────
 * Senza `TOPICS_RELAY_URL` il relay non esiste: nessuna connessione in uscita,
 * nessun link generabile, e l'app locale identica a prima. Raggiungere il mondo
 * è una cosa che si sceglie, non che capita.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RelayConfig {
  /** `null` = relay spento. */
  baseUrl: string | null;
  installationId: string;
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

export function leggiRelayConfig(env: Record<string, string | undefined>, stateDir: string): RelayConfig {
  return { baseUrl: leggiRelayUrl(env), installationId: leggiInstallationId(stateDir) };
}
