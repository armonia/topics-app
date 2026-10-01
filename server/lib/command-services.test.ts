/**
 * What makes a `run_command` a server (BGVIS-08), and the watcher that sees its
 * ports come and go: pure over the registry's rows and a fake `lsof`.
 * @covers BGVIS-08
 */
import { describe, expect, test } from "bun:test";
import { commandShort, isServiceRow, serviceWatch, servicesOver, SERVICE_END_SHOWN_MS, type ServiceRowLike } from "./command-services";
import { commandWorkOver } from "./command-background";
import { listenLabel, listenUrl, type ListenAddress } from "../../shared/background-work";

const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const row = (processId: string, over: Partial<ServiceRowLike> = {}, wake = false): ServiceRowLike => ({
  processId, scriptName: `name ${processId}`, command: `python3 -m http.server 8777\necho second`,
  startedAt: "2026-10-01T09:59:00.000Z", status: "running", pid: 100 + processId.length,
  cmd: { sessionKey: "topic:a", topicId: "a", wake }, ...over,
});
const at = (port: number, host = "127.0.0.1"): ListenAddress => ({ host, port });

describe("command-services", () => {
  test("a server is a command that does not wake the chat and listens; a waking one or a silent one is not", () => {
    expect(isServiceRow(row("p"), [at(8777)])).toBe(true);
    expect(isServiceRow(row("p", {}, true), [at(8777)])).toBe(false);
    expect(isServiceRow(row("p"), [])).toBe(false);
    expect(isServiceRow(row("p"), undefined)).toBe(false);
  });

  test("the chat's background tasks leave a server out and keep a waking command with a port", () => {
    const listen = new Map([["srv", [at(8777)]], ["woke", [at(9000)]]]);
    const rows = [row("srv"), row("woke", {}, true), row("loop")];
    const work = commandWorkOver(() => rows, (id) => listen.get(id));
    expect(work.tasks("topic:a").map((t) => t.processId)).toEqual(["woke", "loop"]);
    // A session with only a server has no background work at all.
    const only = commandWorkOver(() => [row("srv")], (id) => listen.get(id));
    expect(only.sessions()).toEqual([]);
  });

  test("the chat's servers: the running ones, and an ended one for a few seconds with how it ended", () => {
    const listen = new Map([["srv", [at(8777)]], ["old", [at(3000, "*")]], ["gone", [at(4000)]]]);
    const ended = (id: string, ms: number, over: Partial<ServiceRowLike> = {}) =>
      row(id, { status: "error", completedAt: new Date(NOW - ms).toISOString(), ...over });
    const out = servicesOver(
      [row("srv"), row("loop")],
      [ended("old", 1_000, { exitCode: 1 }), ended("gone", SERVICE_END_SHOWN_MS + 1), ended("nolisten", 10)],
      (id) => listen.get(id), NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.topicId).toBe("a");
    expect(out[0]!.services.map((s) => [s.processId, s.ended ?? null])).toEqual([
      ["srv", null],
      ["old", { at: NOW - 1_000, exitCode: 1, stopped: false }],
    ]);
    expect(out[0]!.services[0]).toMatchObject({ description: "name srv", command: "python3 -m http.server 8777", listen: [at(8777)] });
  });

  test("a stopped server says stopped, with no exit code", () => {
    const out = servicesOver([], [row("s", { status: "error", exitCode: -1, completedAt: new Date(NOW).toISOString(), cmd: { sessionKey: "topic:a", topicId: "a", wake: false, stopped: true } })], () => [at(1)], NOW);
    expect(out[0]!.services[0]!.ended).toEqual({ at: NOW, exitCode: null, stopped: true });
  });

  test("the watcher sees a port appear and go, says so once each time, and asks only for servers it could be", async () => {
    let answer = new Map<number, ListenAddress[]>();
    const asked: number[][] = [];
    const changed: string[] = [];
    const rows = [row("srv"), row("woke", {}, true)];
    const watch = serviceWatch({
      rows: () => rows,
      listenersOf: async (pids) => { asked.push(pids); return answer; },
      onChange: (r) => changed.push(r.processId),
    });
    expect(await watch.tick()).toBe(false);
    answer = new Map([[rows[0]!.pid!, [at(8777)]]]);
    expect(await watch.tick()).toBe(true);
    expect(watch.listenOf("srv")).toEqual([at(8777)]);
    expect(await watch.tick()).toBe(false);
    answer = new Map();
    expect(await watch.tick()).toBe(true);
    expect(watch.listenOf("srv")).toBeUndefined();
    expect(changed).toEqual(["srv", "srv"]);
    expect(asked.every((pids) => pids.length === 1 && pids[0] === rows[0]!.pid)).toBe(true);
  });

  test("an address reads as the row writes it and opens on the loopback when it listens everywhere", () => {
    expect(listenLabel(at(8777))).toBe("127.0.0.1:8777");
    expect(listenLabel(at(3000, "*"))).toBe("0.0.0.0:3000");
    expect(listenUrl(at(8777))).toBe("http://127.0.0.1:8777/");
    expect(listenUrl(at(3000, "*"))).toBe("http://127.0.0.1:3000/");
    expect(listenUrl(at(5173, "[::1]"))).toBe("http://[::1]:5173/");
    expect(commandShort("\n  npm run dev  -- --port 5173\nmore")).toBe("npm run dev -- --port 5173");
  });
});
