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
 * EFFORT BECOMES A REQUEST PARAMETER, AND WHICH ONE DEPENDS ON THE MODEL.
 *
 * On `claude` the effort is a CLI flag. On the API it is two different things
 * depending on the generation, and the native runtime sent the wrong one to
 * every model that matters: a fixed `thinking.budget_tokens` picked from the
 * tier. Measured on 2026-09-03 against the request the loop builds: with the
 * default `claude-sonnet-5` and effort `high` the body carried
 * `{type: "enabled", budget_tokens: 10000}`, which the 5 family rejects with a
 * 400 (`budget_tokens` is removed there), and `low` produced no thinking at all
 * on models where thinking is the default and cannot be switched off (Fable 5
 * refuses `disabled`, Opus 5 refuses it at `xhigh`/`max`). So the slider that
 * every topic shows did, on the native runtime, nothing the user expected.
 *
 * The rule, per the live docs (see the claude-api skill, "Thinking & Effort"):
 *
 *   - Fable, Mythos, Opus 5+, Opus 4.7/4.8, Sonnet 5+: `thinking: {type:
 *     "adaptive"}` plus `output_config: {effort}`, all five tiers, `low`
 *     included. `low` is NOT "no thinking": it is the model deciding to think
 *     less, which is what the CLI does too.
 *   - Opus 4.6 / Sonnet 4.6: adaptive must be EXPLICIT (default is off) and
 *     `xhigh` did not exist yet, so it clamps to `high`.
 *   - Older (Haiku 4.5, Sonnet 4.5, Opus 4.5 and unknowns): the legacy
 *     `{type: "enabled", budget_tokens}` from the table below, and no
 *     `output_config`. There `low` is still no thinking: under 1024 tokens the
 *     API refuses, and a symbolic budget would buy latency for reasoning that
 *     does not fit.
 *
 * A legacy budget must stay UNDER `max_tokens` or the request is invalid:
 * `minMaxTokens` is the floor the caller raises the cap to. Raising rather
 * than trimming, because cutting the reasoning to spare the cap would be
 * choosing silently for whoever moved the slider.
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

const EFFORT_TIERS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface ThinkingConfig {
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
  output_config?: { effort: string };
  /** The floor for `max_tokens`: a legacy budget has to fit under the cap. */
  minMaxTokens: number;
}

/**
 * Which generation a bare model id belongs to, for the gate above. `[1m]` is
 * a convention of ours and never reaches the API: strip it before asking.
 */
function generationOf(model: string): "adaptive" | "adaptive-4-6" | "legacy" {
  const bare = model.replace(/\[1m\]$/, "");
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?/.exec(bare);
  if (!m) return "legacy";
  const family = m[1]!;
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  if (family === "fable" || family === "mythos") return "adaptive";
  if (family === "opus") {
    if (major >= 5 || (major === 4 && minor >= 7)) return "adaptive";
    if (major === 4 && minor === 6) return "adaptive-4-6";
    return "legacy";
  }
  if (family === "sonnet") {
    if (major >= 5) return "adaptive";
    if (major === 4 && minor === 6) return "adaptive-4-6";
    return "legacy";
  }
  return "legacy";
}

export function thinkingConfigFor(model: string, effort: string | null | undefined): ThinkingConfig {
  const tier = (effort ?? "").trim().toLowerCase();
  const gen = generationOf(model);
  if (gen === "legacy") {
    const budget = thinkingBudgetFor(tier);
    return budget > 0
      ? { thinking: { type: "enabled", budget_tokens: budget }, minMaxTokens: budget + 4096 }
      : { minMaxTokens: 0 };
  }
  const out: ThinkingConfig = { thinking: { type: "adaptive" }, minMaxTokens: 0 };
  if (EFFORT_TIERS.has(tier)) {
    out.output_config = { effort: gen === "adaptive-4-6" && tier === "xhigh" ? "high" : tier };
  }
  return out;
}

/**
 * The output cap the native runtime asks for when nobody set one.
 *
 * 64k is the CLI catalog default for opus-5 / sonnet-5 / fable-5 / opus-4-6,
 * and equals haiku-4-5's upper bound, so no model in the picker gets a 400.
 * The previous 16384 was half the CLI's: any single `write_file` above ~16k
 * tokens of output could never succeed on this runtime while it did on the
 * CLI, and the user was told to split the work by hand.
 */
export const DEFAULT_MAX_TOKENS = 64_000;
const MIN_MAX_TOKENS = 1_024;
const MAX_MAX_TOKENS = 128_000;

/**
 * A user-set cap, kept inside what the API accepts. `undefined`, NaN or a
 * non-positive value means "nobody set one" and falls back to the default:
 * a setting typed wrong must not turn into a request the API refuses.
 */
export function clampMaxTokens(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(n)));
}
