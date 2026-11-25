#!/usr/bin/env bun
/**
 * One-time operator action: declares, in `engine.json`, which Discord
 * account an agent owns (`agents.<id>.account`), for an agent that today has
 * none. Needed after moving off a hard-coded agent roster: the account used
 * to be assigned in code, so the engine never had to say it, and an agent
 * with no declared account loses its chats to the default one the moment
 * nobody owns its account explicitly.
 *
 * `backfillAgentAccounts` lives here (not in `server/agents/registry.ts`):
 * it is only used by this script and its own test, and the production
 * dead-code gate measures `server/agents/registry.ts` as shipped code, where
 * an export reachable only from a hand-run script would count as unused.
 *
 * Dry run by default: prints what it would write. `--apply` writes, backed
 * up first.
 *
 *   bun run scripts/backfill-agent-account.ts <agentId>=<account> [...] [--apply] [--channels-home DIR]
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { safeWrite } from "../server/agents/config-files";

interface EngineAgentDef { workspace?: string; account?: string }
interface EngineConfig { agents?: Record<string, EngineAgentDef> }

/**
 * Writes `agents.<id>.account` for every agent the mapping names, but only
 * where it is still missing (an agent that already declares one is left
 * alone). The channel engine does not reject extra fields, so this is
 * additive. Backed up first (`safeWrite`).
 */
export function backfillAgentAccounts(home: string, accounts: Record<string, string>): Record<string, string> {
  const engineFile = join(home, "engine.json");
  const engine: EngineConfig = existsSync(engineFile) ? JSON.parse(readFileSync(engineFile, "utf8")) : {};
  engine.agents = engine.agents ?? {};
  const written: Record<string, string> = {};
  for (const [id, account] of Object.entries(accounts)) {
    if (!engine.agents[id]) throw new Error(`agent ${id} not found`);
    if (engine.agents[id].account) continue;
    engine.agents[id].account = account;
    written[id] = account;
  }
  if (Object.keys(written).length) safeWrite(engineFile, `${JSON.stringify(engine, null, 2)}\n`, home);
  return written;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const opt = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
  };
  const home = opt("--channels-home", `${homedir()}/Library/Application Support/jarvis-channels`);

  const pairs = args.filter((a) => a.includes("=") && !a.startsWith("--"));
  if (!pairs.length) {
    console.error("usage: bun run scripts/backfill-agent-account.ts <agentId>=<account> [...] [--apply]");
    process.exit(1);
  }
  const mapping: Record<string, string> = {};
  for (const pair of pairs) {
    const [id, account] = pair.split("=");
    if (!id || !account) { console.error(`bad pair: ${pair}`); process.exit(1); }
    mapping[id] = account;
  }

  if (!APPLY) {
    console.log(`dry run against ${home}, would set:`);
    for (const [id, account] of Object.entries(mapping)) console.log(`  agents.${id}.account = "${account}"`);
    console.log("rerun with --apply to write");
    process.exit(0);
  }

  const written = backfillAgentAccounts(home, mapping);
  if (Object.keys(written).length) {
    for (const [id, account] of Object.entries(written)) console.log(`wrote agents.${id}.account = "${account}"`);
  } else {
    console.log("nothing to write: every named agent already has an account");
  }
}
