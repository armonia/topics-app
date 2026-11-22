/**
 * The agents registry: WHO an agent is, read from the channel engine's config
 * (`engine.json`, `agents.<id>.workspace`) and from its workspace's
 * `IDENTITY.md`, never from a hard-coded id/name list.
 *
 * No configuration = empty list, never an error (`readAgents("")` and an
 * unreadable `engine.json` both answer `[]`). Creating an agent writes only
 * `IDENTITY.md` into a new folder plus one entry in `engine.json`, backed up
 * first (`safeWrite`, in `./config-files`, shared with
 * `server/routes/agent-config.ts`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { safeWrite } from "./config-files";

export interface AgentRecord {
  id: string;
  name: string;
  job: string;
  workspace: string;
}

/** The channel engine's home: an env-backed setting, falling back to the
 *  engine's own standard folder. The ONE resolver both `/api/agents` and
 *  `/api/agent-config` call, so they always agree on where the agents live
 *  (a route stuck on its own default used to show a different roster than
 *  the other). No engine installed there = empty home, `readAgents` then
 *  answers `[]` without error. */
export function registryHome(env: Record<string, string | undefined> = process.env): string {
  return env.JARVIS_CHANNELS_HOME?.trim() || join(homedir(), "Library", "Application Support", "jarvis-channels");
}

interface EngineAgentDef { workspace?: string; account?: string }
interface EngineConfig { agents?: Record<string, EngineAgentDef> }

/** Name and job from `IDENTITY.md`: the heading (`# Name`) and the first
 *  non-empty line after it. Missing file = both empty, never a throw. */
export function readIdentity(workspace: string): { name: string; job: string } {
  const file = join(workspace, "IDENTITY.md");
  if (!existsSync(file)) return { name: "", job: "" };
  const lines = readFileSync(file, "utf8").split("\n");
  let name = "";
  let job = "";
  let afterHeading = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!afterHeading) {
      if (line.startsWith("# ")) { name = line.slice(2).trim(); afterHeading = true; }
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    job = line;
    break;
  }
  return { name, job };
}

/** Every agent the engine's config declares, in declaration order. An entry
 *  with no `workspace` is skipped: there is nowhere to read its identity from. */
export function readAgents(home: string, expand: (p: string) => string = (p) => p): AgentRecord[] {
  if (!home) return [];
  const engineFile = join(home, "engine.json");
  if (!existsSync(engineFile)) return [];
  let engine: EngineConfig;
  try {
    engine = JSON.parse(readFileSync(engineFile, "utf8"));
  } catch {
    return [];
  }
  const agents = engine.agents ?? {};
  return Object.entries(agents)
    .filter(([, def]) => typeof def?.workspace === "string")
    .map(([id, def]) => {
      const ws = expand(def.workspace as string);
      const { name, job } = readIdentity(ws);
      return { id, name: name || id, job, workspace: ws };
    });
}

/** `"Rino Gaetano"` → `"rino-gaetano"`. Throws when nothing usable is left. */
export function slugifyAgentId(name: string): string {
  const id = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("name produces no usable id");
  return id;
}

/**
 * Creates a new agent: a folder with only `IDENTITY.md`, plus one entry in
 * `engine.json` (backed up first). Rejects a name whose id already exists.
 */
export function createAgent(
  home: string,
  agentsRoot: string,
  input: { name: string; job: string; character?: string },
): AgentRecord {
  if (!home) throw new Error("no engine configured");
  const name = input.name?.trim();
  if (!name) throw new Error("name required");
  const job = input.job?.trim() ?? "";
  if (!job) throw new Error("job required");
  const id = slugifyAgentId(name);

  const engineFile = join(home, "engine.json");
  const engine: EngineConfig = existsSync(engineFile) ? JSON.parse(readFileSync(engineFile, "utf8")) : {};
  engine.agents = engine.agents ?? {};
  if (engine.agents[id]) throw new Error(`agent ${id} already exists`);

  const workspace = join(agentsRoot, id);
  mkdirSync(workspace, { recursive: true });
  const character = input.character?.trim();
  const identity = `# ${name}\n${job}\n${character ? `\n${character}\n` : ""}`;
  writeFileSync(join(workspace, "IDENTITY.md"), identity);

  engine.agents[id] = { workspace };
  safeWrite(engineFile, `${JSON.stringify(engine, null, 2)}\n`, home);

  return { id, name, job, workspace };
}
