/**
 * @covers AGENTS-NAV-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readAgentPermissions } from "./permissions";
import { readStoppedLog } from "./stopped-log";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function identityFolder(root: string, folder: string, name: string): string {
  const ws = join(root, folder);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "IDENTITY.md"), `# ${name}\nMestiere\n`);
  return ws;
}

function homeWithOneAgent(): { home: string; agentId: string } {
  const home = mkdtempSync(join(tmpdir(), "agent-permissions-"));
  dirs.push(home);
  const ws = identityFolder(home, "ws/rino", "Rino");
  writeFileSync(join(home, "engine.json"), JSON.stringify({
    policy: "./policy.js",
    agents: { rino: { workspace: ws } },
  }));
  writeFileSync(join(home, "policy.js"), "module.exports = { rule: 'owner-only' };\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    owners: ["+391234567890"],
    trusted: ["+390987654321"],
    rules: {
      groups: [
        { channel: "discord", chat: "lotto-siti", senders: ["alice"], denied: ["bob"], mention: true },
      ],
    },
  }));
  return { home, agentId: "rino" };
}

const paths = (home: string) => ({ home, expand: (p: string) => p.replace(/^\.\//, `${home}/`) });

describe("readAgentPermissions", () => {
  test("a configured agent gets its policy, the global owners/trusted and its chat's senders/denied", () => {
    const { home, agentId } = homeWithOneAgent();
    const result = readAgentPermissions(paths(home), agentId);
    expect(result.policy.path).toBe("./policy.js");
    expect(result.policy.rules).toContain("owner-only");
    expect(result.owners).toEqual(["+391234567890"]);
    expect(result.trusted).toEqual(["+390987654321"]);
    expect(result.chats).toEqual([
      { channel: "discord", chat: "lotto-siti", account: "default", mention: true, senders: ["alice"], denied: ["bob"] },
    ]);
  });

  test("no configuration at all, empty everything, no throw", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-permissions-"));
    dirs.push(home);
    const result = readAgentPermissions(paths(home), "nessuno");
    expect(result).toEqual({ policy: { path: "", rules: null }, owners: [], trusted: [], chats: [] });
  });
});

describe("readStoppedLog", () => {
  /** `rino` has no declared account (the default), `visione` owns account `visione`. */
  function fixtureHome(): string {
    const home = mkdtempSync(join(tmpdir(), "stopped-log-home-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({
      agents: { rino: { workspace: "/x/rino" }, visione: { workspace: "/x/visione", account: "visione" } },
    }));
    return home;
  }

  /** The real engine schema: `log (t INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)`,
   *  `detail` as `<channel>:<account>:<chat> <sender>`, optionally followed by ` «message»`. */
  function fixtureDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "stopped-log-"));
    dirs.push(dir);
    const path = join(dir, "channels.sqlite");
    const db = new Database(path);
    db.run("CREATE TABLE log (t INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)");
    db.run("INSERT INTO log (t, what, detail) VALUES (3, 'fermato:senza_menzione', 'discord:visione:100 7')");
    db.run("INSERT INTO log (t, what, detail) VALUES (2, 'fermato:bot_senza_menzione', 'discord:default:200 8')");
    db.run("INSERT INTO log (t, what, detail) VALUES (1, 'fermato:gruppo_spento', 'whatsapp:default:300@g.us 9@s.whatsapp.net «ciao»')");
    db.run("INSERT INTO log (t, what, detail) VALUES (0, 'inviato', 'discord:visione:100 7')");
    db.close();
    return path;
  }

  test("three fermato: rows and one of another kind: three entries, newest first, agent resolved from account", () => {
    const page = readStoppedLog(fixtureDb(), fixtureHome());
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.reason)).toEqual(["senza_menzione", "bot_senza_menzione", "gruppo_spento"]);
    expect(page.rows[0]).toMatchObject({ chat: "100", agent: "visione", reason: "senza_menzione" });
    expect(page.rows[1]).toMatchObject({ chat: "200", agent: "rino", reason: "bot_senza_menzione" });
    expect(page.rows[2]).toMatchObject({ chat: "300@g.us", agent: "rino", reason: "gruppo_spento" });
    expect(JSON.stringify(page.rows)).not.toContain("ciao");
  });

  test("filters by agent and by reason", () => {
    const path = fixtureDb();
    const home = fixtureHome();
    expect(readStoppedLog(path, home, { agent: "visione" }).rows).toHaveLength(1);
    expect(readStoppedLog(path, home, { reason: "gruppo_spento" }).rows).toHaveLength(1);
  });

  test("a missing database, an empty page, no error", () => {
    expect(readStoppedLog(join(tmpdir(), "nowhere.sqlite"), fixtureHome())).toEqual({ rows: [], total: 0, page: 1, pageSize: 20 });
  });

  test("a database with no log table, an empty page, no error", () => {
    const dir = mkdtempSync(join(tmpdir(), "stopped-log-"));
    dirs.push(dir);
    const path = join(dir, "channels.sqlite");
    new Database(path).close();
    expect(readStoppedLog(path, fixtureHome())).toEqual({ rows: [], total: 0, page: 1, pageSize: 20 });
  });
});
