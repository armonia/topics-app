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
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRelayIdentity } from "../../shared/relay-identita";
import { resolveSecretsDir } from "../lib/data-dir";

export interface RelayConfig {
  /** `null` = relay spento. */
  baseUrl: string | null;
  /** Quale installazione: licenza e fatturazione. Mai in un link. */
  installationId: string;
  /** Il punto d'incontro sul relay: link, porte, indirizzo del telefono. */
  relayId: string;
}

/**
 * Where the two keys of this file live: `resolveSecretsDir(stateDir)`, 0700, files 0600.
 *
 * They used to sit in the state root, which under the production LaunchAgent is the
 * checkout itself: `/preview` served the private key as a project file, and a
 * `git clean -fdx` would have deleted it. A lost key is not a lost file: it breaks
 * every link and every paired device, so everything below errs toward KEEPING what
 * exists and never regenerates over something it could not read.
 */
const secretFile = (stateDir: string, name: string): string => join(resolveSecretsDir(stateDir), name);

/** mkdir does not change the mode of a folder that already exists, hence the chmod. */
function ensureSecretsDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch { /* not ours to fix */ }
}

/**
 * Creates `file` with `data` only if nothing is there. The bytes go to a staging file first and
 * `link` puts the finished file in place: a reader never sees half a key (it would take it for a
 * corrupt one and set it aside), and a key that already exists is never replaced (EEXIST), which
 * a rename or a plain write would do silently.
 */
function placeNew(file: string, data: string | Buffer): void {
  const staging = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, data, { mode: 0o600 });
    linkSync(staging, file);
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * A key still in the state root moves to the secrets folder, once: the bytes are placed first, the
 * old file is removed only after. An existing new file always wins and the old one stays where it
 * is. On any failure nothing is lost: `readKey` falls back to the old path.
 */
function adoptLegacy(stateDir: string, name: string): void {
  const from = join(stateDir, name);
  const to = secretFile(stateDir, name);
  if (from === to || !existsSync(from)) return;
  try {
    // The folder is made (and its mode fixed) BEFORE looking for the new file: a folder without
    // the x bit answers "not there" for a file that is.
    ensureSecretsDir(dirname(to));
    if (existsSync(to)) return;
    placeNew(to, readFileSync(from));
    unlinkSync(from);
  } catch { /* the old file is still there: it is read where it is */ }
}

type KeyRead = { kind: "ok"; text: string; file: string } | { kind: "missing" } | { kind: "error"; code: string };

/** Three outcomes, not two: "not there" generates a key, "could not read" must NOT. */
function readKey(stateDir: string, name: string): KeyRead {
  adoptLegacy(stateDir, name);
  for (const file of [secretFile(stateDir, name), join(stateDir, name)]) {
    try {
      return { kind: "ok", text: readFileSync(file, "utf8"), file };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      // ENOTDIR: the secrets folder is not a folder, so nothing is there; the old path is tried next.
      if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "error", code };
    }
  }
  return { kind: "missing" };
}

/** A file that is there but unusable is set aside, never overwritten: it may hold the only copy. */
function setAside(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch { /* it stays where it is: the new key is not written over it, see `writeKey` */ }
}

/**
 * Writes the new key and answers with the key that is ON DISK. Two first boots at once, or a
 * corrupt file that could not be set aside, make `placeNew` refuse (EEXIST): the winner's key is
 * the key, and when what is there is unusable the new one stays in memory and nothing is touched.
 */
function writeKey<T>(stateDir: string, name: string, text: string, parse: (text: string) => T | null, fallback: T): T {
  const file = secretFile(stateDir, name);
  try {
    ensureSecretsDir(dirname(file));
    placeNew(file, text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return fallback;
    const there = readKey(stateDir, name);
    return (there.kind === "ok" ? parse(there.text) : null) ?? fallback;
  }
  return fallback;
}

const parseInstallationId = (text: string): string | null => (/^[A-Za-z0-9_-]{8,64}$/.test(text.trim()) ? text.trim() : null);

function parseIdentity(text: string): { relayId: string; segreto: string } | null {
  try {
    const v = JSON.parse(text) as { relayId?: unknown; segreto?: unknown };
    return typeof v.relayId === "string" && typeof v.segreto === "string" ? { relayId: v.relayId, segreto: v.segreto } : null;
  } catch {
    return null;
  }
}

/** Legge l'identificativo, generandolo la prima volta. Un file e non una riga
 *  nel database: deve sopravvivere a un ripristino del DB da un backup, o
 *  tutti i link già in giro smetterebbero di funzionare insieme. */
export function leggiInstallationId(stateDir: string): string {
  const read = readKey(stateDir, "installation-id");
  if (read.kind === "ok") {
    const v = parseInstallationId(read.text);
    if (v) return v;
    setAside(read.file);
  }

  const nuovo = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  if (read.kind === "error") {
    console.warn(`[relay] installation-id unreadable (${read.code}): temporary id, nothing written`);
    return nuovo;
  }
  return writeKey(stateDir, "installation-id", nuovo + "\n", parseInstallationId, nuovo);
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
  const read = readKey(stateDir, "relay-identity.json");
  if (read.kind === "ok") {
    const v = parseIdentity(read.text);
    if (v) return v;
    setAside(read.file);
  }
  const created = await createRelayIdentity();
  if (read.kind === "error") {
    console.warn(`[relay] identity unreadable (${read.code}): temporary identity, nothing written`);
    return created;
  }
  return writeKey(stateDir, "relay-identity.json", JSON.stringify(created) + "\n", parseIdentity, created);
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
