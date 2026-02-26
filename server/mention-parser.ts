import type { Database } from "bun:sqlite";

export interface ParsedMention {
  entity: string;
  entityType: "agent" | "user" | "all";
}

export interface ResolvedMention extends ParsedMention {
  resolved: boolean;
  profileId?: string;
}

/**
 * Parse @mentions from message text.
 * - @agentName => { entity: 'agentName', entityType: 'agent' }
 * - @all => { entity: 'all', entityType: 'all' }
 * Avoids false positives from email addresses and bare @ at start of lines.
 */
export function parseMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  const seen = new Set<string>();

  // Match @word patterns that are NOT part of an email (no alphanumeric/dot/+ before @)
  // The @ must be preceded by whitespace, start of string, or start of line.
  const mentionRegex = /(?:^|(?<=\s))@([a-zA-Z][a-zA-Z0-9_-]*)/gm;

  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const name = match[1];
    if (!name) continue;

    // Skip if this looks like an email address: check characters before the @
    const atIndex = match.index + (match[0].length - match[1].length - 1);
    if (atIndex > 0) {
      const charBefore = text[atIndex - 1];
      // If the character before @ is alphanumeric, dot, or +, it's likely an email
      if (charBefore && /[a-zA-Z0-9.+_-]/.test(charBefore) && !/\s/.test(charBefore)) {
        continue;
      }
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (key === "all") {
      mentions.push({ entity: "all", entityType: "all" });
    } else {
      mentions.push({ entity: name, entityType: "agent" });
    }
  }

  return mentions;
}

/**
 * Resolve parsed mentions against the agent_profiles table.
 * Returns each mention with resolved: true and profileId if the agent is found.
 */
export function resolveMentions(
  db: Database,
  mentions: ParsedMention[]
): ResolvedMention[] {
  const stmt = db.prepare(
    "SELECT id, name FROM agent_profiles WHERE LOWER(name) = LOWER(?)"
  );

  return mentions.map((m) => {
    if (m.entityType === "all") {
      return { ...m, resolved: true };
    }

    const row = stmt.get(m.entity) as { id: string; name: string } | null;
    if (row) {
      return { ...m, resolved: true, profileId: row.id };
    }
    return { ...m, resolved: false };
  });
}
