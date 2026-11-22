#!/usr/bin/env bun
/**
 * One-time operator action: declares, in `engine.json`, which Discord
 * account an agent owns (`agents.<id>.account`), for an agent that today has
 * none. Needed after moving off a hard-coded agent roster: the account used
 * to be assigned in code, so the engine never had to say it, and an agent
 * with no declared account loses its chats to the default one the moment
 * nobody owns its account explicitly.
 *
 * Dry run by default: prints what it would write. `--apply` writes, backed
 * up first (`backfillAgentAccounts`, shared with the registry's tests).
 *
 *   bun run scripts/backfill-agent-account.ts <agentId>=<account> [...] [--apply] [--channels-home DIR]
 */
import { homedir } from "os";
import { backfillAgentAccounts } from "../server/agents/registry";

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
