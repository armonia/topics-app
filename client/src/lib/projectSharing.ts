/**
 * IS THIS PROJECT VISIBLE TO SOMEONE ELSE, AND TO WHOM.
 *
 * The question a project tab has to answer before you type into it. The
 * feedback that asked for it, verbatim: «se un progetto è condiviso con una
 * certa organizzazione, dovrei vedere l'icona dell'organizzazione sulla tab del
 * progetto stesso, in modo da ricordarmi che condivido e tutti quanti possono
 * vedere quella sessione». It is not decoration: it is the only thing standing
 * between writing something private and writing it in a session five people
 * can read. An answer you can only get by opening a menu always arrives late.
 *
 * WHY A PURE FUNCTION AND NOT A HOOK. Every rule below is a judgement call
 * about when silence is the honest answer, and each one has a way of being
 * wrong that a test can state. The fetching, the cache and the socket live in
 * `projectSharingStore.ts`; nothing here touches the network.
 *
 * THE RULE THAT IS NOT OBVIOUS, and the reason this file exists at all:
 * `org_id != null` is NOT "shared". Every project created on this installation
 * is stamped with the installation's own organisation (`projects.ts`, the
 * `orgId: installationOrgId(...)` on create), so on a single-person
 * installation that column is set on ALL of them — measured here on
 * 2026-08-25: ten projects out of ten, all pointing at an organisation whose
 * live membership is exactly one, me. A badge on every tab is a badge that
 * carries no information, and worse, it would be false: nobody else can see
 * those projects, because there is nobody else.
 *
 * So the badge follows the WARNING, not the column: it appears when the
 * organisation has someone in it besides you. That is the fact the feedback
 * asked to be reminded of.
 */

/** One organisation, as `GET /api/auth/orgs` reports it. */
export interface OrgRef {
  id: string;
  name: string;
  logoUrl: string | null;
  /** Live members, YOU INCLUDED — the same count `/api/auth/orgs` returns. */
  members: number;
}

/** The three columns of a project row this decision reads, and nothing else. */
export interface ProjectSharing {
  path: string;
  orgId: string | null;
  /** Withdrawn from the organisation's view: hidden from the others. */
  incognito: boolean;
}

/**
 * The organisation this project is shared with, or `null` when the honest
 * answer is "nobody else" — or "I do not know yet".
 *
 * Both of those return `null` on purpose. A badge is a claim about who is
 * watching; the only two states worth rendering are "shared with THEM" and
 * silence. There is no third glyph for "loading", because a badge that appears
 * and then disappears teaches the eye to ignore it.
 */
export function sharedWith(
  path: string | null | undefined,
  projects: ReadonlyMap<string, ProjectSharing>,
  orgs: ReadonlyMap<string, OrgRef>,
): OrgRef | null {
  if (!path) return null;

  const p = projects.get(path);
  // A path the index does not know is a question, not a "no": the index may
  // simply not have landed yet. Either way there is nothing to name.
  if (!p || p.orgId === null) return null;

  // `incognito` is the explicit opt-out, and it wins over membership: the
  // owner has already said the others must not see it.
  if (p.incognito) return null;

  const org = orgs.get(p.orgId);
  // An organisation the index cannot name would produce «condiviso con ?», and
  // the whole point of the badge is the WITH WHOM.
  if (!org) return null;

  // The line this file exists for: an organisation whose only live member is
  // you shares this project with nobody. See the header.
  return org.members > 1 ? org : null;
}

/** The tooltip. Says WITH WHOM, because the icon alone says «shared» and the
 *  question anyone actually has is «with them?». */
export function sharedTitle(org: OrgRef): string {
  // allow-italian: user-facing string, shown in the app's language
  return `Condiviso con ${org.name}: ${org.members} membri lo vedono`;
}
