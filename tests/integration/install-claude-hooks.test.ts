/**
 * `scripts/install-claude-hooks.ts` scrive nella `~/.claude/settings.json`
 * dell'utente, e lo fa al momento dell'import (chiamata a `install()` a livello
 * di modulo). Importarlo qui vorrebbe dire riscrivere i settings VERI di chi fa
 * girare i test: si esegue quindi come sottoprocesso con `HOME` puntato a una
 * cartella temporanea — che è anche una prova più forte, perché passa dallo
 * stesso percorso che usa una persona.
 *
 * Quello che si pinna:
 *  1. il path del wrapper è QUOTATO (una home con uno spazio spezzava l'hook, in
 *     silenzio: niente segnale di fine turno, fase appesa a `starting`);
 *  2. reinstallare RIPARA una entry nostra scritta da una versione precedente,
 *     invece di riconoscerla e lasciarla difettosa per sempre;
 *  3. le entry di altri non si toccano, né in install né in uninstall;
 *  4. async only on UserPromptSubmit, Stop and Notification, and no event the
 *     CLI no longer emits;
 *  5. the legacy unmarked entries (the live shape before `topics_app`) are
 *     repaired in place by install and removed by uninstall, one Topics hook
 *     per event;
 *  6. the script lives under TOPICS_HOME, next to the token, and no longer in
 *     `~/.claude/topics-hooks/`: install points every entry there and removes
 *     the old copy, uninstall leaves the TOPICS_HOME one to the server;
 *  7. the entries are the ones of `server/lib/topics-hooks.ts`, the same
 *     definition the spawns pass through `--settings`.
 *
 * @covers CCS-06
 *
 * Hook installer idempotency. Strong proof: it runs the real script as a
 * subprocess with a temporary HOME, i.e. the same path a person takes. Partial
 * on the uninstall branch.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TOPICS_HOOK_EVENTS, topicsHookEntry } from "../../server/lib/topics-hooks";

const SCRIPT = join(import.meta.dir, "../../scripts/install-claude-hooks.ts");

let home = "";
const settingsPath = () => join(home, ".claude", "settings.json");
// Where the script lives now, and where an older version copied it.
const wrapper = () => join(home, ".topics", "claude-hooks", "post-hook.sh");
const legacyWrapper = () => `${home}/.claude/topics-hooks/post-hook.sh`;

function run(cmd: "install" | "uninstall") {
  const r = Bun.spawnSync(["bun", SCRIPT, cmd], {
    // TOPICS_HOME pinned too: inherited from the shell running the suite, it
    // would send the script into the real Topics home.
    env: { ...process.env, HOME: home, TOPICS_HOME: join(home, ".topics") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd} exit ${r.exitCode}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath(), "utf-8"));
}

function ourEntries(s: any, event: string): any[] {
  const matchers = s.hooks?.[event] ?? [];
  return matchers.flatMap((m: any) => m.hooks.filter((h: any) => h.topics_app === true));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "topics-hooks-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe("install-claude-hooks", () => {
  test("installa da zero e QUOTA il path del wrapper", () => {
    run("install");
    const entries = ourEntries(readSettings(), "SessionStart");
    expect(entries.length).toBe(1);
    // Il cuore del fix: senza apici, `/bin/sh -c` spezza una home con lo spazio.
    expect(entries[0].command).toBe(`"${wrapper()}" SessionStart`);
    expect(entries[0].topics_app).toBe(true);
  });

  test("è idempotente: reinstallare non duplica e non cambia niente", () => {
    run("install");
    const primo = readFileSync(settingsPath(), "utf-8");
    run("install");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(primo);
    expect(ourEntries(readSettings(), "Stop").length).toBe(1);
  });

  test("RIPARA una entry nostra rimasta col path non quotato", () => {
    // Esattamente ciò che ha scritto la versione precedente dello script.
    const vecchio = `${wrapper()} SessionStart`;
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: vecchio, timeout: 5, topics_app: true }] },
          ],
        },
      }),
    );

    run("install");

    const entries = ourEntries(readSettings(), "SessionStart");
    expect(entries.length).toBe(1); // riscritta, non affiancata da un duplicato
    expect(entries[0].command).toBe(`"${wrapper()}" SessionStart`);
  });

  test("le entry di altri sopravvivono a install e a uninstall", () => {
    const altrui = { type: "command", command: "/usr/local/bin/mio-hook.sh", timeout: 3 };
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [altrui] }] } }),
    );

    run("install");
    let s = readSettings();
    expect(s.hooks.SessionStart[0].hooks).toContainEqual(altrui);
    expect(ourEntries(s, "SessionStart").length).toBe(1);

    run("uninstall");
    s = readSettings();
    expect(s.hooks.SessionStart[0].hooks).toEqual([altrui]); // resta solo la sua
    expect(ourEntries(s, "SessionStart").length).toBe(0);
    expect(existsSync(join(home, ".claude", "topics-hooks"))).toBe(false);
  });

  // The live settings.json of the person who installed Topics before the
  // `topics_app` marker existed: seven entries, no marker, path NOT quoted,
  // each one sitting next to hooks that belong to other tools. Stop's entry is
  // the third hook of its matcher, the same place it occupies on the real file.
  function legacyLiveShape(quoted: boolean) {
    const ours = (event: string) => {
      const path = legacyWrapper();
      return { type: "command", command: quoted ? `"${path}" ${event}` : `${path} ${event}`, timeout: 5 };
    };
    const foreign = (name: string) => ({ type: "command", command: `/usr/local/bin/${name}.sh`, timeout: 5 });
    return {
      hooks: {
        Notification: [{ hooks: [ours("Notification")] }],
        PostToolUse: [{ hooks: [ours("PostToolUse")] }],
        PreToolUse: [{ hooks: [ours("PreToolUse")] }, { matcher: "Bash", hooks: [foreign("block-coauthor")] }],
        SessionEnd: [{ matcher: "", hooks: [{ ...foreign("status"), async: true }, ours("SessionEnd")] }],
        SessionStart: [{ matcher: "", hooks: [ours("SessionStart")] }, { matcher: "startup|resume", hooks: [foreign("hotkey")] }],
        Stop: [
          { hooks: [foreign("finish-time"), foreign("notify"), ours("Stop")] },
          { matcher: "", hooks: [{ ...foreign("status"), async: true }] },
        ],
        UserPromptSubmit: [{ hooks: [ours("UserPromptSubmit")] }, { matcher: "", hooks: [foreign("status")] }],
        PermissionRequest: [{ matcher: "", hooks: [foreign("status")] }],
      },
    };
  }

  const TOPICS_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"];
  const ASYNC_EVENTS = ["UserPromptSubmit", "Stop", "Notification"];

  /** Every Topics wrapper entry of an event, marked or not. */
  function wrapperEntries(s: any, event: string): any[] {
    const matchers = s.hooks?.[event] ?? [];
    return matchers.flatMap((m: any) => m.hooks.filter((h: any) => /(topics|claude)-hooks\/post-hook\.sh/.test(String(h.command))));
  }

  test("async only on UserPromptSubmit, Stop and Notification, timeout 5 everywhere", () => {
    run("install");
    const s = readSettings();
    for (const event of TOPICS_EVENTS) {
      const entries = ourEntries(s, event);
      expect(entries.length).toBe(1);
      expect(entries[0].timeout).toBe(5);
      // The three fire-and-forget events must not hold the turn: a starved
      // server made every prompt wait up to 5 s. The other four stay blocking
      // on purpose (tool ordering for the swap freezer, transcript path).
      if (ASYNC_EVENTS.includes(event)) expect(entries[0].async).toBe(true);
      else expect("async" in entries[0]).toBe(false);
    }
  });

  test("does not register events the CLI no longer emits", () => {
    run("install");
    const s = readSettings();
    // Claude Code ignores unknown hook events and warns about each one.
    expect(Object.keys(s.hooks).sort()).toEqual([...TOPICS_EVENTS].sort());
  });

  for (const quoted of [false, true]) {
    test(`repairs in place the legacy unmarked entries (${quoted ? "quoted" : "unquoted"} path)`, () => {
      const before = legacyLiveShape(quoted);
      writeFileSync(settingsPath(), JSON.stringify(before, null, 2));

      run("install");

      const s = readSettings();
      const canonical = (event: string) => ({
        type: "command",
        command: `"${wrapper()}" ${event}`,
        timeout: 5,
        ...(ASYNC_EVENTS.includes(event) ? { async: true } : {}),
        topics_app: true,
      });
      for (const event of TOPICS_EVENTS) {
        // One Topics entry per event: the legacy one was repaired, not joined
        // by a marked twin.
        expect(wrapperEntries(s, event)).toEqual([canonical(event)]);
      }
      // Repaired where it stood: Stop's entry is still the third hook of the
      // first matcher, after the two foreign ones.
      expect(s.hooks.Stop[0].hooks.map((h: any) => h.command)).toEqual([
        "/usr/local/bin/finish-time.sh",
        "/usr/local/bin/notify.sh",
        `"${wrapper()}" Stop`,
      ]);
      expect(s.hooks.SessionEnd[0].hooks[1]).toEqual(canonical("SessionEnd"));
      // Foreign matchers and hooks are byte-identical.
      expect(s.hooks.Stop[1]).toEqual(before.hooks.Stop[1]);
      expect(s.hooks.PreToolUse[1]).toEqual(before.hooks.PreToolUse[1]);
      expect(s.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
      expect(s.hooks.MonitorArmed).toBeUndefined();
    });
  }

  test("collapses duplicate Topics entries left by the old installer into one", () => {
    // What running the old installer over the legacy shape produced: the
    // unmarked entry plus a marked twin appended next to it.
    const legacy = legacyLiveShape(false);
    legacy.hooks.Stop[0].hooks.push({
      type: "command",
      command: `"${legacyWrapper()}" Stop`,
      timeout: 5,
      topics_app: true,
    } as any);
    writeFileSync(settingsPath(), JSON.stringify(legacy, null, 2));

    run("install");

    const s = readSettings();
    expect(wrapperEntries(s, "Stop").length).toBe(1);
    expect(s.hooks.Stop[0].hooks.length).toBe(3);
  });

  test("one install converges the legacy shape: reinstalling produces no diff", () => {
    writeFileSync(settingsPath(), JSON.stringify(legacyLiveShape(false), null, 2));
    run("install");
    const first = readFileSync(settingsPath(), "utf-8");
    // Converged in ONE pass, not "stable because the twin is already there":
    // the old installer was idempotent too, on a file holding two Topics hooks
    // per event.
    for (const event of TOPICS_EVENTS) expect(wrapperEntries(JSON.parse(first), event).length).toBe(1);
    const out = run("install");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(first);
    expect(out).toContain("(0 added, 0 updated, 7 already current");
  });

  test("uninstall also recognises the legacy unmarked entries", () => {
    const before = legacyLiveShape(false);
    writeFileSync(settingsPath(), JSON.stringify(before, null, 2));

    run("uninstall");

    const s = readSettings();
    for (const event of TOPICS_EVENTS) expect(wrapperEntries(s, event)).toEqual([]);
    expect(s.hooks.Stop[0].hooks.map((h: any) => h.command)).toEqual([
      "/usr/local/bin/finish-time.sh",
      "/usr/local/bin/notify.sh",
    ]);
    // Matchers that only held our entry are gone, along with emptied events.
    expect(s.hooks.Notification).toBeUndefined();
    expect(s.hooks.PreToolUse).toEqual([before.hooks.PreToolUse[1]]);
    expect(s.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
  });

  const marked = (event: string) => ({
    type: "command",
    command: `"${wrapper()}" ${event}`,
    timeout: 5,
    ...(ASYNC_EVENTS.includes(event) ? { async: true } : {}),
    topics_app: true,
  });
  const guard = { type: "command", command: "/usr/local/bin/block-coauthor.sh", timeout: 5 };
  const firesOnEveryTool = (m: any) => !m.matcher || m.matcher === "*";

  test("install leaves an empty matcher that is not ours where it is", () => {
    const before = {
      hooks: {
        PreToolUse: [{ hooks: [marked("PreToolUse")] }, { matcher: "Edit", hooks: [] }],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(before, null, 2));

    run("install");

    // Somebody else's matcher, empty before install touched the file: it is
    // not ours to tidy up.
    expect(readSettings().hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
  });

  test("the Topics entry ends up in a wildcard matcher, never in a narrowed one", () => {
    const legacy = { type: "command", command: `${legacyWrapper()} PreToolUse`, timeout: 5 };
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [guard, legacy] },
            { hooks: [marked("PreToolUse")] },
          ],
          // A narrowed matcher holding nothing but a Topics twin goes with it.
          PostToolUse: [{ matcher: "Edit", hooks: [marked("PostToolUse")] }, { hooks: [marked("PostToolUse")] }],
        },
      }),
    );

    run("install");

    const s = readSettings();
    // Limited to Bash, the hook would never see AskUserQuestion, ExitPlanMode
    // or Monitor: the wildcard copy is the one that stays.
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [guard] }, { hooks: [marked("PreToolUse")] }]);
    expect(s.hooks.PostToolUse).toEqual([{ hooks: [marked("PostToolUse")] }]);
  });

  test("a Topics entry found only in a narrowed matcher moves to a wildcard one", () => {
    const legacy = { type: "command", command: `${legacyWrapper()} PreToolUse`, timeout: 5 };
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [guard, legacy] }] } }),
    );

    run("install");

    const s = readSettings();
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [guard] });
    const wild = s.hooks.PreToolUse.filter(firesOnEveryTool);
    expect(wild.flatMap((m: any) => m.hooks)).toEqual([marked("PreToolUse")]);
    expect(wrapperEntries(s, "PreToolUse")).toEqual([marked("PreToolUse")]);
    // And it converged: a second run changes nothing.
    const first = readFileSync(settingsPath(), "utf-8");
    run("install");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(first);
  });

  test("a matcher without a hooks key survives install and uninstall untouched", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash" }, { hooks: [marked("PreToolUse")] }] } }),
    );

    run("install");
    expect(readSettings().hooks.PreToolUse).toEqual([{ matcher: "Bash" }, { hooks: [marked("PreToolUse")] }]);

    run("uninstall");
    expect(readSettings().hooks.PreToolUse).toEqual([{ matcher: "Bash" }]);
  });

  test("a marked entry is ours under whatever event it sits", () => {
    const foreign = { type: "command", command: "/usr/local/bin/notify.sh", timeout: 5 };
    const stray = { ...marked("SessionEnd") };
    const shape = { hooks: { Stop: [{ hooks: [foreign, stray] }] } };
    writeFileSync(settingsPath(), JSON.stringify(shape, null, 2));

    run("uninstall");
    expect(readSettings().hooks.Stop).toEqual([{ hooks: [foreign] }]);

    // Install repairs it into the Stop entry instead of appending a second
    // Topics hook next to a wrapper that would report SessionEnd on every turn.
    writeFileSync(settingsPath(), JSON.stringify(shape, null, 2));
    run("install");
    expect(readSettings().hooks.Stop).toEqual([{ hooks: [foreign, marked("Stop")] }]);
  });
  test("the script goes under TOPICS_HOME, 0755, with the text of scripts/claude-hooks/post-hook.sh", () => {
    run("install");
    const source = readFileSync(join(import.meta.dir, "../../scripts/claude-hooks/post-hook.sh"), "utf-8");
    expect(readFileSync(wrapper(), "utf-8")).toBe(source);
    expect(statSync(wrapper()).mode & 0o777).toBe(0o755);
    // In ~/.claude only the settings file: no script copy any more.
    expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  test("install removes the old copy under ~/.claude/topics-hooks, uninstall keeps the TOPICS_HOME one", () => {
    mkdirSync(join(home, ".claude", "topics-hooks"), { recursive: true });
    writeFileSync(legacyWrapper(), "#!/bin/sh\nexit 0\n");

    run("install");
    expect(existsSync(join(home, ".claude", "topics-hooks"))).toBe(false);

    run("uninstall");
    // The server's own spawns still name it in their `--settings`.
    expect(existsSync(wrapper())).toBe(true);
  });

  test("the entries are the shared definition the spawns pass through --settings", () => {
    run("install");
    const s = readSettings();
    for (const event of TOPICS_HOOK_EVENTS) expect(ourEntries(s, event)).toEqual([topicsHookEntry(wrapper(), event)]);
  });
});
