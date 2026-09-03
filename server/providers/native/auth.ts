/**
 * Le credenziali OAuth con cui il runtime nativo parla ad Anthropic.
 *
 * PERCHÉ ESISTE QUESTO FILE, che è la domanda vera. Fino a oggi ogni turno di
 * Topics passava da una CLI: `claude`, `codex`, o un adattatore ACP. La CLI
 * teneva le credenziali, faceva il refresh, parlava con l'API — e noi le
 * parlavamo attraverso stdio, pagando un processo Node INTERO per sessione
 * (~206 MB misurati). Il runtime nativo toglie il tramite: chiama l'API in
 * proprio, e allora deve saper fare da sé la cosa che la CLI faceva per noi.
 *
 * DA DOVE ARRIVANO I TOKEN, e perché NON li chiediamo noi. Il login lo fa
 * l'utente con la CLI ufficiale (`claude` → `/login`), che scrive il risultato
 * in `~/.claude/.credentials.json`. Qui si LEGGE quel file: non c'è un flusso
 * di login dentro Topics, non c'è una finestra che chiede le credenziali di
 * Claude, non c'è niente che assomigli a un login offerto da noi. È una scelta
 * deliberata e sta scritta qui perché non venga «semplificata» un domani da chi
 * trova scomodo dipendere da un file altrui.
 *
 * IL REFRESH INVECE È NOSTRO, e va spiegato perché sembra in contraddizione.
 * Un access token dura 8 ore; scaduto quello, senza refresh il runtime muore
 * finché l'utente non riapre la CLI. Rinnovare un token che l'utente ci ha già
 * concesso è manutenzione della sessione che ha aperto lui, non un login nuovo:
 * nessuna credenziale viene chiesta, nessuna schermata di consenso appare.
 *
 * SI SCRIVE DOVE SI È LETTO. Il refresh token RUOTA a ogni rinnovo: quello
 * vecchio muore. Se leggessimo da `~/.claude` senza riscriverci, il primo
 * refresh nostro invaliderebbe silenziosamente la CLI dell'utente — che
 * scoprirebbe di essere sloggato al prossimo `claude`, senza capire perché.
 * È già successo: un test che rinnovava senza salvare ha lasciato un file di
 * credenziali morto per otto ore (2026-08-16).
 */

import { readFileSync, writeFileSync, mkdtempSync, renameSync, chmodSync, openSync, closeSync, unlinkSync, constants as fsConstants } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join, dirname } from "path";
import { spawnSync } from "child_process";

/**
 * Il client id di Claude Code. Non è un segreto (sta in chiaro in ogni
 * installazione della CLI) ed è pubblico per costruzione: in OAuth PKCE il
 * client id identifica l'applicazione, non autentica nessuno.
 */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * L'endpoint del rinnovo. NON è `console.anthropic.com`: quello risponde 403
 * da Cloudflare (error 1010, «browser signature») a qualunque client che non
 * sia un browser. Il dominio giusto è `platform.claude.com`, e ci si arriva
 * solo con gli header sotto — verificato il 2026-08-16.
 *
 * OAUTH_TOKEN_URL_OVERRIDE: usata solo nei test per puntare a un server finto,
 * e accettata SOLO se punta al loopback.
 *
 * Il vincolo non e' formale. Questo e' l'indirizzo a cui viene spedito il
 * REFRESH TOKEN, cioe' la credenziale piu' preziosa della macchina: senza
 * vincolo, una variabile d'ambiente qualunque — un `.env` copiato, uno script
 * di comodo, una riga in un profilo di shell — la manderebbe altrove, e la
 * risposta finirebbe scritta nel file delle credenziali dell'utente. Il test
 * che la usa alza un server finto su 127.0.0.1, quindi il vincolo non gli costa
 * niente; a un attaccante toglie tutto.
 */
function tokenUrlFromEnv(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
  if (!loopback) {
    console.warn(
      `[auth] OAUTH_TOKEN_URL_OVERRIDE ignorata: "${raw}" non punta al loopback. ` +
      "Quell'indirizzo riceverebbe il refresh token.",
    );
    return null;
  }
  return raw;
}

export const OAUTH_TOKEN_URL_DEFAULT = "https://platform.claude.com/v1/oauth/token";
const TOKEN_URL = tokenUrlFromEnv(process.env.OAUTH_TOKEN_URL_OVERRIDE) ?? OAUTH_TOKEN_URL_DEFAULT;
export { tokenUrlFromEnv };

/** Gli scope che la CLI chiede, e che il rinnovo deve richiedere identici. */
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/**
 * Quanto prima della scadenza si rinnova. Cinque minuti: abbastanza da non
 * farsi cogliere a metà di un turno lungo, poco abbastanza da non rinnovare di
 * continuo. Un turno che dura più di così ha comunque il suo retry.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Millisecondi epoch. */
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

/** Dove cerchiamo le credenziali, in ordine di preferenza. */
function credentialPaths(): string[] {
  // `HOME` PRIMA di `homedir()`, e non e' un dettaglio da test: su macOS
  // `os.homedir()` legge la home dal database degli utenti e IGNORA `HOME`,
  // quindi un processo che gira con una home diversa da quella dell'utente di
  // login (un servizio, un container, un runner) cercherebbe le credenziali
  // dove non stanno. E' anche l'unico modo di provare i due esiti opposti di
  // `connected` senza dipendere dalla macchina che esegue i test.
  const home = process.env.HOME || homedir();
  return [
    join(home, ".claude", ".credentials.json"),
    join(home, ".jcode", "auth.json"),
  ];
}

// ─── THE KEYCHAIN, where Claude Code actually keeps the token on macOS ──────
//
// The two files above are not where the CLI writes on a Mac: it uses the
// login Keychain, item "Claude Code-credentials", account = the user. The
// file `~/.claude/.credentials.json` is a leftover of an older login: on this
// machine, on 2026-09-03, it held a token revoked 63 days earlier, while the
// Keychain and `~/.jcode/auth.json` held the live one. Reading only the files
// means depending on jcode mirroring the Keychain, and the 401 of that morning
// ("OAuth access token has been revoked", 300ms after Enter) was exactly the
// lag between the CLI rotating the pair and the mirror catching up.
//
// So the Keychain is a candidate too, and the FIRST one: it is the CLI's own
// store, and reading it makes the server see a rotation the moment it happens.
// A renewal done from a Keychain-sourced credential is written BACK to the
// Keychain, because the refresh token rotates and the CLI must find the new
// pair where it looks (writing it anywhere else logs the CLI out).
//
// OPT-IN PER MACHINE (`TOPICS_CREDENTIALS_KEYCHAIN=1` in ~/.topics-server-env),
// for one reason: the tests run with a temporary HOME and fake credential
// files, and a candidate that ignores HOME would hand them the real token.
// Reading it costs one `security` spawn (~30ms) per turn, not per round.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The pseudo-path that marks a Keychain-sourced credential for lock and write. */
export const KEYCHAIN_SOURCE = `keychain:${KEYCHAIN_SERVICE}`;

export interface KeychainRunResult { status: number | null; stdout: string; stderr: string }
export type KeychainRunner = (cmd: string, args: string[]) => KeychainRunResult;

const defaultRunner: KeychainRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 5_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
let _runner: KeychainRunner = defaultRunner;
/** Tests inject a fake `security`; `null` restores the real one. */
export function setKeychainRunnerForTests(run: KeychainRunner | null): void {
  _runner = run ?? defaultRunner;
}

function keychainEnabled(): boolean {
  return process.platform === "darwin" && process.env.TOPICS_CREDENTIALS_KEYCHAIN === "1";
}

export function readKeychainCredentials(): (OAuthCredentials & { sourcePath: string }) | null {
  const r = _runner("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try {
    const parsed = parseAnyFormat(JSON.parse(r.stdout.trim()));
    return parsed ? { ...parsed, sourcePath: KEYCHAIN_SOURCE } : null;
  } catch {
    return null;
  }
}

/** The item's account name: what the CLI wrote, falling back to the login user. */
function keychainAccount(): string {
  const r = _runner("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE]);
  const m = r.status === 0 ? /"acct"<blob>="([^"]+)"/.exec(r.stdout) : null;
  if (m?.[1]) return m[1];
  try { return userInfo().username; } catch { return process.env.USER || "claude"; }
}

/**
 * Written the way the CLI writes it: the whole item is one JSON document and
 * the sibling keys (`mcpOAuth`, `scopes`, `subscriptionType`, `rateLimitTier`)
 * are the CLI's, so they are preserved and only the rotating pair changes.
 * `-U` updates the item in place instead of adding a duplicate.
 */
export function writeKeychainCredentials(next: OAuthCredentials): void {
  const cur = _runner("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  let doc: Record<string, any> = {};
  try { doc = cur.status === 0 && cur.stdout.trim() ? JSON.parse(cur.stdout.trim()) : {}; } catch { doc = {}; }
  doc.claudeAiOauth = {
    ...(doc.claudeAiOauth ?? {}),
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
  };
  const r = _runner("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(), "-w", JSON.stringify(doc)]);
  if (r.status !== 0) throw new Error(`keychain write failed: ${r.stderr.trim() || `exit ${r.status}`}`);
}

/**
 * Legge le credenziali dal file che ne ha di UTILIZZABILI.
 *
 * Due formati, perché i due file che le contengono sono scritti da due
 * programmi diversi e nessuno dei due è nostro. Si accetta ciò che si trova
 * invece di pretendere una forma: se un domani cambia, il runtime deve
 * degradare a «non autenticato», non esplodere.
 *
 * NON si prende la prima che si trova, ed è una lezione pagata. Su questa
 * macchina `~/.claude/.credentials.json` esisteva, era ben formato, e il suo
 * refresh token era morto da 45 giorni: prendendolo per primo il runtime
 * falliva l'autenticazione pur avendo, nel file accanto, una credenziale
 * perfettamente viva. «C'è un file» e «c'è una credenziale che funziona» sono
 * due domande diverse.
 *
 * L'ordine quindi è: prima chi ha un access token ANCORA valido, poi chi ne ha
 * uno scaduto ma rinnovabile (si scoprirà provando), infine niente. Un access
 * token vivo è l'unica prova non ambigua che quella catena di credenziali è
 * ancora buona.
 */
export function readCredentials(): OAuthCredentials | null {
  const candidates: Array<OAuthCredentials & { sourcePath: string }> = [];
  if (keychainEnabled()) {
    const kc = readKeychainCredentials();
    if (kc) candidates.push(kc);
  }
  for (const path of credentialPaths()) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const parsed = parseAnyFormat(raw);
      if (parsed) candidates.push({ ...parsed, sourcePath: path });
    } catch {
      // File assente o illeggibile: si prova il prossimo. Non è un guasto —
      // è la macchina di chi non ha mai fatto login.
    }
  }
  if (candidates.length === 0) return null;
  const now = Date.now();
  // Un access token ancora valido vince su tutto: è l'unica prova certa.
  const live = candidates.find((c) => c.expiresAt - now > REFRESH_MARGIN_MS);
  if (live) return live;
  // Nessuno vivo: si tenta il rinnovo sul meno vecchio, che è quello con più
  // probabilità di avere un refresh token ancora buono.
  return candidates.sort((a, b) => b.expiresAt - a.expiresAt)[0]!;
}

/** Da dove sono state lette le ultime credenziali, per riscriverci sopra. */
let _sourcePath: string | null = null;

function parseAnyFormat(raw: unknown): OAuthCredentials | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;

  // Formato Claude Code: { claudeAiOauth: { accessToken, refreshToken, expiresAt } }
  const cc = o.claudeAiOauth;
  if (cc?.accessToken && cc?.refreshToken) {
    return {
      accessToken: cc.accessToken,
      refreshToken: cc.refreshToken,
      expiresAt: Number(cc.expiresAt) || 0,
      scopes: cc.scopes,
      subscriptionType: cc.subscriptionType,
    };
  }

  // Formato jcode: { anthropic_accounts: [{ access, refresh, expires }] }
  const acct = Array.isArray(o.anthropic_accounts) ? o.anthropic_accounts[0] : null;
  if (acct?.access && acct?.refresh) {
    return {
      accessToken: acct.access,
      refreshToken: acct.refresh,
      expiresAt: Number(acct.expires) || 0,
    };
  }

  return null;
}

/**
 * Riscrive le credenziali NEL FORMATO del file da cui venivano.
 *
 * Preserva il resto del contenuto: quei file non sono nostri e contengono
 * campi che non conosciamo (altri account, preferenze). Si tocca solo ciò che
 * il rinnovo ha cambiato.
 *
 * Scrittura atomica (tmp + rename) e permessi 0600: un file di credenziali
 * scritto a metà da un crash è un utente sloggato, e leggibile dal resto del
 * sistema è peggio ancora.
 *
 * Esportata per una ragione sola: è il codice che tocca i file di credenziali
 * VERI dell'utente, e il ramo che lo esegue (token scaduto) non gira quasi mai
 * — su una macchina con un token fresco resta silenzioso per otto ore, e il
 * giorno che sbaglia lascia sloggata la CLI. Provarlo su file finti è l'unico
 * modo di sapere che funziona prima che serva.
 */
export function writeCredentials(path: string, next: OAuthCredentials): void {
  if (path === KEYCHAIN_SOURCE) { writeKeychainCredentials(next); return; }
  let doc: Record<string, any> = {};
  try { doc = JSON.parse(readFileSync(path, "utf-8")); } catch { /* si riscrive da zero */ }

  if (doc.claudeAiOauth) {
    doc.claudeAiOauth = {
      ...doc.claudeAiOauth,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
    };
  } else if (Array.isArray(doc.anthropic_accounts) && doc.anthropic_accounts[0]) {
    doc.anthropic_accounts[0] = {
      ...doc.anthropic_accounts[0],
      access: next.accessToken,
      refresh: next.refreshToken,
      expires: next.expiresAt,
    };
  } else {
    doc.claudeAiOauth = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
    };
  }

  const dir = dirname(path);
  const tmp = join(mkdtempSync(join(tmpdir(), "topics-cred-")), "cred.json");
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  void dir;
}

/**
 * Lucchetto fra processi sul file delle credenziali.
 *
 * PROTOCOLLO. Il lock è un file `<cred>.lock` creato con O_EXCL: il kernel
 * garantisce che uno solo ci riesce, anche fra processi diversi sullo stesso
 * filesystem. Chi non riesce attende, rileggendo il file ogni LOCK_RETRY_MS
 * millisecondi, fino a LOCK_TIMEOUT_MS. Dopo LOCK_STALE_MS il lock viene
 * considerato abbandonato (processo morto) e rimosso.
 *
 * DOUBLE-CHECK. Dopo aver preso il lock si RILEGGE le credenziali: se nel
 * frattempo un altro processo ha già rinnovato, il token sul disco è già fresco
 * e non si fa un secondo rinnovo — si usa quello.
 *
 * `_inFlight` resta per il caso intra-processo (dieci sessioni nello stesso
 * server che partono insieme): è il percorso veloce, senza I/O di lock.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 50;

function lockPath(credPath: string): string {
  // The Keychain has no file to sit next to: its lock lives beside the CLI's
  // legacy file, the one path every process on this machine agrees on.
  if (credPath === KEYCHAIN_SOURCE) return join(process.env.HOME || homedir(), ".claude", ".credentials.keychain.lock");
  return credPath + ".lock";
}

/** Tenta di prendere il lock. Ritorna true se riesce, false se il timeout scade. */
async function acquireLock(credPath: string): Promise<boolean> {
  const lp = lockPath(credPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // O_EXCL garantisce atomicità: uno solo fra tutti i processi ci riesce.
      const fd = openSync(lp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return true;
    } catch (e: unknown) {
      // EEXIST = qualcun altro lo tiene. Si controlla se è stantio.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;

      // Controlla se il lock è stantio (processo morto).
      try {
        const meta = JSON.parse(readFileSync(lp, "utf-8")) as { pid: number; at: number };
        if (Date.now() - meta.at > LOCK_STALE_MS) {
          // Lock abbandonato: lo rimuoviamo. Se due processi lo rilevano
          // insieme, il loser di unlink ottiene ENOENT e ricomincia il loop.
          try { unlinkSync(lp); } catch { /* già rimosso da un altro */ }
          continue;
        }
      } catch { /* lock sparito o illeggibile: si riprova */ }

      await new Promise<void>((res) => setTimeout(res, LOCK_RETRY_MS));
    }
  }
  return false;
}

function releaseLock(credPath: string): void {
  try { unlinkSync(lockPath(credPath)); } catch { /* già rimosso */ }
}

/**
 * Rinnova l'access token usando il refresh token.
 *
 * Gli header non sono decorativi: senza `user-agent` e `anthropic-beta`
 * Cloudflare risponde 403 prima ancora che Anthropic veda la richiesta. Sono
 * stati trovati per tentativi il 2026-08-16 e sono il motivo per cui questa
 * funzione ha una forma così precisa.
 */
export async function refreshCredentials(current: OAuthCredentials): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OAUTH_REFRESH_FAILED ${res.status}: ${detail.slice(0, 200)}`);
  }

  const out = (await res.json()) as Record<string, any>;
  return {
    accessToken: out.access_token,
    // Il refresh token RUOTA: tenere il vecchio significa perdere l'accesso al
    // prossimo rinnovo. Si prende quello nuovo, sempre.
    refreshToken: out.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + Number(out.expires_in ?? 28800) * 1000,
    scopes: typeof out.scope === "string" ? out.scope.split(" ") : current.scopes,
    subscriptionType: current.subscriptionType,
  };
}

/** Un rinnovo alla volta DENTRO il processo: dieci sessioni che partono insieme non ne fanno dieci. */
let _inFlight: Promise<OAuthCredentials> | null = null;

/**
 * Un access token valido, rinnovandolo se serve.
 *
 * È l'unica funzione che il resto del runtime chiama. Restituisce `null` quando
 * non c'è nessuna credenziale: il provider lo traduce in «non connesso», che è
 * ciò che vede chi non ha mai fatto login con la CLI.
 *
 * SERIALIZZAZIONE FRA PROCESSI. Il refresh token RUOTA a ogni rinnovo: due
 * processi che rinnovano in parallelo si invalidano a vicenda e chiunque tenga
 * il token precedente (compreso il server vivo su :3333) ottiene 401. Il lock
 * O_EXCL sul file `.lock` affiancato alle credenziali garantisce che un solo
 * processo alla volta esegua il rinnovo. Dopo aver preso il lock si RILEGGE il
 * file: se nel frattempo qualcun altro ha già rinnovato, si usa il suo token
 * senza fare una seconda richiesta (double-check).
 */
export async function getAccessToken(): Promise<string | null> {
  const creds = readCredentials() as (OAuthCredentials & { sourcePath?: string }) | null;
  if (!creds) return null;
  if (creds.sourcePath) _sourcePath = creds.sourcePath;

  const fresh = creds.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh) return creds.accessToken;

  const next = await renewSerialized(creds, (c) => c.expiresAt - Date.now() <= REFRESH_MARGIN_MS);
  return next.accessToken;
}

/**
 * The renewal itself, serialized twice over: one Promise per process (ten
 * sessions starting together do not renew ten times) and one lock per file
 * (two processes do not renew the same refresh token, which rotates).
 *
 * `stillStale` is the double-check run after the lock is taken: the file is
 * re-read, and if whoever held the lock before us already left a usable
 * credential there, we take that and make no request. What "usable" means
 * depends on why we came: past its expiry margin (the clock) or the very token
 * the API just refused (a 401). The two callers pass their own question.
 */
function renewSerialized(
  creds: OAuthCredentials,
  stillStale: (c: OAuthCredentials) => boolean,
): Promise<OAuthCredentials> {
  // Intra-process fast path: one Promise for everybody.
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const sourcePath = _sourcePath;

    // Without a known path we can neither lock nor save: renew without either,
    // accepting the remote race.
    if (!sourcePath) {
      return refreshCredentials(creds);
    }

    // Inter-process lock: one process at a time performs the renewal.
    const acquired = await acquireLock(sourcePath);
    try {
      // DOUBLE-CHECK: re-read the file after taking the lock. If another
      // process already renewed, what is on disk is already good.
      const reread = readCredentials() as (OAuthCredentials & { sourcePath?: string }) | null;
      if (reread && !stillStale(reread)) {
        return reread;
      }

      const next = await refreshCredentials(reread ?? creds);
      // Written WHERE it was read: see the header. A renewal that is not saved
      // logs the user's CLI out.
      try { writeCredentials(sourcePath, next); }
      catch (err) {
        console.warn(`[auth] rinnovo riuscito ma non salvato in ${sourcePath}: ${String(err)}`);
      }
      return next;
    } finally {
      if (acquired) releaseLock(sourcePath);
    }
  })().finally(() => { _inFlight = null; });

  return _inFlight;
}

/**
 * A 401 ON A TOKEN THAT LOOKED FRESH.
 *
 * `getAccessToken` renews on the clock, five minutes before `expiresAt`. But
 * the API revokes an access token the moment somebody uses the refresh token
 * that issued it, and that somebody is usually the user's own CLI, which then
 * writes the NEW pair to the same file. Measured on 2026-09-03
 * (topic:9cb7c969): `API 401: OAuth access token has been revoked` 300ms after
 * the user's message, with a perfectly good token sitting on disk the whole
 * time. The turn died on a credential that was one `readFileSync` away.
 *
 * So the recovery is, in order: re-read the file (somebody may already have
 * done the work); if the file still carries the very token that failed, renew
 * it ourselves through the usual lock. `null` means neither worked, which is
 * the one case where the refresh token itself is gone and only a new /login
 * fixes it. The caller says so in the chat instead of retrying forever.
 */
export async function recoverAfter401(staleToken: string): Promise<string | null> {
  const onDisk = readCredentials() as (OAuthCredentials & { sourcePath?: string }) | null;
  if (!onDisk) return null;
  if (onDisk.sourcePath) _sourcePath = onDisk.sourcePath;
  if (onDisk.accessToken !== staleToken) return onDisk.accessToken;
  try {
    const next = await renewSerialized(onDisk, (c) => c.accessToken === staleToken);
    return next.accessToken;
  } catch (err) {
    console.warn(`[auth] renewal after a 401 failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** C'è una credenziale utilizzabile su questa macchina? (senza rinnovarla) */
export function hasCredentials(): boolean {
  return readCredentials() !== null;
}
