/**
 * The factor that widens a test's time window, and the two ways it is decided.
 *
 * The arithmetic is here and nowhere else, so a window written for a quiet
 * machine survives a loaded one without anybody editing constants by hand (see
 * the file it tests for the measurement that made it necessary).
 *
 * @covers KANBAN-15
 */
import { describe, test, expect } from "bun:test";
import {
  MAX_TIME_SLACK,
  TIME_SLACK_ENV,
  parseForcedSlack,
  timeSlack,
  timeSlackNote,
} from "./test-time-slack";

describe("time slack · what the load buys", () => {
  test("an idle machine changes nothing: the factor is exactly 1", () => {
    expect(timeSlack({ load: 0, cores: 12 })).toBe(1);
  });

  test("half a core busy each is still 1: no widening below pressure 0.5", () => {
    expect(timeSlack({ load: 5, cores: 12 })).toBe(1);
  });

  test("one busy core per core doubles the window", () => {
    expect(timeSlack({ load: 12, cores: 12 })).toBe(2);
  });

  test("the factor follows the pressure in between", () => {
    // load 11 on 12 cores: the machine of card 0f4cbccb on 2026-09-07.
    expect(timeSlack({ load: 11, cores: 12 })).toBe(1.8);
  });

  test("three times the cores hits the ceiling and stops there", () => {
    expect(timeSlack({ load: 36, cores: 12 })).toBe(MAX_TIME_SLACK);
    expect(timeSlack({ load: 500, cores: 12 })).toBe(MAX_TIME_SLACK);
  });

  test("a machine with no cores to speak of is read as one, not as a division by zero", () => {
    expect(timeSlack({ load: 2, cores: 0 })).toBe(MAX_TIME_SLACK);
    expect(Number.isFinite(timeSlack({ load: 0, cores: 0 }))).toBe(true);
  });
});

describe("time slack · the env wins", () => {
  test("a forced factor beats the measurement, in both directions", () => {
    expect(timeSlack({ load: 36, cores: 12, forced: "1" })).toBe(1);
    expect(timeSlack({ load: 0, cores: 12, forced: "3" })).toBe(3);
  });

  test("a forced factor is clamped like any other", () => {
    expect(timeSlack({ load: 0, cores: 12, forced: "99" })).toBe(MAX_TIME_SLACK);
    expect(timeSlack({ load: 0, cores: 12, forced: 0.2 })).toBe(1);
  });

  test("an unreadable env is not an instruction: the measurement is used", () => {
    for (const raw of ["", "   ", "yes", "0", "-2", undefined, null]) {
      expect(parseForcedSlack(raw as string | undefined)).toBe(null);
    }
    expect(timeSlack({ load: 12, cores: 12, forced: "" })).toBe(2);
  });

  test("the env has one name, and the runners and the tests read that one", () => {
    expect(TIME_SLACK_ENV).toBe("TOPICS_TEST_TIME_SLACK");
  });
});

describe("time slack · what the runner prints", () => {
  test("one line, the factor and the load that produced it", () => {
    expect(timeSlackNote(2.3, 11.2, 12)).toBe("time slack x2.3, load 11.2/12");
  });
});
