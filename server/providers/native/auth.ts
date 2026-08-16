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

import { readFileSync, writeFileSync, mkdtempSync, renameSync, chmodSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, dirname } from "path";

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
 */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

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
  const home = homedir();
  return [
    join(home, ".claude", ".credentials.json"),
    join(home, ".jcode", "auth.json"),
  ];
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
 */
function writeCredentials(path: string, next: OAuthCredentials): void {
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

/** Un rinnovo alla volta: dieci sessioni che partono insieme non ne fanno dieci. */
let _inFlight: Promise<OAuthCredentials> | null = null;

/**
 * Un access token valido, rinnovandolo se serve.
 *
 * È l'unica funzione che il resto del runtime chiama. Restituisce `null` quando
 * non c'è nessuna credenziale: il provider lo traduce in «non connesso», che è
 * ciò che vede chi non ha mai fatto login con la CLI.
 */
export async function getAccessToken(): Promise<string | null> {
  const creds = readCredentials() as (OAuthCredentials & { sourcePath?: string }) | null;
  if (!creds) return null;
  if (creds.sourcePath) _sourcePath = creds.sourcePath;

  const fresh = creds.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh) return creds.accessToken;

  if (_inFlight) return (await _inFlight).accessToken;

  _inFlight = (async () => {
    const next = await refreshCredentials(creds);
    // Si scrive DOVE si è letto: vedi l'intestazione. Un rinnovo non salvato
    // lascia sloggata la CLI dell'utente.
    if (_sourcePath) {
      try { writeCredentials(_sourcePath, next); }
      catch (err) {
        console.warn(`[auth] rinnovo riuscito ma non salvato in ${_sourcePath}: ${String(err)}`);
      }
    }
    return next;
  })();

  try {
    return (await _inFlight).accessToken;
  } finally {
    _inFlight = null;
  }
}

/** C'è una credenziale utilizzabile su questa macchina? (senza rinnovarla) */
export function hasCredentials(): boolean {
  return readCredentials() !== null;
}
