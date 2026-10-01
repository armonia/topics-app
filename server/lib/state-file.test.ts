/**
 * @covers CMDRUN-04
 */
/** Reading back a state file: a missing one is a quiet empty start, a corrupt
 *  one is logged once and kept aside instead of dropped. */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonStateFile } from "./state-file";

const dir = mkdtempSync(join(tmpdir(), "state-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const error = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => error.mockClear());
afterAll(() => error.mockRestore());

const aside = (name: string) => readdirSync(dir).filter(n => n.startsWith(`${name}.corrupt-`));

test("a missing file is the normal empty start: null, nothing logged", () => {
  expect(readJsonStateFile(join(dir, "none.json"), "t")).toBeNull();
  expect(error).not.toHaveBeenCalled();
});

test("a good file is returned as parsed and stays where it is", () => {
  const f = join(dir, "good.json");
  writeFileSync(f, '{"running":[],"recent":[]}');
  expect(readJsonStateFile(f, "t")).toEqual({ running: [], recent: [] });
  expect(readFileSync(f, "utf8")).toBe('{"running":[],"recent":[]}');
  expect(error).not.toHaveBeenCalled();
});

test("a torn file is logged once and kept aside with its bytes", () => {
  const f = join(dir, "torn.json");
  writeFileSync(f, '{"running":[{"proc');
  expect(readJsonStateFile(f, "processes")).toBeNull();
  expect(aside("torn.json")).toHaveLength(1);
  expect(readFileSync(join(dir, aside("torn.json")[0]!), "utf8")).toBe('{"running":[{"proc');
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]![0])).toContain("[processes]");
  expect(String(error.mock.calls[0]![0])).toContain(`Kept as ${join(dir, aside("torn.json")[0]!)}`);
});

test("a file that parses to something other than an object is set aside too", () => {
  const f = join(dir, "empty.json");
  writeFileSync(f, "null");
  expect(readJsonStateFile(f, "t")).toBeNull();
  expect(aside("empty.json")).toHaveLength(1);
  expect(error).toHaveBeenCalledTimes(1);
});
