/**
 * IL PROFILO PUBBLICO DI UN LOGIN GITHUB, con la sua cache.
 *
 * Tre cose, e sono tutte difese contro lo stesso guasto — una lista di amici
 * che, ogni volta che viene disegnata, va sulla rete una volta per riga:
 *
 *  1. SI LEGGE SEMPRE DALLA CACHE, e si esce sulla rete solo se la copia è più
 *     vecchia di `TTL_MS`. L'API pubblica di GitHub concede 60 richieste
 *     all'ora a chi non si autentica: otto amici sono otto richieste, e una
 *     schermata che si ridisegna finisce la quota prima di pranzo.
 *  2. ANCHE IL FALLIMENTO SI RICORDA. Un login che non esiste è un 404 stabile:
 *     senza `failed_at` lo si richiederebbe a ogni disegno, cioè si userebbe
 *     tutta la quota per riscoprire una cosa già saputa. Il ritento è più
 *     rapido del successo (`TTL_ERRORE_MS`) perché un 403 da quota finita passa
 *     da sé.
 *  3. NON FALLISCE MAI VERSO L'ALTO. Rete giù, quota finita, GitHub che
 *     risponde qualcosa di inatteso: si consegna la copia vecchia se c'è, `null`
 *     se non c'è. Una faccia che manca è un dettaglio; una schermata dei
 *     profili che va in errore perché GitHub ha starnutito non lo è.
 *
 * NESSUN TOKEN, e volutamente: qui si legge solo ciò che è pubblico. Chiedere
 * all'utente un personal access token per mostrare un avatar sarebbe chiedere
 * una credenziale in cambio di una decorazione.
 */
import type { Database } from "bun:sqlite";

type Db = Pick<Database, "query">;

/** Le regole vere dei login GitHub: alfanumerici e trattini, non in testa/coda, max 39. */
const LOGIN_VALIDO = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

const TTL_MS = 6 * 60 * 60 * 1000;
const TTL_ERRORE_MS = 30 * 60 * 1000;

export interface ProfiloGitHub {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  /**
   * The two fields GitHub prints right under the bio: the website and the X
   * handle. They are cached for the same reason as the avatar and not for a
   * different one: a header that has to go to the network to draw a link is a
   * header that spends the hourly quota on decoration.
   *
   * Both are what GitHub returns and nothing more. `blog` is a free-text field
   * over there, so it can hold a bare host with no scheme, and it is stored
   * verbatim: normalising it here would mean guessing, and a guess written
   * into a cache is a guess that outlives the page that made it.
   */
  blog: string | null;
  twitterUsername: string | null;
  publicRepos: number | null;
  followers: number | null;
  /** Quando questa copia è stata scaricata. `null` = non è mai riuscita. */
  fetchedAt: number | null;
}

export function loginValido(login: unknown): login is string {
  return typeof login === "string" && LOGIN_VALIDO.test(login);
}

interface Riga {
  login: string; name: string | null; avatar_url: string | null; html_url: string | null;
  bio: string | null; company: string | null; location: string | null;
  blog: string | null; twitter_username: string | null;
  public_repos: number | null; followers: number | null;
  fetched_at: number | null; failed_at: number | null; status: number | null;
}

const rigaAProfilo = (r: Riga): ProfiloGitHub => ({
  login: r.login,
  name: r.name, avatarUrl: r.avatar_url, htmlUrl: r.html_url, bio: r.bio,
  company: r.company, location: r.location,
  // `?? null` and not a bare read: the row comes from `SELECT *`, so on a
  // database written before these two columns existed the field is `undefined`
  // rather than `null`, and `undefined` is the value that disappears from
  // `JSON.stringify` and makes a client read "the key is missing" where the
  // truth is "we have not cached it".
  blog: r.blog ?? null, twitterUsername: r.twitter_username ?? null,
  publicRepos: r.public_repos, followers: r.followers,
  fetchedAt: r.fetched_at,
});

function inCache(db: Db, login: string): Riga | null {
  try {
    return (db.query("SELECT * FROM github_profiles WHERE lower(login) = lower(?)").get(login) as Riga | undefined)
      ?? null;
  } catch {
    return null; // schema anteriore alla 094
  }
}

/** Solo la copia già scaricata, senza toccare la rete: è ciò che serve a una LISTA. */
export function profiloInCache(db: Db, login: string): ProfiloGitHub | null {
  const r = inCache(db, login);
  return r && r.fetched_at !== null ? rigaAProfilo(r) : null;
}

function fresca(r: Riga | null, ora: number): boolean {
  if (!r) return false;
  if (r.fetched_at !== null) return ora - r.fetched_at < TTL_MS;
  if (r.failed_at !== null) return ora - r.failed_at < TTL_ERRORE_MS;
  return false;
}

export interface OpzioniGitHub {
  /** Iniettabile per i test: nessuno di essi deve poter uscire davvero sulla rete. */
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
}

/**
 * Il profilo di `login`, dalla cache o da GitHub. Mai un'eccezione verso il
 * chiamante: `null` significa «non l'abbiamo».
 */
export async function profiloGitHub(
  db: Db,
  login: string,
  o: OpzioniGitHub = {},
): Promise<ProfiloGitHub | null> {
  if (!loginValido(login)) return null;
  const ora = (o.now ?? Date.now)();
  const cache = inCache(db, login);
  if (fresca(cache, ora)) return cache!.fetched_at !== null ? rigaAProfilo(cache!) : null;

  const f = o.fetch ?? fetch;
  const base = o.baseUrl ?? "https://api.github.com";
  try {
    const res = await f(`${base}/users/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "topics-app" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      scriviFallimento(db, login, ora, res.status);
      // La copia VECCHIA vale più di niente: un 403 da quota finita non deve
      // far sparire una faccia che abbiamo già.
      return cache?.fetched_at !== null && cache ? rigaAProfilo(cache) : null;
    }
    const j = (await res.json()) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
    const num = (k: string) => (typeof j[k] === "number" ? (j[k] as number) : null);
    const profilo: ProfiloGitHub = {
      // Il login CANONICO è quello che risponde GitHub, non quello digitato:
      // le maiuscole le decide loro.
      login: str("login") ?? login,
      name: str("name"), avatarUrl: str("avatar_url"), htmlUrl: str("html_url"),
      bio: str("bio"), company: str("company"), location: str("location"),
      blog: str("blog"), twitterUsername: str("twitter_username"),
      publicRepos: num("public_repos"), followers: num("followers"),
      fetchedAt: ora,
    };
    scriviProfilo(db, profilo, ora);
    return profilo;
  } catch {
    scriviFallimento(db, login, ora, 0);
    return cache && cache.fetched_at !== null ? rigaAProfilo(cache) : null;
  }
}

function scriviProfilo(db: Db, p: ProfiloGitHub, ora: number): void {
  try {
    db.query(`
      INSERT INTO github_profiles (login, name, avatar_url, html_url, bio, company, location,
                                   blog, twitter_username,
                                   public_repos, followers, fetched_at, failed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 200)
      ON CONFLICT(login) DO UPDATE SET
        name = excluded.name, avatar_url = excluded.avatar_url, html_url = excluded.html_url,
        bio = excluded.bio, company = excluded.company, location = excluded.location,
        blog = excluded.blog, twitter_username = excluded.twitter_username,
        public_repos = excluded.public_repos, followers = excluded.followers,
        fetched_at = excluded.fetched_at, failed_at = NULL, status = 200
    `).run(p.login, p.name, p.avatarUrl, p.htmlUrl, p.bio, p.company, p.location,
           p.blog, p.twitterUsername,
           p.publicRepos, p.followers, ora);
  } catch { /* la cache che non si scrive costa una richiesta in più, non un errore */ }
}

function scriviFallimento(db: Db, login: string, ora: number, status: number): void {
  try {
    db.query(`
      INSERT INTO github_profiles (login, fetched_at, failed_at, status)
      VALUES (?, NULL, ?, ?)
      ON CONFLICT(login) DO UPDATE SET failed_at = excluded.failed_at, status = excluded.status
    `).run(login, ora, status);
  } catch { /* idem */ }
}
