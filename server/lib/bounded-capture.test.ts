/**
 * THE TIMEOUT IS A DEADLINE ON THE ANSWER, AND THE TEST IS A CLOCK.
 *
 * The old shape - spawn, `setTimeout(() => proc.kill())`, `await` the output -
 * looks like a timeout and is not one: the kill is a SIGTERM, and the await sits
 * on the pipe until EOF. A child that ignores the signal (measured: 6145 ms for
 * a `timeoutMs` of 1000) keeps the caller waiting, and the caller here is the
 * swap freezer's beat, which holds a latch for its whole duration and is the
 * only place the ten minute thaw cap is ever evaluated. An unbounded probe is
 * therefore a tree stopped for the life of the server.
 *
 * The child below is our own (`trap "" TERM`), so the SIGTERM at the deadline is
 * ignored on purpose: that is exactly the production shape - `lsof` stat-ing a
 * dead mount - and the assertion is on the CLOCK, not on the exit code.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { captureWithDeadline } from "./bounded-capture";

describe("captureWithDeadline", () => {
  test("an answer that arrives is returned whole, with its exit code", async () => {
    const capture = await captureWithDeadline(["/bin/bash", "-c", "echo ghiaccio; exit 3"], 5_000);
    expect(capture?.text.trim()).toBe("ghiaccio");
    expect(capture?.exitCode).toBe(3);
  });

  test("a child that ignores the SIGTERM does not hold the caller past the deadline", async () => {
    const started = Date.now();
    const capture = await captureWithDeadline(["/bin/bash", "-c", 'trap "" TERM; echo vivo; /bin/sleep 2'], 250);
    const elapsed = Date.now() - started;
    expect(capture, "a probe that did not answer is null, never its half-written output").toBeNull();
    expect(elapsed, "the deadline was waited for, not skipped by an error").toBeGreaterThanOrEqual(200);
    expect(elapsed, "the await used to last as long as the child, not as long as the deadline").toBeLessThan(1_200);
  });

  test("a binary that is not there is `null`, not a throw", async () => {
    expect(await captureWithDeadline(["/bin/nessun-binario-qui"], 1_000)).toBeNull();
  });
});
