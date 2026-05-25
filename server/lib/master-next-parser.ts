/**
 * master-next-parser — pure parser for the Master's `## Next` output contract.
 *
 * The Master (Agent Teams lead) ends every reply with a `## Next` block listing
 * per-session proposals using ALL-CAPS leading verbs:
 *   - COMPLETA (alias ARCHIVIA) → the session's work is done; resolve it.
 *   - APRI                      → the user must act IN that session.
 *
 * This module turns that free-text block into structured proposals that the
 * server can upsert into the persistent kanban (see refactor-master-into-kanban,
 * AD-3/AD-5). It is framework-free and side-effect-free so it can be unit-tested
 * with `bun:test`. It mirrors the original client logic that lived in
 * MasterBoardStrip.tsx, which is being removed in favour of kanban cards.
 *
 * Parsing degrades gracefully: unknown verbs, malformed rows, and rows that
 * reference no known session are skipped — never thrown.
 */

/** Canonical proposal verb. ARCHIVIA normalizes to "completa". */
export type ProposalVerb = "completa" | "apri";

/** Minimal session shape the parser needs to bind a row to a session. */
export interface NextSessionRef {
  topicId: string;
  name: string;
}

export interface ParsedProposal {
  verb: ProposalVerb;
  /** topicId of the session this proposal targets. */
  topicId: string;
  /** Cleaned, human-readable reason / next action (≤ 240 chars). */
  reason: string;
}

// Verbs we render as kanban cards. COMPLETA is canonical; ARCHIVIA is a
// retro-compat alias so older Master replies still parse.
const VERB_RE = /\b(COMPLETA|ARCHIVIA|APRI)\b/i;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const BOLD_RE = /\*\*([^*\n]+)\*\*/;
const BULLET_RE = /^[-*]\s+/;
// Section headers we recognize only to RESET the current section, so bullets
// under a non-card verb (ATTENDI, etc.) don't inherit the previous verb.
const ANY_SECTION_VERB_RE = /\b(COMPLETA|ARCHIVIA|APRI|ATTENDI|SEEDA|EMPTY|WAIT|PROSEGUE|MONITORA|IGNORA)\b/i;

/** Normalize a raw verb match into the canonical lowercase form. */
function canonicalVerb(raw: string): ProposalVerb {
  const lo = raw.toLowerCase();
  if (lo === "archivia") return "completa";
  return lo as ProposalVerb;
}

/**
 * Extract the body of the `## Next` (or `### Next` / `## Next action`) block
 * from a Master assistant message. Returns null if there is no such block.
 */
export function parseNextBlock(md: string | undefined | null): string | null {
  if (!md) return null;
  const re = /^#{2,3}\s*Next(?:\s+action)?\s*$/im;
  const match = md.match(re);
  if (!match || match.index === undefined) return null;
  const rest = md.slice(match.index + match[0].length);
  const stop = rest.match(/^#{2,3}\s+\S/m);
  const body = (stop ? rest.slice(0, stop.index) : rest).trim();
  return body || null;
}

/** Clean a row body into a presentable reason string. */
function cleanReason(body: string): string {
  return body
    .replace(VERB_RE, "")
    .replace(/`?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`?/gi, "")
    .replace(BOLD_RE, "")
    .replace(/^[\s:—\-–`]+/, "")
    // Drop a leading "(projectName) — " / "(projectName): " — redundant noise.
    .replace(/^\(([^)]+)\)\s*[—–\-:]\s*/u, "")
    .replace(/\s+—\s+/g, " — ")
    .replace(/`{2,}/g, "")
    // Sentence-case the first letter so reasons read uniformly.
    .replace(/^([a-zà-ú])/u, (c) => c.toUpperCase())
    .slice(0, 240)
    .trim();
}

/**
 * Parse the `## Next` block of a Master message into structured proposals,
 * binding each row to a known session by UUID, **bold name**, or substring.
 * Rows that bind to no known session are skipped. De-dupes by (topicId, verb).
 */
export function parseNextActions(
  md: string | undefined | null,
  sessions: NextSessionRef[],
): ParsedProposal[] {
  const block = parseNextBlock(md);
  if (!block || sessions.length === 0) return [];

  const byId = new Map(sessions.map((s) => [s.topicId.toLowerCase(), s]));
  const byName = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));
  const out: ParsedProposal[] = [];
  const seen = new Set<string>();
  let currentSection: ProposalVerb | null = null;

  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (!BULLET_RE.test(line)) {
      const stripped = line.replace(/^\*+|\*+$/g, "").replace(/\*\*/g, "").trim();
      const m = stripped.match(VERB_RE);
      if (m && stripped.length < 200) {
        currentSection = canonicalVerb(m[1]);
        continue;
      }
      const am = stripped.match(ANY_SECTION_VERB_RE);
      if (am && stripped.length < 200) {
        currentSection = null;
        continue;
      }
      continue;
    }

    const body = line.replace(BULLET_RE, "");

    let verb: ProposalVerb | null = null;
    const bv = body.match(VERB_RE);
    if (bv) verb = canonicalVerb(bv[1]);
    else if (currentSection) verb = currentSection;
    else continue;

    let session: NextSessionRef | null = null;
    const uu = body.match(UUID_RE);
    if (uu && byId.has(uu[1].toLowerCase())) session = byId.get(uu[1].toLowerCase()) ?? null;
    if (!session) {
      const bn = body.match(BOLD_RE);
      if (bn) session = byName.get(bn[1].trim().toLowerCase()) ?? null;
    }
    if (!session) {
      for (const s of sessions) {
        if (s.name.length < 3) continue;
        if (body.toLowerCase().includes(s.name.toLowerCase())) { session = s; break; }
      }
    }
    if (!session) continue;

    const dedupeKey = session.topicId + ":" + verb;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ verb, topicId: session.topicId, reason: cleanReason(body) });
  }

  return out;
}
