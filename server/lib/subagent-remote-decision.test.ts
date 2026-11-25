/**
 * @covers SUBAGENT-25
 */
import { expect, test } from "bun:test";
import { decideRemoteSpawn } from "./subagent-remote-decision";

test("a git repo with no mac-only resource and no explicit CLI runtime may go remote", () => {
  const decision = decideRemoteSpawn({ isGitRepo: true });
  expect(decision.remote).toBeTrue();
  expect(decision.reason).toMatch(/git repository/i);
});

test("a git repo asked with runtime \"topics\" may still go remote", () => {
  const decision = decideRemoteSpawn({ isGitRepo: true, runtime: "topics" });
  expect(decision.remote).toBeTrue();
});

test("a folder with no .git stays local, even with no other reason", () => {
  const decision = decideRemoteSpawn({ isGitRepo: false });
  expect(decision.remote).toBeFalse();
  expect(decision.reason).toMatch(/not a git repository/i);
});

test("an explicit runtime \"claude-code\" stays local even inside a git repo", () => {
  const decision = decideRemoteSpawn({ isGitRepo: true, runtime: "claude-code" });
  expect(decision.remote).toBeFalse();
  expect(decision.reason).toMatch(/claude-code/);
});

test("runtime \"claude-code\" wins over a mac-only resource: one reason is reported, not both", () => {
  const decision = decideRemoteSpawn({ isGitRepo: true, runtime: "claude-code", macOnlyResource: "jarvis" });
  expect(decision.remote).toBeFalse();
  expect(decision.reason).toMatch(/claude-code/);
});

for (const resource of ["macos", "browser", "session", "jarvis"] as const) {
  test(`a live mac-only resource ("${resource}") keeps a git repo local, same mark as a card's stayLocal`, () => {
    const decision = decideRemoteSpawn({ isGitRepo: true, macOnlyResource: resource });
    expect(decision.remote).toBeFalse();
    expect(decision.reason).toMatch(/stayLocal/);
  });
}

test("a mac-only resource on a non-git folder still reports the resource, not the git reason", () => {
  const decision = decideRemoteSpawn({ isGitRepo: false, macOnlyResource: "browser" });
  expect(decision.remote).toBeFalse();
  expect(decision.reason).toMatch(/browser pane/);
});

test("a child needing gh's login stays local: the credential is not in the bundle a node gets", () => {
  const decision = decideRemoteSpawn({ isGitRepo: true, macOnlyResource: "gh" });
  expect(decision.remote).toBeFalse();
  expect(decision.reason).toMatch(/GitHub CLI/);
});
