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
 * @covers CMD-06
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const leggi = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CHAT_INPUT = leggi("client/src/components/Chat/ChatInput.tsx");
const CHAT_PANE = leggi("client/src/components/Chat/ChatPane.tsx");
const ADAPT = leggi("server/context/adapt.ts");

/** The commands the composer offers, from the `SLASH_COMMANDS` literal. */
const offerti: string[] = [...CHAT_INPUT.matchAll(/\{\s*cmd:\s*'\/([a-z-]+)'/g)].map((m) => m[1]!);

/** The names the server hands to the CLI untouched. */
const nudi: Set<string> = (() => {
  const inizio = ADAPT.indexOf("const CLI_BUILTINS");
  const fine = ADAPT.indexOf("]);", inizio);
  expect(inizio, "CLI_BUILTINS non e' piu' dove questo test lo cerca").toBeGreaterThan(-1);
  return new Set([...ADAPT.slice(inizio, fine).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
})();

/** Does `ChatPane` name this command anywhere it could act on it? */
const gestito = (c: string) => new RegExp(`['"\`]/${c}['"\` ]`).test(CHAT_PANE);

describe("the two lists are non-empty, or this file proves nothing", () => {
  // Both are read out of source with a regex. A rename that breaks either
  // pattern would leave an empty list, and an empty list passes every
  // assertion below while checking nothing at all.
  test("the composer offers a plausible number of commands", () => {
    expect(offerti.length).toBeGreaterThan(8);
    expect(new Set(offerti).size, "the same command offered twice").toBe(offerti.length);
  });

  test("the allowlist is a plausible size", () => {
    expect(nudi.size).toBeGreaterThan(20);
  });
});

describe("no menu entry leads nowhere", () => {
  test("each offered command is either handled here or passed naked to the CLI", () => {
    const orfani = offerti.filter((c) => !gestito(c) && !nudi.has(c));
    expect(
      orfani,
      "these are offered in the composer and go nowhere: picking one sends its text to the model as prose",
    ).toEqual([]);
  });

  test("and the check can actually fail", () => {
    // The non-vacuity half, stated as an assertion instead of trusted: a name
    // that is in neither list must be reported. Without this, a broken
    // `gestito` regex (one that matches everything) would make the test above
    // permanently green.
    const inventato = "questo-comando-non-esiste";
    expect(gestito(inventato)).toBe(false);
    expect(nudi.has(inventato)).toBe(false);
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
  test("the help text is built from the same array the menu uses", () => {
    const riga = CHAT_PANE.match(/const SLASH_COMMANDS_HELP\s*=\s*([^;]+);/)?.[1] ?? "";
    expect(riga, "`/help` is a hand-written list again").toContain("SLASH_COMMANDS.map");
    expect(CHAT_PANE, "`ChatPane` must import the menu, not copy it").toContain(
      "import { SLASH_COMMANDS } from './ChatInput'",
    );
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
    const inerti = [...nudi].filter((n) => n !== n.toLowerCase() || /[\s/]/.test(n));
    expect(inerti, "these entries can never match a message").toEqual([]);
  });

  test("the commands that ship in the menu and rely on the allowlist are in it", () => {
    // Named one by one on purpose. These are the ones with no local handler:
    // their entire route to working is this list, so a silent removal from it
    // turns each into prose.
    for (const c of ["compact", "clear", "model", "status", "context", "help"]) {
      expect(nudi.has(c), `/${c} has no local handler: without the allowlist it is prose`).toBe(true);
    }
  });
});
