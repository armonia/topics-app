/**
 * @covers READABLE-02
 */
import { describe, expect, test } from "bun:test";
import { toolPhrase } from "./tool-phrase";

describe("toolPhrase — a readable sentence + icon category instead of 'server · tool'", () => {
  test("a known Topics bridge tool reads as a sentence naming its card", () => {
    expect(toolPhrase("mcp__topics__list_tasks", "list_tasks", {})).toEqual({ text: "Elenca le card", category: "read" });
  });

  test("a known tool with a task id shortens it, like the rest of the chat", () => {
    expect(toolPhrase("mcp__topics__label_task", "label_task", { task_id: "458c16a6-d9d5-4fc1-8ea6-61a1b83f69cf" }))
      .toEqual({ text: "Etichetta la card 458c16a6", category: "write" });
  });

  test("an unknown MCP tool whose name reads as a lookup is 'search'", () => {
    expect(toolPhrase("mcp__acme__resolve_library_id", "resolve_library_id", {})).toEqual({ text: "Resolve library id", category: "search" });
  });

  test("a get_* or *_get name is a read with a sentence and the read icon", () => {
    expect(toolPhrase("mcp__topics__task_get", "task_get", { task_id: "45ea106d-1111" })).toEqual({ text: "Legge la card 45ea106d", category: "read" });
    expect(toolPhrase("mcp__ops__get_status", "get_status", { project: "topics" })).toEqual({ text: "Legge lo stato di topics", category: "read" });
    expect(toolPhrase("mcp__ops__list_servers", "list_servers", {}).category).toBe("read");
  });

  test("an unknown MCP tool falls back to its action category and a humanized name", () => {
    expect(toolPhrase("mcp__acme__write_file", "write_file", {})).toEqual({ text: "Write file", category: "write" });
    expect(toolPhrase("mcp__acme__fetch_url", "fetch_url", {})).toEqual({ text: "Fetch url", category: "network" });
  });

  test("a truly opaque tool name still gets a readable humanization and a category", () => {
    expect(toolPhrase("mcp__acme__doSomethingWeird", "doSomethingWeird", {})).toEqual({ text: "Do something weird", category: "other" });
  });
});
