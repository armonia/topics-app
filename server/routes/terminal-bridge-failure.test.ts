/**
 * When the terminal does not open, the error has to name the reason.
 *
 * THE DEFECT THAT PRODUCED THIS FILE, measured 2026-08-25 on the nightly E2E
 * run: shard 3 failed with
 *
 *   [Terminal] Bridge init failed: Failed to connect to PTY bridge after
 *   spawning (node --socket /tmp/topics-pty-bridge-e2e-13334.sock)
 *   Nessun log in /tmp/topics-pty-bridge-e2e-13334.log.
 *
 * and that last sentence was a lie by construction. It reads as "the bridge
 * started and said nothing", which is one specific fact; but the code emitted
 * it for THREE different situations, only one of which it described:
 *
 *   - the spawn itself failed (ENOENT, EACCES): nothing was ever born, so of
 *     course there is no log. Nobody was listening for the `error` event, so
 *     this case was invisible;
 *   - the log could not be OPENED, so `stdio` fell back to `'ignore'` and the
 *     bridge's stderr was discarded. The bridge may well have said why it
 *     died. We threw the answer away and then reported that none was given;
 *   - the bridge really did start and die quietly. The only true case.
 *
 * Three causes wearing one sentence is worse than no sentence: it does not
 * just fail to help, it sends the reader to the wrong place. Every one of
 * those investigations starts by looking for a bridge process that, in two
 * cases out of three, never existed.
 *
 * WHY THE ORDER OF THE CASES IS ITSELF UNDER TEST. The log file is
 * append-only and outlives the process that wrote it. A bridge that fails to
 * spawn today, in a directory where a bridge died yesterday, would be
 * explained by yesterday's last line if the log were consulted first. That is
 * not a hypothetical: the log path is derived from the socket path, so a test
 * instance reuses the same file run after run.
 *
 * @covers TERM-03
 */
import { describe, expect, test } from "bun:test";
import { bridgeFailureDetail } from "./terminal";

const LOG = "/tmp/topics-pty-bridge-e2e-13334.log";

describe("each cause gets its own sentence", () => {
  test("the spawn failed: it says so, and names the errno", () => {
    const d = bridgeFailureDetail({ spawnError: "spawn node ENOENT", logPath: LOG });
    expect(d).toContain("ENOENT");
    // The point of the fix: this case used to be reported as an absent log.
    expect(d, "a bridge that was never born is not a bridge that stayed quiet").not.toContain("Nessun log");
  });

  test("the bridge spoke: its own words are carried through", () => {
    const d = bridgeFailureDetail({
      logLine: "Self-test failed: posix_spawnp failed.",
      logPath: LOG,
    });
    expect(d).toContain("posix_spawnp");
  });

  test("we were not listening: it admits the stderr was discarded", () => {
    const d = bridgeFailureDetail({
      logOpenError: "EACCES: permission denied, open '/tmp/topics-pty-bridge-e2e-13334.log'",
      logPath: LOG,
    });
    expect(d).toContain("EACCES");
    // The distinction the old message erased. "We threw the answer away" and
    // "there was no answer" send you to two different places.
    expect(d).toContain("scartato");
    expect(d).not.toContain("Nessun log");
  });

  test("nothing to go on: it says that, and only that", () => {
    const d = bridgeFailureDetail({ logPath: LOG });
    expect(d).toContain("Nessun log");
    expect(d, "the path is what makes the sentence actionable").toContain(LOG);
  });
});

describe("the order, when more than one is true at once", () => {
  // These are not exotic combinations. A failed spawn in a directory where a
  // previous bridge died leaves BOTH a spawn error and a stale log line, and
  // that is the exact shape of a broken install being retried.
  test("a failed spawn beats a line left in the log by an earlier bridge", () => {
    const d = bridgeFailureDetail({
      spawnError: "spawn /usr/local/bin/pty-bridge EACCES",
      logLine: "Self-test failed: posix_spawnp failed.",
      logPath: LOG,
    });
    expect(d).toContain("EACCES");
    expect(
      d,
      "yesterday's death would explain today's failure, and send the reader to a process that never started",
    ).not.toContain("posix_spawnp");
  });

  test("a line that was actually read beats the fact that opening it later failed", () => {
    const d = bridgeFailureDetail({
      logLine: "bridge: address already in use",
      logOpenError: "EMFILE: too many open files",
      logPath: LOG,
    });
    expect(d).toContain("address already in use");
  });
});

describe("the sentence is a sentence", () => {
  test("every case leads with a space, and carries the thing it was given", () => {
    // It is concatenated onto "Failed to connect to PTY bridge after spawning
    // (...)" with no separator, so a missing leading space glues two words
    // together. And a branch that drops its own input reads as a reason while
    // saying nothing: that is the bug this whole file exists about, so it is
    // asserted for every branch rather than only for the ones above.
    const casi: [string, string][] = [
      [bridgeFailureDetail({ spawnError: "ENOSPAWN", logPath: LOG }), "ENOSPAWN"],
      [bridgeFailureDetail({ logLine: "IL-MOTIVO", logPath: LOG }), "IL-MOTIVO"],
      [bridgeFailureDetail({ logOpenError: "NONAPRIBILE", logPath: LOG }), "NONAPRIBILE"],
      [bridgeFailureDetail({ logPath: LOG }), LOG],
    ];
    for (const [c, deveContenere] of casi) {
      expect(c.startsWith(" "), `«${c}» would glue itself onto the previous word`).toBe(true);
      expect(c, `«${c}» reads like a reason and does not carry one`).toContain(deveContenere);
    }
  });

  test("an empty string is not a reason", () => {
    // `lastBridgeLogLine` returns "" for a log whose last line is blank, and
    // `""` is falsy - so this must fall through to the no-log case rather
    // than reporting that the bridge said nothing at all, twice.
    const d = bridgeFailureDetail({ spawnError: "", logLine: "", logOpenError: "", logPath: LOG });
    expect(d).toContain("Nessun log");
  });
});
