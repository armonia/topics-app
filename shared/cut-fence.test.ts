/**
 * The fence a reply leaves open, and whether a command is its text.
 * @covers CHAT-RUN-01, CMDRUN-05
 */
import { describe, expect, test } from "bun:test";
import { cutFenceBody, isCommandCut } from "./cut-fence";

describe("cutFenceBody", () => {
  test("every fence closed: null", () => {
    expect(cutFenceBody("```bash\nls\n```")).toBeNull();
    expect(cutFenceBody("~~~sh\nls\n~~~\ntext")).toBeNull();
    expect(cutFenceBody("plain text, `inline` and ```inline```")).toBeNull();
    expect(cutFenceBody("")).toBeNull();
  });

  test("the last fence open: its body", () => {
    expect(cutFenceBody("Pulisco:\n```bash\nrm -rf ./")).toBe("rm -rf ./");
    expect(cutFenceBody("```bash\nls\n```\n```bash\ncd x\nmake")).toBe("cd x\nmake");
    expect(cutFenceBody("```bash\r\nrm -rf ./")).toBe("rm -rf ./");
  });

  test("a close must match the opening: same character, at least as long, nothing after it", () => {
    expect(cutFenceBody("````bash\nls\n```")).toBe("ls\n```");
    expect(cutFenceBody("~~~bash\nls\n```")).toBe("ls\n```");
    expect(cutFenceBody("```bash\nls\n```js")).toBe("ls\n```js");
    expect(cutFenceBody("```bash\nls\n````")).toBeNull();
  });

  test("inside a blockquote or a list item", () => {
    expect(cutFenceBody("> ```bash\n> rm -rf ./")).toBe("> rm -rf ./");
    expect(cutFenceBody("> ```bash\n> ls\n> ```")).toBeNull();
    expect(cutFenceBody("1. Run:\n   ```bash\n   ls\n   ```")).toBeNull();
  });
});

describe("isCommandCut", () => {
  test("the text of the open fence is cut, a command the reply closed is not", () => {
    const reply = "```bash\necho whole\n```\nPoi:\n```bash\nrm -rf ./";
    expect(isCommandCut("rm -rf ./", [reply])).toBe(true);
    expect(isCommandCut("echo whole", [reply])).toBe(false);
    expect(isCommandCut("echo whole", ["```bash\necho whole\n```"])).toBe(false);
  });

  test("any of the reply's texts, as a console transcript or in a blockquote", () => {
    expect(isCommandCut("git push origin fea", ["Avvio:", "```console\n$ git push origin fea"])).toBe(true);
    expect(isCommandCut("rm -rf ./", ["> ```bash\n> rm -rf ./"])).toBe(true);
    expect(isCommandCut("cd x\nmake", ["```bash\ncd x\nmake"])).toBe(true);
  });

  test("an empty command or no texts: not cut", () => {
    expect(isCommandCut("  ", ["```bash\nls"])).toBe(false);
    expect(isCommandCut("ls", [])).toBe(false);
  });
});
