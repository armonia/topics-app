/**
 * Door B4 of the project pause, the parking half: a message to a child while the
 * project is paused is kept, joined with the others for the same child, and goes
 * out on "Continua". @covers USAGE-29
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { holdChildSend, resetHeldChildSendsForTests } from "./held-child-send";
import { PAUSED_PROJECT_ID, pauseFixtureProject, pausedProjectDb, resumeFixtureProject } from "../../tests/helpers/paused-project";
import { heldCount, resetHeldForTests } from "../services/turn-gate";

let db: Database;
beforeEach(() => {
  resetHeldForTests();
  resetHeldChildSendsForTests();
  db = pausedProjectDb();
  pauseFixtureProject(db);
});
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("holdChildSend", () => {
  test("paused: nothing is sent; after Continua the message goes out once", async () => {
    const sent: string[] = [];
    holdChildSend(PAUSED_PROJECT_ID, "child-1", "run the tests", async (t) => { sent.push(t); return new Response("{}"); });
    await settle();
    expect(sent).toHaveLength(0);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
    resumeFixtureProject(db);
    await settle();
    expect(sent).toEqual(["run the tests"]);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(0);
  });

  test("two messages to one child are one send, none of the words lost", async () => {
    const sent: string[] = [];
    const replay = async (t: string) => { sent.push(t); return new Response("{}"); };
    holdChildSend(PAUSED_PROJECT_ID, "child-1", "first", replay);
    holdChildSend(PAUSED_PROJECT_ID, "child-1", "second", replay);
    expect(heldCount(PAUSED_PROJECT_ID)).toBe(1);
    resumeFixtureProject(db);
    await settle();
    expect(sent).toEqual(["first\n\nsecond"]);
  });

  test("two children are two sends", async () => {
    const sent: string[] = [];
    const replay = async (t: string) => { sent.push(t); return new Response("{}"); };
    holdChildSend(PAUSED_PROJECT_ID, "child-1", "a", replay);
    holdChildSend(PAUSED_PROJECT_ID, "child-2", "b", replay);
    resumeFixtureProject(db);
    await settle();
    expect(sent.sort()).toEqual(["a", "b"]);
  });

  test("a child still busy on resume (409) is tried again until it takes the message", async () => {
    let calls = 0;
    holdChildSend(PAUSED_PROJECT_ID, "child-1", "later", async () => (++calls < 3 ? new Response("{}", { status: 409 }) : new Response("{}")), 1);
    resumeFixtureProject(db);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(3);
  });
});
