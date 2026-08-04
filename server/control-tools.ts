/**
 * SDK-passthrough control tools — the tool-shaped successors to the
 * {{PROJECT_OPEN}} / {{PROJECT_CREATE}} / {{TOPIC_SWITCH}} / {{TOPIC_NEW}}
 * markers, for the SDK-driven providers (claude, openai) that reach tools via
 * `sendOptions.tools` passthrough rather than the MCP bridge.
 *
 * Mirrors server/browser-tools.ts: a pure `Tool[]` list (projected for the
 * Anthropic SDK) plus an in-process dispatcher. The dispatcher does NOT round-
 * trip through the Layer-1 HTTP endpoints — the chat router already holds the
 * exact side-effect cores in-process (resolveProjectRef / bindTopicToProject via
 * ChatDeps; switch/create-topic via session-control-core), so we call them
 * directly. That keeps behaviour (and broadcasts) identical to the MCP path
 * without a self-HTTP call or a duplicated TLS/token/origin dance.
 *
 * SDK passthrough is single-turn (claude/openai don't feed the tool result back
 * in-turn), and the four marker successors are fire-and-forget UI side-effects,
 * so each handler just returns a short confirmation string. `resolve_tab` is the
 * one READ tool here: same single-turn limit, so its result (the resolved-tab
 * JSON) reaches the USER in the chat's tool block, never the model — which is
 * why its description tells the model not to summarize what it never received.
 *
 * The SDK caller only ever resolves to a CHAT topic (a terminal Claude tab is a
 * claude-code CLI session, not an SDK one), so the terminal-tab fallbacks the
 * HTTP endpoints carry are not needed here.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { Topic } from "./types";
import type { ResolvedTab } from "./lib/tab-resolver";
import {
  switchTopicCore,
  createTopicCore,
  type SessionControlDeps,
} from "./lib/session-control-core";

export type ControlToolName =
  | "switch_topic"
  | "new_topic"
  | "create_project"
  | "open_project"
  | "resolve_tab";

/**
 * Single source of truth for the control-tool surface, in the same shape as
 * browser-tool-spec's specs (name/description/schema). Descriptions carry the
 * "when to use" guidance so the SDK provider needs no system-prompt block.
 */
interface ControlToolSpec {
  name: ControlToolName;
  description: string;
  schema: Tool["input_schema"];
}

export const CONTROL_TOOL_SPECS: ControlToolSpec[] = [
  {
    name: "switch_topic",
    description:
      "Switch the user's view to an EXISTING chat topic (conversation thread) by id. Use when the user asks to go to / open another existing topic. UI-only: it does not move the current message. Only switch when the user EXPLICITLY asks to change topic; never for tool usage, test messages, debugging, or follow-ups. Never mention the tool to the user.",
    schema: {
      type: "object",
      properties: { topic_id: { type: "string", description: "Target topic id." } },
      required: ["topic_id"],
    },
  },
  {
    name: "new_topic",
    description:
      "Create a NEW chat topic (conversation thread) with the given title and switch the user to it. It inherits the current topic's project binding. Use when the user starts a clearly NEW subject that matches no existing topic. Prefer switch_topic when an existing topic fits. Never create for tool usage, test messages, debugging, or casual mentions. Never mention the tool to the user.",
    schema: {
      type: "object",
      properties: { title: { type: "string", description: "A short, descriptive 2-4 word title for the new topic." } },
      required: ["title"],
    },
  },
  {
    name: "create_project",
    description:
      "Scaffold a NEW project workspace (a folder + CLAUDE.md under the workspace dir) and nest THIS session inside its project window. Use when the user asks to start a new project. Name is sanitized to [A-Za-z0-9_-]; a name that already exists is rejected (use open_project to open the existing one). Never mention the tool to the user.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "Project name (alphanumeric / -_)." } },
      required: ["name"],
    },
  },
  {
    name: "open_project",
    description:
      "Open an EXISTING project the user already has in Topics (by name, slug, or a path Topics knows) and nest THIS session inside its window. Call whenever the user, in ANY phrasing or language, asks to open, switch to, move into, or nest this session under a project (e.g. 'open project Pix', 'aprimi il progetto Pix'), OR when you begin focused work inside a specific project. Unknown / arbitrary paths are rejected. If the user references 'this project' without naming it and you cannot infer it, ask rather than guess. Never mention the tool to the user.",
    schema: {
      type: "object",
      properties: { ref: { type: "string", description: "Project name, slug, or a known path." } },
      required: ["ref"],
    },
  },
  {
    // Il gemello del tool MCP `resolve_tab`. Sta qui perché è QUESTA la
    // superficie dove l'umano incolla un link: la chat. I provider SDK
    // (claude/openai) non vedono l'MCP — ricevono i tool via
    // `sendOptions.tools` — quindi senza questa voce il tool funzionerebbe per
    // gli agenti dispatchati e non per la chat, cioè al contrario del caso d'uso.
    //
    // Il passthrough SDK è a turno singolo (limite documentato in
    // `server/providers/claude.ts`: nessun giro tool_use → tool_result → turno
    // successivo), quindi la descrizione lo DICE al modello: senza, il modello
    // chiama il tool e poi riassume a memoria un risultato che non ha mai visto.
    name: "resolve_tab",
    description:
      "Resolve a Topics tab permalink (/tab/… , /task/<id>, /topic/<id>) that the user pasted: which tab it is, its real title, whether it is still open, and how to read its content. Read-only — it opens and changes nothing. IMPORTANT: the resolution is rendered directly to the user as this tool's result; you do NOT receive it back in this turn, so never summarize, quote or guess its content — just acknowledge that you resolved the link.",
    schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The pasted link or bare path, e.g. 'https://127.0.0.1:3333/tab/chat/abc123' or '/task/t-42'." },
      },
      required: ["ref"],
    },
  },
];

/** Anthropic `Tool[]` for the SDK passthrough surface (claude/openai). */
export const controlTools: Tool[] = CONTROL_TOOL_SPECS.map((s) => ({
  name: s.name,
  description: s.description,
  input_schema: s.schema,
}));

const CONTROL_TOOL_NAMES = new Set<string>(CONTROL_TOOL_SPECS.map((s) => s.name));

export function isControlTool(name: string): boolean {
  return CONTROL_TOOL_NAMES.has(name);
}

/**
 * The closure-local project helpers the chat router already owns (from ChatDeps)
 * plus the workspace root, threaded into the dispatcher so create/open reuse the
 * SAME resolver + bind + scaffold contract as the Layer-1 endpoints.
 */
export interface ControlDispatchDeps extends SessionControlDeps {
  resolveProjectRef: (ref: string, opts?: { trustRawPaths?: boolean }) => string | null;
  bindTopicToProject: (topicId: string, targetDir: string, opts?: { focus?: boolean }) => boolean;
  workspaceDir: string;
  /**
   * Risolve un permalink a una tab. INIETTATA e non importata: il resolver vuole
   * il DB e il registro delle pane native, e questo modulo è volutamente senza
   * dipendenze da SQLite (come per gli altri quattro tool, che ricevono i core
   * dal router). Chi la costruisce usa `lib/tab-resolver-deps.ts`, che è l'unica
   * costruzione delle sue fonti — così la chat e `GET /api/tabs/resolve` non
   * possono rispondere due cose diverse sulla stessa tab.
   * Assente ⇒ il tool dice «non disponibile» invece di mentire.
   */
  resolveTab?: (ref: string) => ResolvedTab | null;
}

/** Structured error the dispatcher throws so the caller can surface a clear message. */
export class ControlToolError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "ControlToolError";
  }
}

/**
 * Dispatch an SDK-passthrough control tool for a CHAT topic. Returns a short
 * human-readable confirmation (becomes the tool-result text); throws
 * ControlToolError on a bad arg / unknown ref / name collision so the caller
 * reports the failure to the model and the UI.
 */
export async function dispatchControlToolCall(
  name: string,
  args: Record<string, unknown>,
  topic: Topic,
  deps: ControlDispatchDeps,
): Promise<string> {
  switch (name) {
    case "switch_topic": {
      const topicId = typeof args?.topic_id === "string" ? args.topic_id : "";
      if (!topicId) throw new ControlToolError("switch_topic: 'topic_id' (string) is required", "bad_args");
      const r = switchTopicCore(topic, topicId, deps);
      if (!r.ok) throw new ControlToolError(r.message, r.code);
      return `switched to topic ${r.toTopicId}`;
    }
    case "new_topic": {
      const title = typeof args?.title === "string" ? args.title.trim() : "";
      if (!title) throw new ControlToolError("new_topic: 'title' (string) is required", "bad_args");
      const { topic: created } = createTopicCore(topic, title, deps);
      return `created + switched to new topic "${title}" (id=${created.id})`;
    }
    case "open_project": {
      const ref = typeof args?.ref === "string" ? args.ref : "";
      if (!ref) throw new ControlToolError("open_project: 'ref' (string) is required", "bad_args");
      // trustRawPaths:false — same AI-path guard as the endpoint: a model (or
      // prompt injection) can't nest the session under /etc or ~/.ssh.
      const dir = deps.resolveProjectRef(ref, { trustRawPaths: false });
      if (!dir) throw new ControlToolError("project not found (must be a project Topics already knows)", "not_found");
      deps.bindTopicToProject(topic.id, dir, { focus: true });
      return `opened project at ${dir}`;
    }
    case "create_project": {
      const rawName = typeof args?.name === "string" ? args.name.trim() : "";
      const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safeName) throw new ControlToolError("create_project: 'name' (alphanumeric) is required", "bad_args");
      const targetDir = join(deps.workspaceDir, safeName);
      // AC-01: create means CREATE — a name collision is a 409-equivalent error,
      // never a silent bind to whatever already lives there (that's open_project).
      if (existsSync(targetDir)) {
        throw new ControlToolError(`project "${safeName}" already exists (use open_project to open it)`, "project_exists");
      }
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "CLAUDE.md"), `# ${safeName}\n`);
      deps.bindTopicToProject(topic.id, targetDir, { focus: true });
      return `created + opened project at ${targetDir}`;
    }
    case "resolve_tab": {
      const ref = typeof args?.ref === "string" ? args.ref.trim() : "";
      if (!ref) throw new ControlToolError("resolve_tab: 'ref' (string) is required", "bad_args");
      if (!deps.resolveTab) {
        throw new ControlToolError("resolve_tab: tab resolver not wired in this process", "unavailable");
      }
      const resolved = deps.resolveTab(ref);
      // `null` = la grammatica non lo riconosce. Come la rotta HTTP, NON è un
      // «non esiste»: è «questo non è un link a una tab». Dirlo così evita che
      // il modello concluda che la tab è stata cancellata.
      if (!resolved) {
        throw new ControlToolError(
          "resolve_tab: ref is not a tab permalink (expected /tab/… , /task/<id> or /topic/<id>)",
          "not_a_tab_link",
        );
      }
      // JSON intero, non una frase: questo risultato lo legge l'UMANO nel blocco
      // tool della chat (la history che torna al provider è testo semplice —
      // `providers/normalize-history.ts` — quindi al modello non arriva né ora né
      // al turno dopo). Meglio dargli tutto: `state` gli dice se la tab è ancora
      // lì e `next` da dove se ne legge il contenuto.
      return JSON.stringify(resolved, null, 2);
    }
    default:
      throw new ControlToolError(`unknown control tool: ${name}`, "unknown_tool");
  }
}
