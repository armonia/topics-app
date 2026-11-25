/**
 * MEMORY STORES (T6): every place an agent's lessons live, read, searched,
 * edited and archived from one spot instead of each agent's own blind folder.
 *
 * Measured 2026-11-22: a second agent had 108 cards in its memory folder but
 * no `memory` key in the channel engine's config, so no turn of its ever saw
 * the index — an invisible failure. The fix is the default, not a flag: an
 * agent's OWN folder (`<its workspace>/memory`, the workspace the registry
 * reports: the folder name need not equal the agent id) is always a store
 * and always auto-received, with no configuration required. Configuration
 * only ADDS sharing: `engine.json`'s `agents.<id>.memory` grants a scope on
 * another store — `"shared"` (auto-received alongside the agent's own) or
 * `"readonly"` (searchable, never auto-received, never writable). A project's
 * own memory (`~/.claude/projects/<repo>/memory`, same folder Claude Code's
 * auto-memory reads — see `../lib/native-parity.ts`) is discovered the same
 * way and starts with no grants: nobody receives it until an agent is
 * explicitly given one.
 *
 * A store with cards and nobody receiving it, or an index past Claude Code's
 * own truncation limit, is a problem for `server/system/health.ts` (T7) —
 * `storeProblems` is the one place that decides what counts as broken, so T7
 * reads it instead of re-deriving the same rule.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parseFrontMatter } from "../lib/agent-profiles";
import { MEMORY_INDEX_MAX_CHARS, MEMORY_INDEX_MAX_LINES } from "../lib/native-parity";
import type { AgentRecord } from "../agents/registry";
import { readJson, safeWrite } from "../agents/config-files";

export type MemoryStoreScope = "own" | "shared" | "readonly";

/** An extra grant from `engine.json`'s `agents.<id>.memory`: access to a store this agent does not own. */
export interface MemoryGrant {
  storeId: string;
  scope: Extract<MemoryStoreScope, "shared" | "readonly">;
}

/** A store said in words: the agent's id, or the last two segments of a project folder's encoded path (`-a-b-topics-app` becomes `topics-app`). */
export function storeLabel(store: Pick<MemoryStore, "id" | "kind" | "ownerAgentId">): string {
  if (store.kind === "agent") return store.ownerAgentId ?? store.id;
  const parts = store.id.replace(/^project:/, "").split("-").filter(Boolean);
  return parts.slice(-2).join("-") || store.id;
}

export interface MemoryStoreIndex {
  path: string;
  lines: number;
  chars: number;
  overLimit: boolean;
}

export interface MemoryCard {
  file: string;
  name: string;
  description: string;
  type: string;
}

export interface MemoryStore {
  id: string;
  kind: "agent" | "project";
  /** The agent whose own folder this is; null for a project store. */
  ownerAgentId: string | null;
  path: string;
  /** null = the folder has no `MEMORY.md`. */
  index: MemoryStoreIndex | null;
  cards: MemoryCard[];
  /** Agents whose turns get this store's index automatically (own + "shared" grants). */
  receivedBy: string[];
  /** Agents that may read and search it but never receive it automatically ("readonly" grants). */
  readableBy: string[];
}

export interface MemoryStoreProblem {
  storeId: string;
  kind: "unreceived" | "index-missing" | "index-over-limit";
  text: string;
}

const INDEX_FILE = "MEMORY.md";
const ARCHIVE_FILE = "ARCHIVE.md";

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Root Claude Code keeps its per-project transcripts and memory under. */
export function claudeProjectsHome(home = homedir()): string {
  return join(home, ".claude", "projects");
}

function frontMatterBlock(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return m ? m[1]! : "";
}

function readIndex(storePath: string): MemoryStoreIndex | null {
  const path = join(storePath, INDEX_FILE);
  if (!existsSync(path)) return null;
  const raw = readSafe(path);
  const lines = raw.length ? raw.split("\n").length : 0;
  const chars = raw.length;
  return { path, lines, chars, overLimit: lines > MEMORY_INDEX_MAX_LINES || chars > MEMORY_INDEX_MAX_CHARS };
}

/** Every card in a store folder: every `.md` file but the index and the archive. */
function readCards(storePath: string): MemoryCard[] {
  let names: string[];
  try {
    names = readdirSync(storePath).filter((n) => n.endsWith(".md") && n !== INDEX_FILE && n !== ARCHIVE_FILE);
  } catch {
    return [];
  }
  return names.sort().map((file) => {
    const text = readSafe(join(storePath, file));
    const fm = parseFrontMatter(text) ?? {};
    const type = /^\s*type:\s*(\S+)/m.exec(frontMatterBlock(text))?.[1] ?? "";
    return { file, name: fm.name || file.slice(0, -".md".length), description: fm.description ?? "", type };
  });
}

function findProjectMemoryDirs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const dir = join(root, n, "memory");
    try {
      if (statSync(dir).isDirectory()) out.push(dir);
    } catch {
      /* no memory folder for this project */
    }
  }
  return out;
}

/** `engine.json`'s `agents.<id>.memory`: extra grants beyond an agent's own folder. */
export interface MemoryStoresConfig {
  agents?: Record<string, MemoryGrant[]>;
}

/** Reads `agents.<id>.memory` out of `engine.json`; a missing or unreadable file is no grants, never an error. */
export function readMemoryStoresConfig(engineHome: string): MemoryStoresConfig {
  const file = join(engineHome, "engine.json");
  if (!existsSync(file)) return {};
  let engine: { agents?: Record<string, { memory?: unknown }> };
  try {
    engine = readJson(file) as typeof engine;
  } catch {
    return {};
  }
  const agents: Record<string, MemoryGrant[]> = {};
  for (const [id, def] of Object.entries(engine.agents ?? {})) {
    const raw = def?.memory;
    if (!Array.isArray(raw)) continue;
    const grants = raw.filter(
      (g): g is MemoryGrant =>
        !!g && typeof g.storeId === "string" && (g.scope === "shared" || g.scope === "readonly"),
    );
    if (grants.length) agents[id] = grants;
  }
  return { agents };
}

export interface DiscoverStoresOptions {
  claudeProjectsHome: string;
  config: MemoryStoresConfig;
}

/**
 * Every store this machine has: one per agent's own folder (always present,
 * always `receivedBy` that agent) plus one per project memory found, then
 * `config`'s grants widen `receivedBy`/`readableBy` for named stores. A
 * project store nobody is granted stays with empty `receivedBy` — exactly
 * the "full but nobody receives it" case `storeProblems` reports.
 */
export function discoverStores(agents: AgentRecord[], opts: DiscoverStoresOptions): MemoryStore[] {
  const stores = new Map<string, MemoryStore>();

  for (const agent of agents) {
    const path = join(agent.workspace, "memory");
    const id = `agent:${agent.id}`;
    stores.set(id, {
      id,
      kind: "agent",
      ownerAgentId: agent.id,
      path,
      index: readIndex(path),
      cards: readCards(path),
      receivedBy: [agent.id],
      readableBy: [],
    });
  }

  for (const path of findProjectMemoryDirs(opts.claudeProjectsHome)) {
    const id = `project:${basename(dirname(path))}`;
    stores.set(id, {
      id,
      kind: "project",
      ownerAgentId: null,
      path,
      index: readIndex(path),
      cards: readCards(path),
      receivedBy: [],
      readableBy: [],
    });
  }

  for (const [agentId, grants] of Object.entries(opts.config.agents ?? {})) {
    for (const grant of grants) {
      const store = stores.get(grant.storeId);
      if (!store) continue;
      if (grant.scope === "shared") {
        if (!store.receivedBy.includes(agentId)) store.receivedBy.push(agentId);
      } else if (!store.readableBy.includes(agentId)) {
        store.readableBy.push(agentId);
      }
    }
  }

  return [...stores.values()];
}

/** What a turn for `agentId` actually gets handed, with the scope already applied: its own store plus every store it was granted "shared" — never a readonly grant, never another agent's own store. */
export function storesForTurn(agentId: string, stores: MemoryStore[]): MemoryStore[] {
  return stores.filter((s) => s.receivedBy.includes(agentId));
}

/** The problems T7 (`server/system/health.ts`) surfaces for Memorie: a full store nobody receives, a store with cards and no index, or an index past the limit. */
export function storeProblems(store: MemoryStore): MemoryStoreProblem[] {
  const problems: MemoryStoreProblem[] = [];
  if (store.cards.length > 0 && store.receivedBy.length === 0) {
    problems.push({
      storeId: store.id,
      kind: "unreceived",
      text: `"${storeLabel(store)}" ha ${store.cards.length} schede ma nessun agente la riceve`,
    });
  }
  if (store.cards.length > 0 && !store.index) {
    problems.push({ storeId: store.id, kind: "index-missing", text: `"${storeLabel(store)}" ha schede ma non ha un indice (MEMORY.md)` });
  }
  if (store.index?.overLimit) {
    problems.push({
      storeId: store.id,
      kind: "index-over-limit",
      text: `l'indice di "${storeLabel(store)}" supera il limite (${MEMORY_INDEX_MAX_LINES} righe / ${MEMORY_INDEX_MAX_CHARS} caratteri)`,
    });
  }
  return problems;
}

export interface MemorySearchResult {
  storeId: string;
  file: string;
  name: string;
  description: string;
  type: string;
  snippet: string;
}

function snippetAround(text: string, query: string, radius = 80): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * One deposit search, servito da Topics (regola zero: no external service).
 * Every card whose name, description or body contains `query` (case
 * insensitive), with its own store attached so two stores sharing a word
 * come back as two separate results.
 */
export function searchStores(stores: MemoryStore[], query: string): MemorySearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: MemorySearchResult[] = [];
  for (const store of stores) {
    for (const card of store.cards) {
      const text = readSafe(join(store.path, card.file));
      const haystack = `${card.name}\n${card.description}\n${text}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      results.push({
        storeId: store.id,
        file: card.file,
        name: card.name,
        description: card.description,
        type: card.type,
        snippet: snippetAround(text || `${card.name}\n${card.description}`, q),
      });
    }
  }
  return results;
}

function safeCardPath(storePath: string, file: string): string {
  if (!file.endsWith(".md")) throw new Error("card file must end in .md");
  const full = resolve(storePath, file);
  const rel = relative(storePath, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("invalid card file");
  return full;
}

export function readCard(storePath: string, file: string): string {
  return readSafe(safeCardPath(storePath, file));
}

/** Backup then atomic write, same guarantee as every other agent config edit (`safeWrite`). */
export function writeCard(storePath: string, file: string, content: string): { backup: string | null } {
  const path = safeCardPath(storePath, file);
  mkdirSync(storePath, { recursive: true });
  return { backup: safeWrite(path, content, storePath) };
}

/** Moves a card's content into the store's `ARCHIVE.md` (appended, backed up) and removes the card file (backed up first too). */
export function archiveCard(storePath: string, file: string): { archivePath: string; backup: string | null } {
  const path = safeCardPath(storePath, file);
  const content = readSafe(path);
  const archivePath = join(storePath, ARCHIVE_FILE);
  const existingArchive = readSafe(archivePath);
  safeWrite(archivePath, `${existingArchive}${existingArchive ? "\n\n" : ""}${content}`.trim() + "\n", storePath);
  const backup = existsSync(path) ? safeWrite(path, content, storePath) : null;
  if (existsSync(path)) unlinkSync(path);
  return { archivePath, backup };
}
