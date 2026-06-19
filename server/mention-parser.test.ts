import { describe, expect, it } from "bun:test";
import { parseMentions } from "./mention-parser";

describe("parseMentions", () => {
  it("parses a bare @agent into an agent mention", () => {
    expect(parseMentions("@scout")).toEqual([
      { entity: "scout", entityType: "agent" },
    ]);
  });

  it("parses @all into an 'all' mention (case-insensitive)", () => {
    expect(parseMentions("@all")).toEqual([
      { entity: "all", entityType: "all" },
    ]);
    expect(parseMentions("@ALL")).toEqual([
      { entity: "all", entityType: "all" },
    ]);
  });

  it("does not treat an email address as a mention", () => {
    expect(parseMentions("ping user@example.com when ready")).toEqual([]);
    expect(parseMentions("contact a.b+tag@host.io")).toEqual([]);
  });

  it("matches a mention mid-sentence after whitespace", () => {
    expect(parseMentions("hey @scout can you check this")).toEqual([
      { entity: "scout", entityType: "agent" },
    ]);
  });

  it("matches a mention at the start of a line in multiline text", () => {
    expect(parseMentions("first line\n@scout second line")).toEqual([
      { entity: "scout", entityType: "agent" },
    ]);
  });

  it("dedups repeated mentions (case-insensitively)", () => {
    expect(parseMentions("@scout @scout @Scout")).toEqual([
      { entity: "scout", entityType: "agent" },
    ]);
  });

  it("allows underscores and hyphens in agent names", () => {
    expect(parseMentions("@my_agent-2 please run")).toEqual([
      { entity: "my_agent-2", entityType: "agent" },
    ]);
  });
});
