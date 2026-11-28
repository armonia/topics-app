/** @covers SUBAGENT-08, SUBAGENT-09, SUBAGENT-10 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "./agent-profiles";
import { isClaudeModel, resolveSubagentLaunch } from "./subagent-launch";

const scout: AgentProfile = { name: "scout", description: "Sweep.", model: "sonnet", effort: "low", source: "user", path: "/h/scout.md" };
const oracle: AgentProfile = { name: "oracle", description: "Hard question.", model: null, effort: "max", source: "user", path: "/h/oracle.md" };
const userWorker: AgentProfile = { name: "worker", description: "Mechanical stage.", model: "sonnet", effort: null, source: "user", path: "/h/worker.md" };
const projectWorker: AgentProfile = { name: "worker", description: "Mechanical stage.", model: "sonnet", effort: null, source: "project", path: "/proj/worker.md" };
const profiles = new Map([["scout", scout], ["oracle", oracle], ["worker", userWorker]]);
const sonnetParent = { model: "claude-sonnet-5-5[1m]", effort: "xhigh" };

function launch(
  call: Record<string, unknown>,
  parent: { model: string | null; effort: string | null; belongsToTask?: boolean } = sonnetParent,
  profileMap: ReadonlyMap<string, AgentProfile> = profiles,
) {
  const r = resolveSubagentLaunch({ call, profiles: profileMap, parent });
  if (!r.ok) throw new Error(r.error);
  return r.launch;
}

describe("resolveSubagentLaunch", () => {
  test("a model named by the call goes to the CLI as is", () => {
    const l = launch({ model: "sonnet" });
    expect(l).toMatchObject({ model: "sonnet", modelSource: "call", agent: null });
    expect(l.args).toEqual(["--model", "sonnet", "--effort", "xhigh"]);
  });

  test("without a model, a sonnet chat opens a sonnet child", () => {
    const l = launch({});
    expect(l).toMatchObject({ model: "claude-sonnet-5-5[1m]", modelSource: "parent" });
    expect(l.args.slice(0, 2)).toEqual(["--model", "claude-sonnet-5-5[1m]"]);
  });

  test("a parent on a GPT model hands nothing down, and says why", () => {
    const l = launch({ model: "inherit" }, { model: "gpt-5.6-sol", effort: "xhigh" });
    expect(l.model).toBeNull();
    expect(l.modelSource).toBe("default");
    expect(l.modelNote).toBe("default (parent model gpt-5.6-sol is not a Claude model)");
    expect(l.args).not.toContain("--model");
  });

  test("a parent whose model is unknown leaves the CLI default", () => {
    const l = launch({}, { model: null, effort: null });
    expect(l).toMatchObject({ model: null, modelNote: "default (the parent's model is not known)", effort: null });
    expect(l.args).toEqual([]);
  });

  test("the scout profile brings its model and effort, passed explicitly", () => {
    const l = launch({ agentType: "scout" });
    expect(l).toMatchObject({ model: "sonnet", modelSource: "profile", effort: "low", effortSource: "profile", agent: "scout" });
    expect(l.args).toEqual(["--model", "sonnet", "--agent", "scout", "--effort", "low"]);
  });

  test("an explicit opus beats the profile's model", () => {
    const l = launch({ agentType: "scout", model: "opus" });
    expect(l).toMatchObject({ model: "opus", modelSource: "call", effort: "low" });
  });

  test("a profile with no model inherits the parent's", () => {
    expect(launch({ agentType: "oracle" })).toMatchObject({ model: "claude-sonnet-5-5[1m]", modelSource: "parent", effort: "max" });
  });

  test("the parent topic's effort reaches the child when nothing else names one", () => {
    expect(launch({}, { model: "claude-opus-5[1m]", effort: "medium" })).toMatchObject({ effort: "medium", effortSource: "parent" });
    expect(launch({ effort: "high" }, { model: "claude-opus-5[1m]", effort: "medium" })).toMatchObject({ effort: "high", effortSource: "call" });
  });

  test("unknown values are refused with the accepted ones", () => {
    const model = resolveSubagentLaunch({ call: { model: "gpt-5" }, profiles, parent: sonnetParent });
    expect(model).toEqual({ ok: false, error: 'unknown model "gpt-5": use one of inherit, sonnet, opus, fable, haiku' });
    const effort = resolveSubagentLaunch({ call: { effort: "ultra" }, profiles, parent: sonnetParent });
    expect(effort.ok).toBe(false);
    const agent = resolveSubagentLaunch({ call: { agentType: "nobody" }, profiles, parent: sonnetParent });
    expect(agent).toEqual({ ok: false, error: 'unknown agent_type "nobody": use one of oracle, scout, worker' });
  });

  test("the user's worker profile inherits the parent's model in a plain chat", () => {
    const l = launch({ agentType: "worker" });
    expect(l).toMatchObject({ model: "claude-sonnet-5-5[1m]", modelSource: "parent" });
  });

  test("the user's worker profile keeps its Sonnet inside a board task", () => {
    const l = launch({ agentType: "worker" }, { ...sonnetParent, belongsToTask: true });
    expect(l).toMatchObject({ model: "sonnet", modelSource: "profile" });
  });

  test("a project's own worker profile is honoured even in a plain chat", () => {
    const l = launch({ agentType: "worker" }, sonnetParent, new Map([["worker", projectWorker]]));
    expect(l).toMatchObject({ model: "sonnet", modelSource: "profile" });
  });

  test("an explicit call model still beats the chat default for worker", () => {
    const l = launch({ agentType: "worker", model: "opus" });
    expect(l).toMatchObject({ model: "opus", modelSource: "call" });
  });

  test("what counts as a Claude model", () => {
    for (const m of ["claude-opus-5[1m]", "claude-sonnet-5", "claude-haiku-4-5", "sonnet", "opus[1m]", "fable"]) expect(isClaudeModel(m)).toBe(true);
    for (const m of ["gpt-5.6-sol", "gemini-3-pro", "auto", "", null]) expect(isClaudeModel(m)).toBe(false);
  });
});
