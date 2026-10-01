/** @covers SUBAGENT-09 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentTypeDescription, parseFrontMatter, profileSummary, readAgentProfiles } from "./agent-profiles";

const root = mkdtempSync(join(tmpdir(), "agent-profiles-"));
const home = join(root, "home");
const project = join(root, "project");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function profile(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}
const userDir = join(home, ".claude", "agents");
const projectDir = join(project, ".claude", "agents");

profile(userDir, "scout.md", "---\nname: scout\ndescription: Cheap read-only sweep across many files. Use it to locate.\ntools: Read, Grep\nmodel: sonnet\neffort: low\n---\n\nYou locate things.\n");
profile(userDir, "verifier.md", "---\nname: verifier\ndescription: Adversarial check of a claim.\neffort: xhigh\n---\nbody\n");
profile(projectDir, "verifier.md", "---\nname: verifier\ndescription: The project's own verifier.\neffort: high\n---\nbody\n");
profile(userDir, "notes.md", "Just notes, no frontmatter at all.\n");
profile(userDir, "long.md", `---\nname: long\ndescription: ${"word ".repeat(60)}end.\n---\n`);

describe("agent profiles", () => {
  test("the user's profiles are read with their model and effort", () => {
    const scout = readAgentProfiles({ home }).get("scout");
    expect(scout).toMatchObject({ name: "scout", model: "sonnet", effort: "low", source: "user" });
  });

  test("a project profile wins over the user's on a name clash", () => {
    const verifier = readAgentProfiles({ home, cwd: project }).get("verifier");
    expect(verifier).toMatchObject({ effort: "high", source: "project" });
    expect(readAgentProfiles({ home }).get("verifier")?.effort).toBe("xhigh");
  });

  test("a file without frontmatter is skipped without an error", () => {
    const names = [...readAgentProfiles({ home }).keys()].sort();
    expect(names).toEqual(["long", "scout", "verifier"]);
    expect(parseFrontMatter("no block here")).toBeNull();
  });

  test("missing directories read as no profiles", () => {
    expect(readAgentProfiles({ home: join(root, "nowhere"), cwd: join(root, "nothing") }).size).toBe(0);
  });

  test("a summary is the first sentence, capped at 120 characters", () => {
    expect(profileSummary("Cheap read-only sweep across many files. Use it to locate.")).toBe("Cheap read-only sweep across many files.");
    const long = profileSummary(readAgentProfiles({ home }).get("long")!.description);
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  test("the parameter description lists every profile by name", () => {
    const text = agentTypeDescription(readAgentProfiles({ home, cwd: project }));
    expect(text).toContain("- scout: Cheap read-only sweep across many files.");
    expect(text).toContain("- verifier: The project's own verifier.");
    expect(agentTypeDescription(new Map())).toContain("None is installed");
  });
});
