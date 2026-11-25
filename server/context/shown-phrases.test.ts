/**
 * The words given to the agent about showing things (SHOWN-04).
 *
 * @covers SHOWN-04
 */
import { describe, expect, test } from "bun:test";
import { browserInstructionContent } from "./assemble";
import { TOOLS } from "../mcp/tool-catalog";

const openPane = TOOLS.find((t) => t.name === "open_browser_pane")!.description;

describe("SHOWN-04 phrases", () => {
  test.each([
    ["the context", browserInstructionContent()],
    ["the tool description", openPane],
  ])("%s: leaving it in the message comes first, the panel is extra", (_name, text) => {
    expect(text).toContain("left in your message");
    expect(text).toContain("~/.topics/media");
    expect(text).toContain("plain path");
    expect(text).toContain("point at the preview in your message");
    expect(text).not.toContain("Do not mention the tool to the user");
    expect(text).not.toContain("The pane appears next to the current chat");
  });
});
