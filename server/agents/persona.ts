/**
 * `assemblePersona` is the one place that builds an agent's persona out of
 * five layers, each read once and in this fixed order:
 *
 *   1. base      `server/agents/base/SOUL.md`   shipped with the app, generic
 *   2. rules     `<home>/RULES.md`              the user's always-valid directives
 *                                               (written by the migration)
 *   3. profile   `<home>/USER.md`, else         who the user is
 *                `<workspace>/USER.md`
 *   4. identity  `<workspace>/IDENTITY.md`      who THIS agent is
 *   5. agent     `<workspace>/SOUL.md` then     this agent's own additions
 *                `<workspace>/AGENTS.md`        and operating rules
 *
 * `walled: true` is the variant for guests behind the wall: identity and
 * profile only, as the channel engine always did. SOUL and AGENTS stay out on
 * purpose, and so do the base and the rules.
 *
 * Replaces the channel engine's own reads of the four files: callers fetch
 * the result from `GET /api/agent-config/persona`, see
 * `server/routes/agent-config.ts`.
 *
 * A missing file means an empty layer, never an error.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Paths } from "../routes/agent-config";

export const PERSONA_LAYER_NAMES = ["base", "rules", "profile", "identity", "agent"] as const;
export type AgentPersonaLayerName = (typeof PERSONA_LAYER_NAMES)[number];

export interface AgentPersonaLayer {
  name: AgentPersonaLayerName;
  content: string;
  tokens: number;
  /** The files behind this layer, when it merges more than one (today only the `agent` layer
   *  does). The Configure > Context received section breaks the weight down to this level. */
  files?: { name: string; tokens: number }[];
}

export interface AgentPersona {
  agent: string;
  layers: AgentPersonaLayer[];
  text: string;
}

const BASE_SOUL_PATH = join(import.meta.dir, "base", "SOUL.md");

function readSafe(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Same heuristic as the topic context assembler (`server/context/assemble.ts`). */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

function layer(name: AgentPersonaLayerName, content: string): AgentPersonaLayer {
  return { name, content, tokens: estimateTokens(content) };
}

/** Reads the files in order, joins the non-empty ones as one layer, and keeps each file's own weight. */
function readAll(...paths: string[]): { content: string; files: { name: string; tokens: number }[] } {
  const files = paths.map((p) => ({ name: p.split("/").pop()!, tokens: estimateTokens(readSafe(p)) })).filter((f) => f.tokens > 0);
  return { content: paths.map(readSafe).filter(Boolean).join("\n\n"), files };
}

export interface AssembleOptions {
  /** Guest behind the wall: identity and profile only. */
  walled?: boolean;
}

/**
 * `workspace` is the agent's own folder (`engine.json`'s
 * `agents.<id>.workspace`, already resolved by the caller); `paths.home` is
 * the channel engine's home, next to `engine.json`.
 */
export function assemblePersona(agentId: string, workspace: string, paths: Paths, opts: AssembleOptions = {}): AgentPersona {
  const homeUser = join(paths.home, "USER.md");
  const profile = readSafe(homeUser) || readSafe(join(workspace, "USER.md"));
  const identity = layer("identity", readSafe(join(workspace, "IDENTITY.md")));
  const layers: AgentPersonaLayer[] = opts.walled
    ? [layer("profile", profile), identity].sort(
        (a, b) => PERSONA_LAYER_NAMES.indexOf(a.name) - PERSONA_LAYER_NAMES.indexOf(b.name),
      )
    : [
        layer("base", readSafe(BASE_SOUL_PATH)),
        layer("rules", readSafe(join(paths.home, "RULES.md"))),
        layer("profile", profile),
        identity,
        (() => {
          const { content, files } = readAll(join(workspace, "SOUL.md"), join(workspace, "AGENTS.md"));
          return { ...layer("agent", content), files };
        })(),
      ];
  const text = layers.filter((l) => l.content).map((l) => l.content).join("\n\n");
  return { agent: agentId, layers, text };
}
