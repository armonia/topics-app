/**
 * What the «/» menu of a chat lists besides Topics' own commands (CMDUI-01):
 * the engine's group and «your skills», for the engine the topic DECLARES
 * (CMD-08).
 *
 *  - Claude Code: the engine's group is the CLI's own word (`init` and
 *    `commands_changed`, `engineCommandsFor`): its built-in and bundled names.
 *    «Your skills» are the commands and skills on disk (switched-off ones left
 *    out) plus whatever else the CLI listed that is not its own (a plugin's
 *    skills, which no folder Topics knows holds).
 *  - Topics' native engine: no engine group (it has no commands), and the
 *    skills its prompt lists and its `skill` tool loads (`listSkills`). Only
 *    skills: that tool refuses a `commands/*.md`.
 *  - An ACP agent (jcode, gemini): the commands it announced.
 *  - Codex, the API engines, OpenClaw: nothing. A typed `/name` is prose there.
 *
 * Before an engine has said anything since the server started, Claude Code
 * gets «your skills» from the folders as before and no engine group: nothing
 * is spawned to ask (a CLI is hundreds of MB).
 *
 * Which names become a control, a refusal or a hidden row is the client's map
 * (`client/src/components/Chat/commandMap.ts`); here only where they come from.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import CLI_COMMANDS from "../../shared/claude-cli-commands.json";
import { listSkills } from "./native-parity";
import { disabledSkillNames, engineCommandsFor, listSlashCommandFiles, type EngineCommand, type SlashCommandKind } from "./slash-command-source";

export interface SlashMenuEntry {
  name: string;
  description: string;
  kind: SlashCommandKind;
  /** `engine` = the engine's own command; `skills` = the person's commands and skills. */
  group: "engine" | "skills";
  argumentHint?: string;
}

/** The CLI's own and bundled names, measured on 2.1.288: the split when `commands_changed` has not said `builtin` yet. */
const CLI_OWN = new Set<string>(CLI_COMMANDS.headless);

/** The first description line of a command or skill file, as the menu shows it. */
export function describeSlashFile(file: string): string {
  try {
    const text = readFileSync(file, "utf-8");
    const fm = text.match(/^---[\s\S]*?\n\s*description:\s*(.+?)\s*(?:\n|$)/i);
    if (fm) return fm[1]!.replace(/^["']|["']$/g, "").slice(0, 100);
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t === "---" || t.startsWith("#")) continue;
      return t.slice(0, 100);
    }
  } catch { /* unreadable: no description */ }
  return "";
}

function fromEngine(c: EngineCommand, group: SlashMenuEntry["group"]): SlashMenuEntry {
  return {
    name: c.name,
    description: (c.description ?? "").slice(0, 100),
    kind: group === "engine" ? "command" : "skill",
    group,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  };
}

export interface SlashMenuQuery {
  /** The engine the topic declares (`declaredProviderName`), or null without a topic. */
  provider: string | null;
  sessionKey?: string | null;
  /** The topic's project, where its CLI runs. */
  projectPath?: string | null;
  /** The folder the project's commands are read from (the project, else the server's). */
  cwd: string;
  home?: string;
}

export function slashMenuEntries(q: SlashMenuQuery): SlashMenuEntry[] {
  const home = q.home ?? homedir();
  const disk = (): SlashMenuEntry[] =>
    listSlashCommandFiles({ home, cwd: q.cwd }).map(({ name, file, kind }) => ({ name, description: describeSlashFile(file), kind, group: "skills" as const }));

  // No topic (a draft before its first send): the folders, as the menu always had.
  if (!q.provider) return sortByName(disk());

  if (q.provider === "topics") {
    return listSkills(home, q.cwd).map((s) => ({ name: s.name, description: s.description.slice(0, 100), kind: "skill" as const, group: "skills" as const }));
  }

  const said = engineCommandsFor({ sessionKey: q.sessionKey, provider: q.provider, projectPath: q.projectPath });

  if (q.provider === "claude-code") {
    const skills = disk();
    if (!said) return sortByName(skills);
    // `builtin` is known once `commands_changed` has spoken; before, the measured list.
    const marksOwnCommands = said.some((c) => c.builtin !== undefined);
    const isOwn = (c: EngineCommand) => (marksOwnCommands ? c.builtin === true : CLI_OWN.has(c.name));
    const engine = said.filter(isOwn).map((c) => fromEngine(c, "engine"));
    const onDisk = new Set(skills.map((s) => s.name));
    // A list borrowed from another chat may carry a skill switched off here.
    const off = disabledSkillNames(home, q.cwd);
    const extra = said.filter((c) => !isOwn(c) && !onDisk.has(c.name) && !off.has(c.name)).map((c) => fromEngine(c, "skills"));
    // A disk entry without a description takes the CLI's.
    const described = new Map(said.map((c) => [c.name, c.description ?? ""] as const));
    for (const s of skills) if (!s.description) s.description = (described.get(s.name) ?? "").slice(0, 100);
    return [...sortByName(engine), ...sortByName([...skills, ...extra])];
  }

  // An ACP agent's announced commands; nothing for an engine that announces none.
  return said ? sortByName(said.map((c) => fromEngine(c, "engine"))) : [];
}

function sortByName(list: SlashMenuEntry[]): SlashMenuEntry[] {
  return list.sort((a, b) => a.name.localeCompare(b.name));
}
