/**
 * An agent's name and job as its `IDENTITY.md` declares them, read and
 * written in the file's own format. The agents' folders hold two formats:
 *
 * - fields: a title line (`# IDENTITY.md - Who Am I?`), then list items such
 *   as `- **Name:** <name>` and `- **Creature:** <what it does>`. The title is
 *   the file's, never the agent's name.
 * - heading: `# <name>`, then the job on the next non-empty line. This is what
 *   `createAgent` writes.
 *
 * One reader and one writer for the server (`readIdentity`, the roster behind
 * every page) and the client (Configure > Identity and Job), so a page never
 * shows the file's title as a name and a save never rewrites the file into
 * the other format. A write changes only the value it is given and keeps
 * every other byte.
 */

export interface AgentIdentity {
  name: string;
  job: string;
}

/** Labels of the fields format, in order of preference for the job. */
const NAME_LABEL = "Name";
const JOB_LABELS = ["Creature", "Role", "Job"] as const;

function fieldLine(label: string): RegExp {
  return new RegExp(`^(\\s*[-*]?\\s*\\*\\*${label}:\\*\\*[ \\t]*)(.*)$`, "m");
}

/** `Visione (id \`gtm\`)` -> `Visione`: the id note is for people reading the file, not part of the name. */
function cleanName(value: string): string {
  return value.replace(/\s*\(id\s[^)]*\)\s*$/i, "").trim();
}

function isFieldsFormat(text: string): boolean {
  return fieldLine(NAME_LABEL).test(text);
}

function readFields(text: string): AgentIdentity {
  const name = cleanName(fieldLine(NAME_LABEL).exec(text)?.[2] ?? "");
  let job = "";
  for (const label of JOB_LABELS) {
    const m = fieldLine(label).exec(text);
    if (m) { job = m[2].trim(); break; }
  }
  return { name, job };
}

/** Index of the `# name` line and of the job line under it (-1 when absent). */
function headingLines(lines: string[]): { heading: number; job: number } {
  const heading = lines.findIndex((l) => l.trim().startsWith("# "));
  if (heading < 0) return { heading, job: -1 };
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    return { heading, job: line.startsWith("#") ? -1 : i };
  }
  return { heading, job: -1 };
}

export function parseIdentity(text: string): AgentIdentity {
  if (isFieldsFormat(text)) return readFields(text);
  const lines = text.split("\n");
  const { heading, job } = headingLines(lines);
  return {
    name: heading < 0 ? "" : lines[heading].trim().slice(2).trim(),
    job: job < 0 ? "" : lines[job].trim(),
  };
}

/**
 * The same text with the name and/or the job replaced, in the format the
 * text already uses. An empty text becomes `# name\njob\n`.
 */
export function writeIdentity(text: string, change: Partial<AgentIdentity>): string {
  if (isFieldsFormat(text)) {
    let out = text;
    if (change.name !== undefined) {
      const re = fieldLine(NAME_LABEL);
      const current = re.exec(out)?.[2] ?? "";
      // keep the id note the file had: only the name itself changes
      const note = current.slice(cleanName(current).length);
      out = out.replace(re, (_m, lead: string) => `${lead}${change.name}${note}`);
    }
    if (change.job !== undefined) {
      const label = JOB_LABELS.find((l) => fieldLine(l).test(out));
      if (label) out = out.replace(fieldLine(label), (_m, lead: string) => `${lead}${change.job}`);
      else out = out.replace(fieldLine(NAME_LABEL), (line) => `${line}\n- **${JOB_LABELS[0]}:** ${change.job}`);
    }
    return out;
  }
  if (!text.trim()) return `# ${change.name ?? ""}\n${change.job ?? ""}\n`;
  const lines = text.split("\n");
  const { heading, job } = headingLines(lines);
  if (heading < 0) return `# ${change.name ?? ""}\n${change.job ?? ""}\n\n${text}`;
  if (change.name !== undefined) lines[heading] = `# ${change.name}`;
  if (change.job !== undefined) {
    if (job >= 0) lines[job] = change.job;
    else lines.splice(heading + 1, 0, change.job);
  }
  return lines.join("\n");
}
