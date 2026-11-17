/**
 * THE WAKES THAT ANSWER A LAUNCH ARE WIRED TO THE ONE `canWake`, AND THE SYSTEM'S
 * ARCHIVES CARRY THEIR OWN REASON.
 *
 * A textual test, narrow on purpose. The rule lives in `lib/wake-adoption.ts` and
 * its suites drive it with real rows; what they cannot see is the boot passing
 * the launch on and the archivers writing the right `retirements.reason`. Break
 * either and every suite stays green while the defect of 17/11 comes back: a
 * wrapper `(sk) => canWakeLaunchingChat(sk)` drops the launch, so an archived
 * parent never wakes; a dispatcher archiving as "archive" turns every card agent
 * into a chat "a person archived".
 *
 * It reads CODE (comments stripped, so a commented-out call proves nothing) and
 * fails loudly if it stops matching anything.
 *
 * @covers SUBAGENT-12
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const code = (file: string): string =>
  readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("the launch reaches the verdict", () => {
  const reattach = code("server/boot/reattach.ts");

  test("the sub-agent and card-outcome wakes get the shared canWake itself, not a wrapper that drops the launch", () => {
    expect(count(reattach, "canWake: canWakeLaunchingChat,")).toBe(2);
    expect(reattach).not.toMatch(/canWake:\s*\(/);
    expect(reattach).toMatch(/canWakeLaunchingChat\s*=\s*launchingChatCanWake\(/);
  });
});

describe("whoever archives for the system writes a reason of its own", () => {
  test("the dispatcher releasing a card", () => {
    expect(code("server/boot/dispatcher.ts")).toContain('retirementConsequences.archiveTopic(topicId, "task-release")');
  });

  test("a native child at the end of its turn", () => {
    expect(code("server/boot/routers-first.ts")).toContain('retirementConsequences.archiveTopic(topic.id, "subagent-end")');
  });

  test("the shared archiver writes the reason it is given, never a hard-coded archive", () => {
    const first = code("server/boot/routers-first.ts");
    expect(first).toContain('archiveTopic: (topicId, reason = "system") =>');
    expect(first).toContain('recordRetirement(ctx.db, "topic", id, at, reason)');
  });

  test("a closed tab keeps its own reason when the cascade archives", () => {
    expect(code("server/services/retirement.ts")).toContain('deps.archiveTopic(r.topicId, "tab-close")');
  });

  test("the only writers of the person's reason are the interface routes", () => {
    for (const f of ["server/routes/topics-update.ts", "server/routes/topics.ts"]) {
      expect(code(f)).toMatch(/recordRetirement\([^)]*"(archive|bulk-archive)"\)/);
    }
    for (const f of ["server/boot/routers-first.ts", "server/boot/dispatcher.ts", "server/lib/native-subagents.ts"]) {
      expect(code(f)).not.toMatch(/recordRetirement\([^)]*"archive"\)/);
    }
  });
});
