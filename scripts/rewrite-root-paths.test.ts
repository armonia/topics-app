/**
 * MOVING A FOLDER MOVES EVERY PATH THE DB SAVED UNDER IT, AND ITS BOARDS.
 *
 * The agents' homes and the app data moved into the Topics home (change
 * `agents-in-topics-home`). The DB keeps those folders in chats, cards, tabs
 * and settings, and keys each board on a hash of its folder: a path left
 * behind is a dead link, a board id left behind is a board whose cards
 * vanished. The last test runs the script on a real SQLite file the way the
 * migration does.
 *
 * @covers PROJ-ID-01 (the folder is the project: its saved id follows the folder)
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { projectIdForPath } from "../shared/board";
import { testTmpDir } from "../tests/integration/helpers";
import { movedBoardIds, parseMoves, remap, rewriteText, spellings, withAliases } from "./rewrite-root-paths";

const HOME = "/home/u";
const OLD = `${HOME}/.agent-home`;
const LINK = `${HOME}/.old-root`;
const args = ["--map", `${OLD}=${HOME}/.topics/agents/main`, "--map", `${OLD}/workspace-b=${HOME}/.topics/agents/b`];

describe("the moves", () => {
  test("the most specific move wins, whatever order they were given in", () => {
    const moves = parseMoves(args, "--map");
    expect(remap(`${OLD}/workspace-b/notes.md`, moves)).toBe(`${HOME}/.topics/agents/b/notes.md`);
    expect(remap(`${OLD}/media/x.png`, moves)).toBe(`${HOME}/.topics/agents/main/media/x.png`);
    expect(remap(`${OLD}-other/x`, moves)).toBeNull();
  });

  test("anything but two different absolute paths is refused", () => {
    expect(() => parseMoves(["--map", "rel=/x"], "--map")).toThrow();
    expect(() => parseMoves(["--map", "/x=/x"], "--map")).toThrow();
  });
});

describe("the text", () => {
  const moves = withAliases(parseMoves(args, "--map"), parseMoves(["--alias", `${LINK}=${OLD}`], "--alias"));
  const sp = spellings(moves, HOME);
  const rw = (v: string) => rewriteText(v, sp);

  test("every spelling of the folder moves: plain, ~, $HOME, URL-encoded, the former link", () => {
    expect(rw(OLD)).toBe(`${HOME}/.topics/agents/main`);
    expect(rw(`MEDIA: ${OLD}/media/a.png\nok`)).toBe(`MEDIA: ${HOME}/.topics/agents/main/media/a.png\nok`);
    expect(rw("see ~/.agent-home/workspace-b/AGENTS.md")).toBe("see ~/.topics/agents/b/AGENTS.md");
    expect(rw("$HOME/.agent-home/bin/x")).toBe("$HOME/.topics/agents/main/bin/x");
    expect(rw(`project:${encodeURIComponent(`${OLD}/workspace-b`)}"`)).toBe(`project:${encodeURIComponent(`${HOME}/.topics/agents/b`)}"`);
    expect(rw(`{"cwd":"${LINK}/lavori"}`)).toBe(`{"cwd":"${HOME}/.topics/agents/main/lavori"}`);
    expect(rw(`ended in ${OLD}`)).toBe(`ended in ${HOME}/.topics/agents/main`);
  });

  test("a home spelled with ~ or $HOME moves wherever the name ends: a code span, a sentence, a list", () => {
    expect(rw("lives in `~/.agent-home`.")).toBe("lives in `~/.topics/agents/main`.");
    expect(rw("cd ${HOME}/.agent-home; ls")).toBe("cd ${HOME}/.topics/agents/main; ls");
    expect(rw("[~/.agent-home/workspace-b]")).toBe("[~/.topics/agents/b]");
    expect(rw(`see ${OLD}/workspace-b.`)).toBe(`see ${HOME}/.topics/agents/b.`);
    expect(rw("$HOME/.agent-home:$PATH")).toBe("$HOME/.topics/agents/main:$PATH");
  });

  test("a folder that only shares the prefix stays", () => {
    expect(rw(`${OLD}-other/x and ${OLD}x and ${OLD}.json and ~/.agent-home_2`)).toBe(`${OLD}-other/x and ${OLD}x and ${OLD}.json and ~/.agent-home_2`);
  });
});

describe("the boards", () => {
  test("a moved folder's board id follows it, and so does the id of its former spelling", () => {
    const moves = parseMoves(args, "--map");
    const aliases = parseMoves(["--alias", `${LINK}=${OLD}`], "--alias");
    const r = movedBoardIds([`${OLD}/workspace/general`, "/elsewhere"], moves, aliases);
    const to = projectIdForPath(`${HOME}/.topics/agents/main/workspace/general`);
    expect(r.get(projectIdForPath(`${OLD}/workspace/general`))).toEqual({ to, path: `${OLD}/workspace/general` });
    expect(r.get(projectIdForPath(`${LINK}/workspace/general`))).toEqual({ to, path: `${LINK}/workspace/general` });
    expect(r.get(projectIdForPath(OLD))?.to).toBe(projectIdForPath(`${HOME}/.topics/agents/main`));
    expect(r.has(projectIdForPath("/elsewhere"))).toBe(false);
  });

  test("on a real database: paths, retired panes and board ids move, old ids alias the new boards, ids and other folders stay", () => {
    const dir = testTmpDir("rewrite-root-paths");
    const file = join(dir, "t.db");
    const db = new Database(file);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, project_path TEXT)");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, description TEXT)");
    db.run("CREATE TABLE retirements (kind TEXT, ref_id TEXT, PRIMARY KEY (kind, ref_id))");
    db.run("CREATE TABLE board_aliases (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, old_path TEXT, created_at INTEGER NOT NULL)");
    // an earlier move: the id of the old spelling already pointed at OLD/workspace-b's board
    db.run("INSERT INTO board_aliases VALUES (?, ?, ?, 1)", ["older-id", projectIdForPath(`${OLD}/workspace-b`), `${OLD}/workspace-b`]);
    db.run("INSERT INTO topics VALUES (?, ?), (?, ?)", [`id-${OLD}`, `${OLD}/workspace-b`, "t2", "/elsewhere"]);
    db.run("INSERT INTO tasks VALUES (?, ?, ?)", ["k1", projectIdForPath(`${LINK}/workspace-b`), `look at ${OLD}/media/a.png`]);
    db.run("INSERT INTO retirements VALUES ('pane', ?)", [`project:${encodeURIComponent(`${OLD}/workspace-b`)}`]);
    // the home's own pane, under both spellings: the folder ends the value, and both become the same pane
    db.run("INSERT INTO retirements VALUES ('pane', ?), ('pane', ?)", [`project:${encodeURIComponent(OLD)}`, `project:${encodeURIComponent(LINK)}`]);
    db.run("INSERT INTO topics VALUES (?, ?)", ["t3", `ended in ${OLD}`]);
    db.close();

    const run = spawnSync("bun", [join(import.meta.dir, "rewrite-root-paths.ts"), "--db", file, ...args, "--alias", `${LINK}=${OLD}`], { encoding: "utf8", env: { ...process.env, HOME } });
    expect(run.status).toBe(0);

    const after = new Database(file, { readonly: true });
    expect(after.query("SELECT id, project_path AS p FROM topics ORDER BY id").all()).toEqual([
      { id: `id-${OLD}`, p: `${HOME}/.topics/agents/b` },
      { id: "t2", p: "/elsewhere" },
      { id: "t3", p: `ended in ${HOME}/.topics/agents/main` },
    ]);
    expect(after.query("SELECT project_id AS b, description AS d FROM tasks").get()).toEqual({
      b: projectIdForPath(`${HOME}/.topics/agents/b`),
      d: `look at ${HOME}/.topics/agents/main/media/a.png`,
    });
    expect(after.query("SELECT ref_id AS r FROM retirements ORDER BY ref_id").all()).toEqual([
      { r: `project:${encodeURIComponent(`${HOME}/.topics/agents/b`)}` },
      { r: `project:${encodeURIComponent(`${HOME}/.topics/agents/main`)}` },
    ]);
    const alias = (id: string) => after.query("SELECT new_id AS n, old_path AS p FROM board_aliases WHERE old_id = ?").get(id);
    const b = projectIdForPath(`${HOME}/.topics/agents/b`);
    expect(alias(projectIdForPath(`${OLD}/workspace-b`))).toEqual({ n: b, p: `${OLD}/workspace-b` });
    expect(alias(projectIdForPath(`${LINK}/workspace-b`))).toEqual({ n: b, p: `${LINK}/workspace-b` });
    // the older row keeps where it was, and reaches the moved board through the new alias
    expect(alias("older-id")).toEqual({ n: projectIdForPath(`${OLD}/workspace-b`), p: `${OLD}/workspace-b` });
    after.close();
  });
});
