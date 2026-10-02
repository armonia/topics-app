/**
 * @covers BGVIS-08
 *
 * The two probes that list listening sockets read into the same rows: `lsof`
 * (macOS, and Linux where installed) and `ss` (Linux, always there). The CI
 * runners have `ss` and no guaranteed `lsof`, and a chat's server is only ever
 * seen through these rows.
 */
import { describe, expect, test } from "bun:test";
import { parseLsof, parseSs, servesHtml } from "./listening-ports";

describe("listening sockets", () => {
  test("lsof: one row per port, the lowest first, any address written as *", () => {
    const out = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "Python  8777 me    3u  IPv4 0x1      0t0  TCP 127.0.0.1:8777 (LISTEN)",
      "node     222 me   20u  IPv6 0x2      0t0  TCP *:3000 (LISTEN)",
      "node     222 me   21u  IPv4 0x3      0t0  TCP *:3000 (LISTEN)",
      "bun      300 me    5u  IPv6 0x4      0t0  TCP [::1]:5173 (LISTEN)",
    ].join("\n");
    expect(parseLsof(out)).toEqual([
      { port: 3000, pid: 222, command: "node", host: "*" },
      { port: 5173, pid: 300, command: "bun", host: "[::1]" },
      { port: 8777, pid: 8777, command: "Python", host: "127.0.0.1" },
    ]);
  });

  test("ss: the same rows, and a socket of another user (no process) is left out", () => {
    const out = [
      'LISTEN 0      5          127.0.0.1:8777       0.0.0.0:*    users:(("python3",pid=12345,fd=3))',
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=222,fd=20))',
      'LISTEN 0      511             [::]:3000          [::]:*    users:(("node",pid=222,fd=21))',
      'LISTEN 0      4096           [::1]:631           [::]:*',
      "",
    ].join("\n");
    expect(parseSs(out)).toEqual([
      { port: 3000, pid: 222, command: "node", host: "*" },
      { port: 8777, pid: 12345, command: "python3", host: "127.0.0.1" },
    ]);
  });

  test("a port serves a page when / answers text/html; an API, or nothing listening, does not", async () => {
    const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }) });
    const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
    try {
      expect(await servesHtml({ host: "127.0.0.1", port: page.port! })).toBe(true);
      expect(await servesHtml({ host: "*", port: page.port! })).toBe(true);
      expect(await servesHtml({ host: "127.0.0.1", port: api.port! })).toBe(false);
    } finally {
      page.stop(true);
      api.stop(true);
    }
    expect(await servesHtml({ host: "127.0.0.1", port: api.port! })).toBe(false);
  });
});
