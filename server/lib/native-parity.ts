/**
 * What the native runtime did NOT have and the CLI did.
 *
 * A topic on the native runtime and a `claude` session in the terminal look like
 * the same thing and were not. Measured on 02/09 on the same prompt and in the
 * same folder: the CLI answered with Opus 5, 54 skills in the listing and the
 * global user rules in context; the native one with Sonnet, ZERO skills and no
 * rules. It is not a shade of quality: it is a different agent.
 *
 * Here sit the two pieces of context that were missing. The model and the
 * thinking live elsewhere (`providers/index.ts`, `native/agent-loop.ts`) because
 * they are request parameters, not text.
 *
 * WHY ONLY FOR THE NATIVE RUNTIME. `claude` loads `~/.claude/CLAUDE.md` and the
 * skill listing on its own: injecting them again would double the same text in
 * a prompt we pay for by the token. Callers must pass `native: true`.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { skillDirs } from "./slash-command-source";

/** Past this, a rules file is an attachment, not an instruction. */
const MAX_RULES_BYTES = 64 * 1024;
/** Like Claude Code's `skillListingMaxDescChars`: the listing costs on every turn. */
const MAX_DESCRIPTION_CHARS = 180;

/**
 * `~/.claude/CLAUDE.md`, with one pass of `@path` imports expanded.
 *
 * The expansion is not a luxury: in the rules file this was measured against,
 * the tool rules ALL arrive from one `@~/.claude/jarvis/agents/_shared/TOOLS.md`,
 * so without this line the block we inject would say half of it and nobody
 * would know which half. One level only: an import that imports another stops
 * there — arbitrary depth is a way to pull a whole tree into context without
 * meaning to.
 */
export function readUserRules(home = homedir()): string | null {
  const file = join(home, ".claude", "CLAUDE.md");
  if (!existsSync(file)) return null;
  try {
    if (statSync(file).size > MAX_RULES_BYTES) return null;
    const raw = readFileSync(file, "utf-8");
    return raw.replace(/^@(\S+)$/gm, (intero, p: string) => {
      const abs = p.startsWith("~/") ? join(home, p.slice(2)) : resolve(dirname(file), p);
      try {
        if (!existsSync(abs) || statSync(abs).size > MAX_RULES_BYTES) return intero;
        return readFileSync(abs, "utf-8");
      } catch { return intero; }
    });
  } catch { return null; }
}

export interface SkillEntry { name: string; description: string }

/**
 * The description from the frontmatter, even when it is a YAML block.
 *
 * `description: |` followed by indented lines is as valid as the single-line
 * form, and seven skills out of forty use it: with the one-line regex alone the
 * description became literally «|» — a listing that gives the name and nothing,
 * that is, a listing the model cannot use to choose from.
 */
export function descriptionFromFrontMatter(head: string): string {
  const m = /^description:[ \t]*(.*)$/m.exec(head);
  if (!m) return "";
  const firstLine = m[1].trim();
  if (firstLine && firstLine !== "|" && firstLine !== ">" && firstLine !== "|-" && firstLine !== ">-") {
    return firstLine.replace(/^["']|["']$/g, "");
  }
  const rest = head.slice(m.index + m[0].length).split("\n").slice(1);
  const lines: string[] = [];
  for (const r of rest) {
    if (!r.trim()) { if (lines.length) break; continue; }
    if (!/^\s/.test(r)) break;            // end of the indented block
    lines.push(r.trim());
  }
  return lines.join(" ");
}

/**
 * Name and description of every installed skill, taken from the frontmatter of
 * `SKILL.md`. The body does NOT go in: that is the bargain of the mechanism — the
 * listing is always in context, the instructions load only on demand (tool `skill`).
 */
export function listSkills(home = homedir()): SkillEntry[] {
  const out: SkillEntry[] = [];
  // The folders are read DIRECTLY, not through `listSlashCommandFiles`:
  // that one dedupes by name against the commands, and five skills whose name
  // is also a command (`commit`, `recap`, `vai`…) dropped out of the listing   allow-italian: `vai` is the command's own name
  // even though they were installed.
  const seen = new Set<string>();
  const files: Array<{ name: string; file: string }> = [];
  for (const dir of skillDirs(home)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (seen.has(name)) continue;
      const md = join(dir, name, "SKILL.md");
      if (!existsSync(md)) continue;
      seen.add(name);
      files.push({ name: name, file: md });
    }
  }
  for (const f of files) {
    let description = "";
    try {
      description = descriptionFromFrontMatter(readFileSync(f.file, "utf-8").slice(0, 8192));
    } catch { /* skill with no readable frontmatter: the name stays */ }
    if (description.length > MAX_DESCRIPTION_CHARS) description = description.slice(0, MAX_DESCRIPTION_CHARS) + "…";
    out.push({ name: f.name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The system block that presents the listing. Empty = no skill installed. */
export function skillsBlock(home = homedir()): string {
  const skills = listSkills(home);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return [
    "## Skill disponibili",
    "",
    "Procedure già scritte per compiti ricorrenti. Quando il compito corrisponde a una",
    "di queste, chiama il tool `skill` con il suo nome PRIMA di improvvisare: quello che",
    "torna sono le istruzioni da seguire al posto del tuo approccio di default.",
    "Se l'utente scrive `/<nome>`, è una richiesta esplicita di invocarla.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * EFFORT BECOMES A THINKING BUDGET.
 *
 * On `claude` the effort is a CLI flag; on the API it is `thinking.budget_tokens`,
 * and the native runtime was not sending it at all — so the effort slider, which
 * the UI shows on every topic, moved nothing on the native runtime.
 *
 * `low` = no thinking (not «a little»): under 1024 tokens the API refuses, and a
 * symbolic budget would buy latency for reasoning that does not fit.
 *
 * The budget must stay UNDER `max_tokens`, or the request is invalid: the caller
 * either raises the ceiling or trims the budget, and that choice lives in
 * `agent-loop` because that is where `max_tokens` for the turn is known.
 */
export const THINKING_BUDGET: Record<string, number> = {
  low: 0,
  medium: 4_000,
  high: 10_000,
  xhigh: 24_000,
  max: 32_000,
};

export function thinkingBudgetFor(effort: string | null | undefined): number {
  return THINKING_BUDGET[(effort ?? "").trim().toLowerCase()] ?? 0;
}
