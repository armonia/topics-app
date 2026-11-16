/**
 * @covers GATE-02
 */
import { expect, test } from "bun:test";
import { hasCheckMutation, main } from "./check-mutation";

const fake = (help: string, status = 0) => {
  const calls: string[][] = [];
  const run = ((_bin: string, args: string[]) => {
    calls.push(args);
    return args[0] === "--help" ? { stdout: help, stderr: "", status: 0 } : { status };
  }) as never;
  return { run, calls };
};

test("help of spec-flow 0.3.x has no check-mutation, 0.4.0 has it", () => {
  expect(hasCheckMutation("  lint-mutants   mutazioni contro il lint\n")).toBe(false);
  expect(hasCheckMutation("  check-mutation   ratchet D9\n")).toBe(true);
});

test("without the command the ratchet warns and passes", () => {
  const { run, calls } = fake("  lint-mutants  x\n");
  expect(main([], run)).toBe(0);
  expect(calls).toEqual([["--help"]]);
});

test("with the command its exit code is the verdict, args passed through", () => {
  const { run, calls } = fake("  check-mutation  x\n", 1);
  expect(main(["--update-baseline"], run)).toBe(1);
  expect(calls[1]).toEqual(["check-mutation", "--update-baseline"]);
});
