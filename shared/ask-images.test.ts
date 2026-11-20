/**
 * @covers ASK-01
 *
 * The picture references a question carries (a path, a file URL, a media
 * link) resolve to the file they point at, so the panel can show it.
 */
import { describe, expect, test } from "bun:test";
import { askImagePath, questionImageRefs } from "./ask-images";

describe("askImagePath", () => {
  test("a plain path stays", () => expect(askImagePath(" /m/a b.png ")).toBe("/m/a b.png"));
  test("a file URL becomes its path, drive letter included", () => {
    expect(askImagePath("file:///m/a%20b.png")).toBe("/m/a b.png");
    expect(askImagePath("file:///C:/m/a.png")).toBe("C:/m/a.png");
  });
  test("a media link becomes the file it serves", () => {
    expect(askImagePath("http://127.0.0.1:3333/api/media?path=%2Fm%2Fa%20b.png")).toBe("/m/a b.png");
    expect(askImagePath("/api/media?x=1&path=%2Fm%2Fa.png")).toBe("/m/a.png");
  });
});

describe("questionImageRefs", () => {
  test("question pictures first, then the options', no repeats", () => {
    expect(questionImageRefs([{ images: ["a", "b"], options: [{ image: "b" }, { image: "c" }, {}, "plain"] }, { options: [{ image: "a" }] }])).toEqual(["a", "b", "c"]);
  });
});
