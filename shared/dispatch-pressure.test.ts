/**
 * What is left of the "by resources" contract once the budget moved out: which
 * mode is in force, and the colour of a live reading against the budget.
 *
 * The brake itself (budget, admission, hysteresis, freeze order) is proved in
 * `shared/machine-budget.test.ts`, which is where it lives now. Two files
 * because they answer two questions: this one is about the SETTING as written
 * on the '*' row, that one about the DECISION taken from it.
 *
 * @covers KANBAN-75
 */
import { describe, expect, it } from "bun:test";
import { capMode, livePressureBand } from "./board";

describe("capMode: what is written and what applies", () => {
  it("nothing written means the default, and the default is by count", () => {
    expect(capMode({})).toBe("count");
    expect(capMode({ mode: "count" })).toBe("count");
  });

  it("an unknown mode does not switch the brake on by accident", () => {
    expect(capMode({ mode: "resource" as unknown as "resources" })).toBe("count");
  });

  it("the opt-in is explicit", () => {
    expect(capMode({ mode: "resources" })).toBe("resources");
  });
});

describe("the live reading takes its colour from the budget, not from an absolute", () => {
  it("green while there is room, amber on approach, red at the line", () => {
    expect(livePressureBand(2, 9.6)).toBe("green");
    expect(livePressureBand(7.5, 9.6)).toBe("amber");
    expect(livePressureBand(9.6, 9.6)).toBe("red");
  });

  it("a budget of zero cannot paint anything red: it means not measured", () => {
    expect(livePressureBand(5, 0)).toBe("green");
    expect(livePressureBand(Number.NaN, 9.6)).toBe("green");
  });
});
