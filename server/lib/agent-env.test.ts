/**
 * The agent's environment keeps what a Windows CLI needs to find its own login.
 *
 * On the PC node `gh` is logged in, but spawned without APPDATA it reads no
 * hosts.yml and says "not logged into any GitHub hosts": cards came back empty.
 *
 * @covers MP-NATENV-02
 */
import { describe, expect, test } from "bun:test";
import { agentBaseEnv } from "./agent-env";

describe("agentBaseEnv on Windows", () => {
  const winEnv = {
    PATH: "C:\\Windows\\system32",
    APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    USERPROFILE: "C:\\Users\\u",
    SystemRoot: "C:\\WINDOWS",
    TEMP: "C:\\Users\\u\\AppData\\Local\\Temp",
    GH_TOKEN: "secret-fixture",
    TOPICS_LICENSE_TOKEN: "license-fixture",
  };

  test("the CLI's config folders pass", () => {
    const env = agentBaseEnv(winEnv);
    expect(env.APPDATA).toBe(winEnv.APPDATA);
    expect(env.LOCALAPPDATA).toBe(winEnv.LOCALAPPDATA);
    expect(env.USERPROFILE).toBe(winEnv.USERPROFILE);
    expect(env.SystemRoot).toBe(winEnv.SystemRoot);
    expect(env.TEMP).toBe(winEnv.TEMP);
  });

  test("secrets still stay out", () => {
    const env = agentBaseEnv(winEnv);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.TOPICS_LICENSE_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("fixture");
  });
});
