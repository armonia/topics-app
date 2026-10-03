/**
 * Every slash command the composer OFFERS has somewhere to go.
 *
 * THE DEFECT THAT PRODUCED THIS FILE, measured 2026-08-25: `/pause` and
 * `/assign` sat in the composer's menu, described as "Pause agent (@name)" and
 * "Assign task (@name task)". Neither existed. No handler in `ChatPane`, and
 * not in the server's `CLI_BUILTINS` allowlist either — so choosing one from
 * the menu sent its literal text to the model as ordinary prose, with the whole
 * context preamble in front of it. No error, no log; the agent answered
 * something plausible about pausing, and nothing was paused.
 *
 * THE TWO DESTINATIONS, and why membership in one of them is the whole test.
 * A `/x` typed in the composer can end in exactly two places:
 *
 *   1. `ChatPane.handleSlashCommand` intercepts it and does something local
 *      (open a panel, switch a model, run a route);
 *   2. it is in `CLI_BUILTINS` (`server/context/adapt.ts`) and travels NAKED to
 *      the CLI, which parses it itself. Naked matters: the allowlist exists
 *      because the context preamble, prepended, hides the command from the
 *      CLI's parser — and because "starts with a slash" also matched a pasted
 *      path, stripping a whole turn of its project context.
 *
 * Anything in neither is prose wearing a command's clothes. That is a defect
 * the compiler cannot see, the type system cannot see, and a user only finds by
 * picking the entry and watching nothing happen.
 *
 * WHY IT READS THE SOURCE instead of importing the two modules. It is the house
 * method here (`GlobalCapControl.test.tsx`, `ThreadRuns.test.tsx`): `ChatPane`
 * pulls in the store, the pane layout, the API and a dozen hooks, so it does
 * not mount in a unit test — and `bun test` does not even resolve the `@/`
 * alias those files use. The fact under test is not behavioural anyway; it is
 * "these two lists agree", and the lists are literals.
 *
 * @covers CMD-06, CMD-09, CHAT-FORK-04
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_REFUSED } from "./cliRefused";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SLASH_COMMANDS_SRC = read("client/src/components/Chat/slashCommands.ts");
const CHAT_PANE = read("client/src/components/Chat/ChatPane.tsx");
const ADAPT = read("server/context/adapt.ts");

/** The commands the composer offers, from the `SLASH_COMMANDS` literal. */
const offered: string[] = [...SLASH_COMMANDS_SRC.matchAll(/\{\s*cmd:\s*'\/([a-z-]+)'/g)].map((m) => m[1]!);

/** The names the server hands to the CLI untouched. */
const naked: Set<string> = (() => {
  const start = ADAPT.indexOf("const CLI_BUILTINS");
  const end = ADAPT.indexOf("]);", start);
  expect(start, "CLI_BUILTINS non e' piu' dove questo test lo cerca").toBeGreaterThan(-1);
  return new Set([...ADAPT.slice(start, end).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
})();

/** Does `ChatPane` name this command anywhere it could act on it? */
const handled = (c: string) => new RegExp(`['"\`]/${c}['"\` ]`).test(CHAT_PANE);

/**
 * Does `ChatPane` act on the command typed BARE, with nothing after it?
 *
 * Both menus insert `cmd + ' '` and the send trims it, so a bare `/x` is what a
 * person who picks an entry actually sends. `handled` above also matches
 * `'/browser '` (the form with an argument) and a name in backticks inside a
 * comment, so `/browser` and `/model` read as covered while their bare form
 * went to the model as prose. Only a comparison of the whole command counts.
 */
const bareIn = (src: string, c: string) => new RegExp(`cmd === '/${c}'`).test(src);
const handledBare = (c: string) => bareIn(CHAT_PANE, c);

/**
 * What the installed Claude Code does in `--print`, measured on 2.1.288 (see
 * `_source` in the fixture): the names it runs, its aliases, and the names it
 * refuses in this mode. Data, not code: when the CLI changes, the fixture is
 * re-measured and this file says which lists fell behind.
 */
const CLI: { headless: string[]; aliases: Record<string, string>; refused: string[] } = JSON.parse(
  read("client/src/components/Chat/claudeCliCommands.fixture.json"),
);
const cliRuns = new Set([...CLI.headless, ...Object.keys(CLI.aliases)]);
const cliRefuses = new Set(CLI.refused);

describe("the two lists are non-empty, or this file proves nothing", () => {
  // Both are read out of source with a regex. A rename that breaks either
  // pattern would leave an empty list, and an empty list passes every
  // assertion below while checking nothing at all.
  test("the composer offers a plausible number of commands", () => {
    expect(offered.length).toBeGreaterThan(8);
    expect(new Set(offered).size, "the same command offered twice").toBe(offered.length);
  });

  test("the allowlist is a plausible size", () => {
    expect(naked.size).toBeGreaterThan(20);
  });
});

describe("no menu entry leads nowhere", () => {
  test("each offered command is either handled here or passed naked to the CLI", () => {
    const orphans = offered.filter((c) => !handled(c) && !naked.has(c));
    expect(
      orphans,
      "these are offered in the composer and go nowhere: picking one sends its text to the model as prose",
    ).toEqual([]);
  });

  test("and the check can actually fail", () => {
    // The non-vacuity half, stated as an assertion instead of trusted: a name
    // that is in neither list must be reported. Without this, a broken
    // `handled` regex (one that matches everything) would make the test above
    // permanently green.
    const invented = "questo-comando-non-esiste";
    expect(handled(invented)).toBe(false);
    expect(naked.has(invented)).toBe(false);
  });
});

describe("`/help` cannot fall behind the menu", () => {
  // It used to be a second hand-written array in `ChatPane`, and the two
  // drifted: `/help` named ten commands while the menu offered more. The one
  // place a user goes to ask "what can I type here" gave the shorter, older
  // answer, and neither list looked incomplete on its own.
  //
  // The cure was to DERIVE it, so this test guards against the cure being
  // undone rather than against the drift — a hand-written list can drift again
  // the day after anyone syncs it.
  //
  // It is a FUNCTION of `tr` now rather than a constant, because the array
  // carries i18n keys and the text only exists once a language is chosen. What
  // is guarded is unchanged: the lines come from `SLASH_COMMANDS`, not from a
  // second list.
  test("the help text is built from the same array the menu uses", () => {
    const line = CHAT_PANE.match(/const slashCommandsHelp\s*=\s*([^;]+);/)?.[1] ?? "";
    expect(line, "`/help` is a hand-written list again").toContain("SLASH_COMMANDS.map");
    expect(CHAT_PANE, "`ChatPane` must import the menu, not copy it").toContain(
      "import { SLASH_COMMANDS } from './slashCommands'",
    );
  });
});

describe("`/fork` is Topics' own", () => {
  // It creates a topic and opens a tab: nothing the CLI could do, and a CLI
  // that received it would answer an unknown command as prose.
  test("answered in the composer, never passed naked to the CLI", () => {
    expect(handled("fork")).toBe(true);
    expect(naked.has("fork")).toBe(false);
  });
});

describe("a command the CLI cannot run does not go to the CLI in silence", () => {
  // `/rewind` is `supportsNonInteractive: false` in the CLI's own registry — a
  // TUI screen — and Topics runs the CLI with `--print`. It is nevertheless in
  // `CLI_BUILTINS`, so the message was delivered faithfully to a process that
  // discards it: no error, no log, nothing on screen.
  test("`/rewind` is answered locally instead of being forwarded", () => {
    expect(
      /cmd === '\/rewind'/.test(CHAT_PANE),
      "without a local branch, /rewind reaches a CLI that silently drops it",
    ).toBe(true);
  });
});

describe("the allowlist can be matched at all", () => {
  // `isCliBuiltin` compares the first token AFTER the slash, lowercased, and
  // rejects anything containing a slash. An entry written `"/compact"` or
  // `"output style"` would therefore never match anything — dead weight that
  // reads as coverage: the name is in the list, so everyone assumes it passes.
  test("no entry carries a slash, a space or an upper-case letter", () => {
    const inert = [...naked].filter((n) => n !== n.toLowerCase() || /[\s/]/.test(n));
    expect(inert, "these entries can never match a message").toEqual([]);
  });

  test("the commands that ship in the menu and rely on the allowlist are in it", () => {
    // Named one by one on purpose. These are the ones with no local handler:
    // their entire route to working is this list, so a silent removal from it
    // turns each into prose.
    for (const c of ["compact", "clear", "model", "status", "context", "help"]) {
      expect(naked.has(c), `/${c} has no local handler: without the allowlist it is prose`).toBe(true);
    }
  });
});

describe("the allowlist only holds commands the installed CLI has", () => {
  test("the fixture is plausible, or the checks below prove nothing", () => {
    expect(CLI.headless.length).toBeGreaterThan(30);
    expect(CLI.refused.length).toBeGreaterThan(15);
    // The aliases are what made the first version of this check wrong: `cost`
    // and `review` are not in `init.slash_commands`, and both work.
    expect(CLI.aliases.cost).toBe("usage");
    expect(CLI.aliases.review).toBe("code-review");
  });

  test("every `CLI_BUILTINS` name is run or refused by the CLI, never unknown to it", () => {
    // An unknown name sent naked is the worst of both: no context in front of
    // it, and the CLI hands it to the model as a paid turn. Measured on
    // todos, todo, install, migrate-installer, pr-comments and compress.
    const unknown = [...naked].filter((n) => !cliRuns.has(n) && !cliRefuses.has(n));
    expect(unknown, "not commands of the installed CLI: they reach the model naked, as prose").toEqual([]);
  });
});

describe("a name the CLI refuses headless is answered in the composer", () => {
  // CMD-06: «answered locally, saying so and naming what to use instead».
  test("every refused name has a branch in `ChatPane` or an entry in `CLI_REFUSED`", () => {
    const forwarded = CLI.refused.filter((n) => !handledBare(n) && !(n in CLI_REFUSED));
    expect(forwarded, "these reach a CLI that can only refuse them, in English, as the agent's reply").toEqual([]);
  });

  test("`CLI_REFUSED` only holds names the CLI refuses", () => {
    // A name the CLI can run must not be shadowed by a sentence saying it cannot.
    const runnable = Object.keys(CLI_REFUSED).filter((n) => !cliRefuses.has(n));
    expect(runnable).toEqual([]);
  });

  test("and `ChatPane` consults it", () => {
    expect(CHAT_PANE).toContain("cliRefusedCommand(");
  });

  test("the check can fail", () => {
    expect(handledBare("questo-comando-non-esiste")).toBe(false);
    expect("questo-comando-non-esiste" in CLI_REFUSED).toBe(false);
  });
});

describe("every menu entry does something when picked", () => {
  // The rows insert `cmd + ' '`; the send trims it. So what a pick sends is the
  // BARE command, and that is the form that needs a destination: a local
  // branch, or a CLI that runs it.
  test("each offered command works in its bare form", () => {
    const dead = offered.filter((c) => !handledBare(c) && !(naked.has(c) && cliRuns.has(c)));
    expect(dead, "picked from the menu, these reach the model as prose or a CLI refusal").toEqual([]);
  });

  test("the menu offers nothing the CLI refuses or has retired", () => {
    // `/resume` was offered as resuming an agent «@name» and the CLI refuses
    // it; `/agents` as listing agent profiles, and the CLI answers that the
    // wizard has been removed (AGENT-01: no roster exists).
    const pointless = offered.filter((c) => (cliRefuses.has(c) && !handledBare(c)) || c === "agents");
    expect(pointless).toEqual([]);
  });

  test("the bare check is stricter than the old one", () => {
    // The form with an argument, and a name quoted in a comment, used to count
    // as handling the bare command.
    const sample = "if (cmd.startsWith('/browser ')) {} // the menu's `/model` row";
    expect(handled("browser") || /['"`]\/browser['"` ]/.test(sample)).toBe(true);
    expect(bareIn(sample, "browser")).toBe(false);
    expect(bareIn(sample, "model")).toBe(false);
    expect(bareIn("if (cmd === '/browser') {}", "browser")).toBe(true);
  });
});

describe("`/new` and `/reset` are `/clear`", () => {
  // Claude Code's aliases of /clear (measured: each emits conversation_reset
  // and changes the session id). Forwarded, the live process forgot while the
  // screen kept the history and Topics kept the old session id.
  test("both reach the clear branch, behind the same confirmation", () => {
    for (const c of ["new", "reset"]) expect(handledBare(c), `/${c}`).toBe(true);
    expect(CLI.aliases.new).toBe("clear");
    expect(CLI.aliases.reset).toBe("clear");
  });
});
