/**
 * @covers LIVETERM-03
 */
import { describe, it, expect } from "bun:test";
import {
  createLiveTerminals,
  defaultRunner,
  parseForeground,
  parseLsofCwd,
  parseTerminalTabs,
  parseTmuxPanes,
  type Runner,
} from "./live-terminals";

describe("parseTmuxPanes", () => {
  it("una riga per pane, le righe storte si saltano", () => {
    const out = parseTmuxPanes(
      "%8\tsucla\t0\t0\t/dev/ttys005\t2.1.296\t/Users/a\tsucla\n" +
      "spazzatura\n" +
      "%10\thub\t1\t2\t/dev/ttys022\tnode\t/Users/a/hub\tnode\n",
    );
    expect(out.map((r) => [r.id, r.title, r.tty])).toEqual([
      ["tmux:%8", "sucla:0.0", "/dev/ttys005"],
      ["tmux:%10", "hub:1.2", "/dev/ttys022"],
    ]);
  });
});

describe("parseTerminalTabs", () => {
  it("tty e titolo; senza /dev/ non è una tab", () => {
    expect(parseTerminalTabs("/dev/ttys004\t✳ Lavoro\n\n/dev/ttys006\t\n")).toEqual([
      { tty: "/dev/ttys004", title: "✳ Lavoro" },
      { tty: "/dev/ttys006", title: "" },
    ]);
  });
});

describe("parseForeground", () => {
  it("il capo del gruppo in primo piano, non un figlio a caso", () => {
    const fg = parseForeground(
      [
        "  101 s004   101 login",
        "  102 s004   300 -zsh",
        "  300 s004   300 claude",
        "  301 s004   300 /opt/homebrew/bin/node",
        "  400 ??     400 launchd",
      ].join("\n"),
    );
    expect(fg.get("/dev/ttys004")).toEqual({ pid: 300, command: "claude" });
    expect(fg.size).toBe(1);
  });

  it("una shell senza niente sopra è la shell", () => {
    expect(parseForeground(" 102 s007  102 -zsh").get("/dev/ttys007")?.command).toBe("zsh");
  });
});

describe("parseLsofCwd", () => {
  it("pid → cartella", () => {
    expect([...parseLsofCwd("p300\nfcwd\nn/Users/a/repo\np301\nfcwd\nn/tmp\n")]).toEqual([
      [300, "/Users/a/repo"],
      [301, "/tmp"],
    ]);
  });
});

/** A fake runner that records calls and answers per command. */
function fakeRunner(answers: Record<string, string | Error>) {
  const calls: Array<[string, string[]]> = [];
  const run: Runner = async (file, args) => {
    calls.push([file, args]);
    const key = `${file} ${args.find((a) => !a.startsWith("-") ) ?? ""}`;
    const a = answers[key] ?? answers[file];
    if (a instanceof Error) throw a;
    return a ?? "";
  };
  return { run, calls };
}

const topicsRow = {
  id: "topics:abc", source: "topics" as const, title: "Claude", command: "claude-code",
  cwd: "/r", tty: null, busy: true, sessionId: "abc",
};

describe("createLiveTerminals", () => {
  it("unisce Topics, tmux e Terminal; una sorgente rotta non spegne le altre", async () => {
    const { run } = fakeRunner({
      "tmux list-panes": "%1\ts\t0\t0\t/dev/ttys001\tzsh\t/r\ts\n",
      osascript: new Error("not authorized"),
      ps: "  50 s001  50 zsh",
    });
    const svc = createLiveTerminals({
      topics: () => [topicsRow], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: true, terminal: true }, log: () => {},
    });
    const rows = await svc.list();
    expect(rows.map((r) => r.id)).toEqual(["topics:abc", "tmux:%1"]);
    expect(rows[1].command).toBe("zsh");
  });

  it("tmux sempre con -u: sotto launchd, senza locale UTF-8, i tab del formato diventano _", async () => {
    const { run, calls } = fakeRunner({ "tmux list-panes": "%1\ts\t0\t0\t/dev/ttys001\tzsh\t/r\ts\n" });
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: true, terminal: false }, log: () => {},
    });
    await svc.list();
    await svc.screen("tmux:%1");
    const tmuxCalls = calls.filter(([f]) => f === "tmux");
    expect(tmuxCalls.length).toBe(2);
    for (const [, args] of tmuxCalls) expect(args[0]).toBe("-u");
  });

  it("Terminal.app che non risponde si salta per un minuto, così la lista non lo aspetta ogni volta", async () => {
    const { run, calls } = fakeRunner({ osascript: new Error("timed out") });
    let t = 1_000;
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, now: () => t, ttlMs: 0, sources: { tmux: false, terminal: true }, log: () => {},
    });
    const asked = () => calls.filter(([f]) => f === "osascript").length;
    await svc.list({ force: true });
    expect(asked()).toBe(1);
    t += 30_000;
    await svc.list({ force: true });
    expect(asked()).toBe(1);
    t += 31_000;
    await svc.list({ force: true });
    expect(asked()).toBe(2);
  });

  it("Terminal.app in timeout: una riga sola per stato, senza l'oggetto errore; il rientro si annuncia una volta", async () => {
    // The shape osascript really rejects with when the kill arrives: a multi-line message, no stderr.
    const killed = Object.assign(
      new Error('Command failed: osascript -e tell application "Terminal"\n  return (count of windows)\nend tell'),
      { killed: true, signal: "SIGTERM", code: null },
    );
    const answers: Record<string, string | Error> = { osascript: killed };
    const { run, calls } = fakeRunner(answers);
    const logs: Array<{ msg: string; err?: unknown }> = [];
    let t = 1_000;
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, now: () => t, ttlMs: 0, sources: { tmux: false, terminal: true },
      log: (msg, err) => { logs.push({ msg, err }); },
    });
    const asked = () => calls.filter(([f]) => f === "osascript").length;
    // Five timeouts in a row, each one past the pause, so osascript really runs every time.
    for (let i = 0; i < 5; i++) {
      await svc.list({ force: true });
      t += 61_000;
    }
    expect(asked()).toBe(5);
    expect(logs.length).toBe(1);
    expect(logs[0].msg).not.toContain("\n");
    expect(logs[0].err).toBeUndefined();
    expect(logs[0].msg).toMatch(/ucciso dopo 1500 ms/);
    expect(logs[0].msg).toMatch(/Automazione/);
    // Terminal.app answers again: one line saying so, nothing more.
    answers.osascript = "";
    await svc.list({ force: true });
    expect(logs.length).toBe(2);
    expect(logs[1].msg).toMatch(/di nuovo raggiungibile/);
    expect(logs[1].err).toBeUndefined();
  });

  it("Terminal.app: se la causa cambia senza un successo in mezzo, la riga si riscrive; la stessa causa resta muta", async () => {
    const commandLine = 'Command failed: osascript -e tell application "Terminal"\n  return 1\nend tell';
    const kill = Object.assign(new Error(commandLine), { killed: true, signal: "SIGTERM", code: null });
    const refusal = Object.assign(new Error(commandLine), {
      killed: false, signal: null, code: 1,
      stderr: "\n  execution error: Not authorized to send Apple events to Terminal. (-1743)\n",
    });
    const answers: Record<string, string | Error> = { osascript: kill };
    const { run } = fakeRunner(answers);
    const logs: string[] = [];
    let t = 1_000;
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, now: () => t, ttlMs: 0, sources: { tmux: false, terminal: true },
      log: (msg) => { logs.push(msg); },
    });
    const round = async () => { await svc.list({ force: true }); t += 61_000; };
    await round(); await round();
    answers.osascript = refusal;
    await round(); await round();
    // Same kind (failed), different reason: the reason is part of the state too.
    answers.osascript = Object.assign(new Error(commandLine), {
      killed: false, signal: null, code: 1,
      stderr: "execution error: Terminal got an error: Connection is invalid. (-609)\n",
    });
    await round(); await round();
    expect(logs.length).toBe(3);
    expect(logs[0]).toMatch(/ucciso/);
    expect(logs[1]).toMatch(/osascript fallito/);
    expect(logs[1]).toContain("-1743");
    expect(logs[2]).toContain("-609");
    for (const l of logs) expect(l).not.toContain("Command failed");
  });

  it("defaultRunner: l'errore respinto porta stderr, dove sta il motivo vero", async () => {
    const err = await defaultRunner("sh", ["-c", "echo boom >&2; exit 3"]).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(String((err as { stderr?: unknown }).stderr)).toContain("boom");
  });

  it("tmux: testo letterale e Invio in due chiamate, così «Enter» scritto resta testo", async () => {
    const { run, calls } = fakeRunner({});
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: true, terminal: false },
    });
    expect(await svc.send("tmux:%3", "scrivi Enter")).toBe(true);
    const sends = calls.filter(([f, a]) => f === "tmux" && a.includes("send-keys")).map(([, a]) => a.slice(a.indexOf("send-keys")));
    expect(sends).toEqual([
      ["send-keys", "-t", "%3", "-l", "--", "scrivi Enter"],
      ["send-keys", "-t", "%3", "Enter"],
    ]);
  });

  it("Topics: Invio = \\r in coda, senza Invio il testo e basta", async () => {
    const got: string[] = [];
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null,
      topicsSend: (_id, d) => { got.push(d); return true; },
      run: fakeRunner({}).run, sources: { tmux: false, terminal: false },
    });
    await svc.send("topics:abc", "ls");
    await svc.send("topics:abc", "\x03", { enter: false });
    expect(got).toEqual(["ls\r", "\x03"]);
  });

  it("un id che non ha la forma della sua sorgente non arriva a tmux né a osascript", async () => {
    const { run, calls } = fakeRunner({});
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: true, terminal: true },
    });
    expect(await svc.send("tmux:-t%1", "x")).toBe(false);
    expect(await svc.send("terminal:../../x", "x")).toBe(false);
    expect(await svc.screen("tmux:%1;rm")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("Terminal.app: senza Invio non si può scrivere, e lo dice", async () => {
    const { run, calls } = fakeRunner({ osascript: "ok" });
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: false, terminal: true },
    });
    expect(await svc.send("terminal:ttys004", "x", { enter: false })).toBe(false);
    expect(await svc.send("terminal:ttys004", "x")).toBe(true);
    expect(calls.at(-1)?.[1].slice(-2)).toEqual(["/dev/ttys004", "x"]);
  });

  it("lo schermo di Terminal arriva con i CR del Mac classico: diventano a capo", async () => {
    const { run } = fakeRunner({ osascript: "riga 1\rriga 2\r\r" });
    const svc = createLiveTerminals({
      topics: () => [], topicsScreen: async () => null, topicsSend: () => true,
      run, sources: { tmux: false, terminal: true },
    });
    expect((await svc.screen("terminal:ttys004"))?.text).toBe("riga 1\nriga 2");
  });
});
