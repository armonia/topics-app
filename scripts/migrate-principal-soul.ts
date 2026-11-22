#!/usr/bin/env bun
/**
 * One-time operator action: splits the principal agent's `SOUL.md` into the
 * pieces the layered persona now keeps apart. Run it only after the channel
 * engine reads its persona from `GET /api/agent-config/persona`, otherwise
 * the directives it moves out of `SOUL.md` stop reaching the agent.
 *
 * The SOUL is cut into sections at `## ` headings (text before the first
 * heading is a preamble). Each section goes to exactly one place:
 *   - heading also present in `server/agents/base/SOUL.md`: generic, dropped
 *     (the shipped base already says it);
 *   - heading named with `--keep "<heading>"`: stays in the agent's SOUL
 *     (permissions that name people);
 *   - anything else: a directive, appended to the rules layer (`RULES.md`).
 *
 * `splitSoulSections` lives here, not in `server/agents/`: only this script
 * and its test use it, and the production dead-code gate would count an
 * export reachable only from a hand-run script as unused.
 *
 * Dry run by default: prints what moves where. `--apply` writes, backed up
 * first (`migratePrincipalSoul`).
 *
 *   bun run scripts/migrate-principal-soul.ts <agentId> [--keep "<heading>"]... [--apply] [--channels-home DIR]
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { migratePrincipalSoul, type PersonaSplit } from "../server/agents/persona-migrate";
import { defaultPaths } from "../server/routes/agent-config";

export interface SoulSection { heading: string; text: string }
export interface SoulPlan { dropped: SoulSection[]; kept: SoulSection[]; moved: SoulSection[] }

const headingOf = (line: string): string => line.replace(/^##\s+/, "").trim().toLowerCase();

/** Cuts a markdown document into its preamble plus one section per `## ` heading. */
export function splitSoulSections(soul: string): SoulSection[] {
  const sections: SoulSection[] = [];
  let current: SoulSection = { heading: "", text: "" };
  for (const line of soul.split("\n")) {
    if (/^##\s+/.test(line)) {
      sections.push(current);
      current = { heading: headingOf(line), text: `${line}\n` };
    } else {
      current.text += `${line}\n`;
    }
  }
  sections.push(current);
  return sections.filter((s) => s.text.trim());
}

/** Decides where each section goes, given the shipped base and the headings to keep. */
export function planSoulSplit(soul: string, baseSoul: string, keep: string[]): SoulPlan {
  const baseHeadings = new Set(splitSoulSections(baseSoul).map((s) => s.heading).filter(Boolean));
  const keepHeadings = new Set(keep.map((k) => k.trim().toLowerCase()));
  const plan: SoulPlan = { dropped: [], kept: [], moved: [] };
  for (const s of splitSoulSections(soul)) {
    if (s.heading && keepHeadings.has(s.heading)) plan.kept.push(s);
    else if (s.heading && baseHeadings.has(s.heading)) plan.dropped.push(s);
    else if (s.heading) plan.moved.push(s);
    else plan.dropped.push(s); // the preamble is the generic title block
  }
  return plan;
}

export function toPersonaSplit(plan: SoulPlan): PersonaSplit {
  const join2 = (xs: SoulSection[]): string => xs.map((s) => s.text.trim()).join("\n\n");
  return { directives: join2(plan.moved), agentAdditions: join2(plan.kept) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const keep = args.flatMap((a, i) => (a === "--keep" && args[i + 1] ? [args[i + 1]!] : []));
  const valueAt = new Set(args.flatMap((a, i) => (["--keep", "--channels-home"].includes(a) ? [i, i + 1] : [])));
  const agentId = args.find((a, i) => !a.startsWith("--") && !valueAt.has(i));
  if (!agentId) {
    console.error('usage: bun run scripts/migrate-principal-soul.ts <agentId> [--keep "<heading>"]... [--apply]');
    process.exit(1);
  }

  const home = opt("--channels-home") ?? `${homedir()}/Library/Application Support/jarvis-channels`;
  const paths = home === opt("--channels-home") ? { ...defaultPaths(), home } : defaultPaths();
  const engineFile = join(paths.home, "engine.json");
  const engine = existsSync(engineFile) ? JSON.parse(readFileSync(engineFile, "utf8")) : {};
  const rawWorkspace: string | undefined = engine.agents?.[agentId]?.workspace;
  if (!rawWorkspace) { console.error(`agent ${agentId} has no workspace in ${engineFile}`); process.exit(1); }
  const workspace = paths.expand(rawWorkspace);
  const soulFile = join(workspace, "SOUL.md");
  if (!existsSync(soulFile)) { console.error(`no SOUL.md at ${soulFile}`); process.exit(1); }

  const baseSoul = readFileSync(join(import.meta.dir, "..", "server", "agents", "base", "SOUL.md"), "utf8");
  const plan = planSoulSplit(readFileSync(soulFile, "utf8"), baseSoul, keep);
  const show = (label: string, xs: SoulSection[]): void => {
    console.log(`${label}: ${xs.length}`);
    for (const s of xs) console.log(`  - ${s.heading || "(preamble)"} (${s.text.trim().length} chars)`);
  };
  console.log(`${APPLY ? "applying to" : "dry run against"} ${soulFile}`);
  show("dropped as generic (already in the base)", plan.dropped);
  show("kept in the agent's SOUL.md", plan.kept);
  show(`moved to ${join(paths.home, "RULES.md")}`, plan.moved);

  if (!APPLY) {
    console.log("rerun with --apply to write");
    process.exit(0);
  }
  const result = migratePrincipalSoul(paths, workspace, toPersonaSplit(plan));
  console.log(`wrote ${result.userFile} (backup ${result.userBackup ?? "none"})`);
  console.log(`wrote ${result.soulFile} (backup ${result.soulBackup ?? "none"})`);
}
