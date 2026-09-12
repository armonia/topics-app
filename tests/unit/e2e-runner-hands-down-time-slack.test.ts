/**
 * The e2e bench decides the slack factor once and hands it down.
 *
 * `tests/helpers/time-slack.ts` reads `TOPICS_TEST_TIME_SLACK` once per
 * process, and Playwright's workers are forked from the runner: the env they
 * read is the one written in `globalSetup`. Only if somebody writes it, and for
 * months nobody did — grepping the env in `.github/workflows/ci.yml` returned
 * zero, and every e2e wait expired on a bare budget while the other two runners
 * had been measuring the factor for weeks.
 *
 * What is tested here is the FUNCTION, not the shape of a source file:
 * `handDownTimeSlack` takes the env and the machine as parameters, so "a runner
 * that just booted" and "a machine that is buried" are one line each. That the
 * fork really inherits the env was verified by running the suite (runner x3.0,
 * worker `TIME_SLACK=3`), and stays readable in the CI log — which is why the
 * line is printed every time.
 *
 * @covers E2E-GATE-11
 */
import { describe, it, expect } from "bun:test";
import { handDownTimeSlack } from "../e2e/helpers/time-slack-handoff";
import { TIME_SLACK_ENV } from "../../shared/test-time-slack";

describe("the e2e bench hands the slack factor down", () => {
  it("writes the measured factor into the env the workers will inherit", () => {
    const env: Record<string, string | undefined> = {};
    const { slack } = handDownTimeSlack(env, { load: 12, cores: 4 });
    expect(slack).toBe(4);
    expect(env[TIME_SLACK_ENV]).toBe("4");
  });

  it("widens nothing on a quiet machine, and writes it down all the same", () => {
    // The freshly booted runner: the factor is 1, i.e. the lever does not
    // engage. Writing it anyway is what lets the log say so.
    const env: Record<string, string | undefined> = {};
    const { slack, note } = handDownTimeSlack(env, { load: 0.4, cores: 4 });
    expect(slack).toBe(1);
    expect(env[TIME_SLACK_ENV]).toBe("1");
    expect(note).toContain("x1.0");
  });

  it("a value forced by hand beats the measurement", () => {
    const env: Record<string, string | undefined> = { [TIME_SLACK_ENV]: "3" };
    expect(handDownTimeSlack(env, { load: 40, cores: 4 }).slack).toBe(3);
    expect(env[TIME_SLACK_ENV]).toBe("3");
  });

  it("the line to print carries the number AND the measure behind it", () => {
    // Without the load next to it, an "x1.0" does not tell a quiet machine
    // apart from a probe that read nothing.
    expect(handDownTimeSlack({}, { load: 6, cores: 12 }).note).toBe("time slack x1.0, load 6.0/12");
  });

  it("global-setup calls it, and calls it after seeding", async () => {
    // The one thing that stays static: WHERE the call sits. Measuring at the
    // top of the process is the defect that made the lever fake, and there is
    // no way to prove that from inside the function.
    const src = await Bun.file(new URL("../e2e/global-setup.ts", import.meta.url)).text();
    const call = src.indexOf("handDownTimeSlack()");
    const seeding = src.indexOf("Could not seed baseline data");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(seeding);
  });
});
