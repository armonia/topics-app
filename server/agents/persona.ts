/**
 * `assemblePersona` — the one place that builds an agent's full persona out
 * of four layers, each read exactly once and in this fixed order:
 *
 *   1. base      `server/agents/base/SOUL.md`     shipped with the app, generic
 *   2. user      `<home>/USER.md`                 who the user is, their
 *                                                  always-valid directives
 *   3. identity  `<workspace>/IDENTITY.md`         who THIS agent is
 *   4. agent     `<workspace>/SOUL.md`             this agent's own additions
 *                                                  (e.g. permissions naming people)
 *
 * Replaces the channel engine's own reads of all four files
 * (`jarvis-channels`'s `engine.rs`): callers there fetch the assembled
 * persona from `GET /api/agent-config/persona` instead, see
 * `server/routes/agent-config.ts`.
 *
 * A missing file means an empty layer, never an error: an agent with only an
 * IDENTITY.md still gets base + (empty) user + identity + (empty) agent.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Paths } from "../routes/agent-config";

export const PERSONA_LAYER_NAMES = ["base", "user", "identity", "agent"] as const;
export type PersonaLayerName = (typeof PERSONA_LAYER_NAMES)[number];

export interface PersonaLayer {
  name: PersonaLayerName;
  content: string;
  tokens: number;
}

export interface Persona {
  agent: string;
  layers: PersonaLayer[];
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

function layer(name: PersonaLayerName, content: string): PersonaLayer {
  return { name, content, tokens: estimateTokens(content) };
}

/**
 * Builds the four layers for one agent. `workspace` is the agent's own
 * folder (`engine.json`'s `agents.<id>.workspace`, already resolved by the
 * caller); `paths.home` is the channel engine's home, where `USER.md` lives
 * next to `engine.json` and `config.json`.
 */
export function assemblePersona(agentId: string, workspace: string, paths: Paths): Persona {
  const layers: PersonaLayer[] = [
    layer("base", readSafe(BASE_SOUL_PATH)),
    layer("user", readSafe(join(paths.home, "USER.md"))),
    layer("identity", readSafe(join(workspace, "IDENTITY.md"))),
    layer("agent", readSafe(join(workspace, "SOUL.md"))),
  ];
  const text = layers.filter((l) => l.content).map((l) => l.content).join("\n\n");
  return { agent: agentId, layers, text };
}
