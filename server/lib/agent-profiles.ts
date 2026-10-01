/**
 * The sub-agent profiles `spawn_agent` can name with `agent_type`
 * (SUBAGENT-09): the same files the Claude CLI loads for its own `--agent`,
 * `~/.claude/agents/*.md` and then `<cwd>/.claude/agents/*.md`, the project
 * winning on a name clash.
 *
 * Topics reads the frontmatter only, and only for three things: to refuse a
 * name the CLI would not find, to pass the profile's `model` and `effort`
 * explicitly (so the spawn answer says what really starts), and to list the
 * profiles in the tool description. The system prompt and the `tools:` list
 * are the CLI's business.
 *
 * Pure apart from the directory reads, which take their roots as arguments so
 * a test can hand it a fake home.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface AgentProfile {
  name: string;
  /** The frontmatter `description`, whole. */
  description: string;
  model: string | null;
  effort: string | null;
  source: "user" | "project";
  path: string;
}

/** The longest summary one profile gets in the tool description. */
export const PROFILE_SUMMARY_MAX = 120;

/**
 * The `key: value` lines of a leading `---` block, or null when the file has
 * none. A profile without frontmatter is not a profile the CLI can load by
 * name, so it is skipped, not reported.
 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]!] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function profilesIn(dir: string, source: AgentProfile["source"]): AgentProfile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: AgentProfile[] = [];
  for (const file of names) {
    const path = join(dir, file);
    let fm: Record<string, string> | null;
    try {
      fm = parseFrontmatter(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    if (!fm) continue;
    const name = (fm.name || file.slice(0, -".md".length)).trim();
    if (!name) continue;
    out.push({
      name,
      description: fm.description ?? "",
      model: fm.model || null,
      effort: fm.effort || null,
      source,
      path,
    });
  }
  return out;
}

/** Every profile visible from `cwd`, by name; the project's file wins over the user's. */
export function readAgentProfiles(opts: { home: string; cwd?: string | null }): Map<string, AgentProfile> {
  const byName = new Map<string, AgentProfile>();
  for (const p of profilesIn(join(opts.home, ".claude", "agents"), "user")) byName.set(p.name, p);
  if (opts.cwd) {
    for (const p of profilesIn(join(opts.cwd, ".claude", "agents"), "project")) byName.set(p.name, p);
  }
  return byName;
}

/** The first sentence of a description, cut to `PROFILE_SUMMARY_MAX` characters. */
export function profileSummary(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > PROFILE_SUMMARY_MAX ? `${sentence.slice(0, PROFILE_SUMMARY_MAX - 1)}…` : sentence;
}

/** The `agent_type` parameter's description, listing what the server can see right now. */
export function agentTypeDescription(profiles: ReadonlyMap<string, AgentProfile>): string {
  const head =
    "Optional profile to start the sub-agent from: its system prompt, tools, model and effort, read from ~/.claude/agents and the project's .claude/agents.";
  if (profiles.size === 0) return `${head} None is installed on this machine.`;
  const lines = [...profiles.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `- ${p.name}: ${profileSummary(p.description) || "(no description)"}`);
  return `${head} Available:\n${lines.join("\n")}`;
}
