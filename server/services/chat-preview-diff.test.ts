/**
 * Which changed files count as interface files for the chat preview.
 *
 * @covers KANBAN-23
 */
import { describe, it, expect } from "bun:test";
import { isInterfaceFile } from "./chat-preview-diff";

describe("isInterfaceFile", () => {
  it("accepts markup, style and component files", () => {
    for (const p of ["src/App.tsx", "a/b.vue", "x.svelte", "styles/main.scss", "index.html"]) expect(isInterfaceFile(p)).toBe(true);
  });

  it("accepts scripts and assets only inside an interface folder", () => {
    expect(isInterfaceFile("client/src/lib/net.ts")).toBe(true);
    expect(isInterfaceFile("public/logo.svg")).toBe(true);
    expect(isInterfaceFile("server/services/net.ts")).toBe(false);
  });

  it("rejects tests, docs and dependencies even under an interface folder", () => {
    for (const p of ["client/src/App.test.tsx", "client/src/a.spec.ts", "docs/guide.html", "README.md", "tests/e2e/a.tsx", "node_modules/x/y.css"]) expect(isInterfaceFile(p)).toBe(false);
  });

  it("normalizes Windows separators and ignores blanks", () => {
    expect(isInterfaceFile(String.raw`client\src\lib\net.ts`)).toBe(true);
    expect(isInterfaceFile("   ")).toBe(false);
  });
});
