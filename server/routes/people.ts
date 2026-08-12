/**
 * Routes — `/api/people` · I PROFILI DEGLI AMICI.
 *
 *   GET   /api/people                → la rubrica: le persone delle MIE
 *                                      organizzazioni, con la faccia se ce l'hanno
 *   GET   /api/people/:id            → una persona, col profilo GitHub fresco e
 *                                      le sue statistiche (prompt e token)
 *   PATCH /api/people/:id            → aggancia o stacca un login GitHub
 *
 * IL CONFINE È L'ORGANIZZAZIONE, e non `people` intera. `people` è una tabella
 * che cresce per ogni persona che questa macchina abbia mai incontrato, e
 * consegnarla per intero farebbe di una schermata di profili un elenco di
 * contatti che nessuno ha chiesto di pubblicare. La 084 lo dice già:
 * «le persone della mia org» è una lista chiusa, `people` no.
 *
 * LA RETE SI TOCCA SOLO AL SINGOLARE. La lista serve la copia in cache e basta,
 * anche se è vecchia o assente: N profili significa N richieste a GitHub per
 * ogni apertura, e la quota pubblica è di 60 all'ora. Il profilo fresco lo si
 * va a prendere quando si apre UNA persona, che è un gesto umano e uno alla
 * volta.
 */
import type { AppContext, RouteHandler } from "../types";
import { actingPersonId, canAdministerOrg, installationOrgId } from "../lib/orgs";
import { resolvePrincipals } from "../lib/principals";
import { profiloGitHub, profiloInCache, loginValido, type OpzioniGitHub } from "../lib/github-profile";
import { statistichePersona } from "../lib/person-stats";

export interface DipendenzePeople {
  /** Iniettabile: nessun test deve poter uscire davvero su api.github.com. */
  github?: OpzioniGitHub;
}

interface RigaPersona {
  id: string;
  display_name: string;
  email: string | null;
  github_login: string | null;
  revoked_at: number | null;
}

export function createPeopleRouter(ctx: AppContext, deps: DipendenzePeople = {}): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse } = ctx;
  const db = ctx.db as never as {
    query: (sql: string) => {
      get: (...a: unknown[]) => unknown;
      all: (...a: unknown[]) => unknown[];
      run: (...a: unknown[]) => unknown;
    };
  };

  const ioPersona = (req: Request): string | null =>
    actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);

  /**
   * Le organizzazioni di chi chiede. Dal LOOPBACK non c'è un dispositivo da cui
   * risolverle, e si ricade su quella dell'installazione: è la stessa rete
   * anti-lockout di sempre — davanti a questo Mac la rubrica si vede.
   */
  function mieOrg(req: Request): string[] {
    const deviceId = ctx.requestIdentity?.(req)?.deviceId ?? null;
    if (deviceId) {
      const p = resolvePrincipals(db as never, deviceId);
      const orgs = p.list.filter((s) => s.kind === "org").map((s) => s.id);
      if (orgs.length) return orgs;
    }
    const inst = installationOrgId(db as never);
    return inst ? [inst] : [];
  }

  /** Le persone vive delle organizzazioni indicate, senza ripetizioni. */
  function rubrica(orgIds: string[]): RigaPersona[] {
    if (!orgIds.length) return [];
    const segnaposto = orgIds.map(() => "?").join(",");
    try {
      return db.query(`
        SELECT DISTINCT p.id, p.display_name, p.email, p.github_login, p.revoked_at
          FROM people p
          JOIN org_members om ON om.person_id = p.id
         WHERE om.org_id IN (${segnaposto})
           AND om.revoked_at IS NULL
           AND om.local_blocked_at IS NULL
           AND p.revoked_at IS NULL
         ORDER BY p.display_name COLLATE NOCASE`).all(...orgIds) as RigaPersona[];
    } catch {
      return [];
    }
  }

  const persona = (id: string): RigaPersona | null => {
    try {
      return (db.query("SELECT id, display_name, email, github_login, revoked_at FROM people WHERE id = ?")
        .get(id) as RigaPersona | undefined) ?? null;
    } catch { return null; }
  };

  return async function peopleRouter(req, _url, pathname, method) {
    if (!pathname.startsWith("/api/people")) return null;

    // GET /api/people — la rubrica.
    if (method === "GET" && pathname === "/api/people") {
      const io = ioPersona(req);
      const people = rubrica(mieOrg(req)).map((r) => ({
        id: r.id,
        displayName: r.display_name,
        email: r.email,
        githubLogin: r.github_login,
        // Solo la cache: vedi l'intestazione. Un avatar che manca alla prima
        // apertura compare aprendo la persona, e da lì in poi c'è per tutti.
        github: r.github_login ? profiloInCache(db as never, r.github_login) : null,
        stats: statistichePersona(db as never, r.id),
        isMe: io !== null && r.id === io,
      }));
      return json({ people });
    }

    const params = matchRoute(pathname, "/api/people/:id");
    if (!params) return null;
    const chi = persona(params.id);
    // Fuori dalla rubrica non esiste, per ogni verbo: la stessa forma del
    // filtro sui progetti, e per la stessa ragione.
    const inRubrica = rubrica(mieOrg(req)).some((r) => r.id === params.id);
    if (!chi || chi.revoked_at !== null || !inRubrica) return errorResponse(404, "Person not found");

    if (method === "GET") {
      const github = chi.github_login
        ? await profiloGitHub(db as never, chi.github_login, deps.github ?? {})
        : null;
      return json({
        id: chi.id,
        displayName: chi.display_name,
        email: chi.email,
        githubLogin: chi.github_login,
        github,
        stats: statistichePersona(db as never, chi.id),
        isMe: ioPersona(req) === chi.id,
      });
    }

    if (method === "PATCH") {
      const body = await readJSON(req);
      if (!body) return errorResponse(400, "body required");
      if (body.githubLogin === undefined) return errorResponse(400, "githubLogin required");

      // CHI PUÒ. Il proprio login lo mette la persona stessa; quello di un altro
      // solo chi amministra l'organizzazione. Nel mezzo non c'è niente:
      // «chiunque nella stessa org» significherebbe che un collega può
      // intestarti l'identità pubblica che vuole.
      const io = ioPersona(req);
      const org = installationOrgId(db as never);
      const puo = (io !== null && io === chi.id) || (org !== null && canAdministerOrg(db as never, org, io));
      if (!puo) return errorResponse(403, "not allowed to set this person's GitHub login");

      let login: string | null;
      if (body.githubLogin === null) login = null;
      else {
        if (!loginValido(body.githubLogin)) return errorResponse(400, "invalid GitHub login");
        login = body.githubLogin as string;
      }
      try {
        db.query("UPDATE people SET github_login = ?, rev = rev + 1, updated_at = ? WHERE id = ?")
          .run(login, Date.now(), chi.id);
      } catch {
        // L'indice UNIQUE: quel login è già di un'altra persona qui dentro.
        return errorResponse(409, "that GitHub login already belongs to another person");
      }
      const github = login ? await profiloGitHub(db as never, login, deps.github ?? {}) : null;
      return json({ id: chi.id, githubLogin: login, github });
    }

    return errorResponse(405, "method not allowed");
  };
}
