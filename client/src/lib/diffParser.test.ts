/**
 * Parsing the diff blocks out of an assistant message so they can render as
 * apply/reject cards instead of as prose.
 *
 * @covers CHAT-02
 */
import { describe, expect, it } from "bun:test";
import { parseMessageWithDiffs } from "./diffParser";

const block = (path: string) =>
  `${path}\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE`;

describe("parseMessageWithDiffs", () => {
  it("parses a normal file with an extension", () => {
    const segs = parseMessageWithDiffs(block("src/foo.ts"));
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("diff");
    expect(segs[0].edit).toEqual({ filePath: "src/foo.ts", searchText: "old", replaceText: "new" });
  });

  it("parses extensionless files (Dockerfile, Makefile, .gitignore, LICENSE)", () => {
    for (const path of ["Dockerfile", "Makefile", ".gitignore", "LICENSE", "path/to/.env"]) {
      const segs = parseMessageWithDiffs(block(path));
      expect(segs).toHaveLength(1);
      expect(segs[0].type).toBe("diff");
      expect(segs[0].edit?.filePath).toBe(path);
    }
  });

  it("keeps surrounding prose as text segments", () => {
    const segs = parseMessageWithDiffs(`before\n${block("Dockerfile")}\nafter`);
    expect(segs.map((s) => s.type)).toEqual(["text", "diff", "text"]);
    expect(segs[0].content).toBe("before");
    expect(segs[2].content).toBe("after");
  });

  it("returns a single text segment when there is no diff block", () => {
    const segs = parseMessageWithDiffs("just some prose, no edits");
    expect(segs).toEqual([{ type: "text", content: "just some prose, no edits" }]);
  });
});
