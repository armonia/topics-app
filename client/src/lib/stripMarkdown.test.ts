/**
 * @covers STRIPMD-01
 */
import { describe, it, expect } from "bun:test";
import { stripMarkdown } from "./stripMarkdown";

describe("stripMarkdown", () => {
  it("drops heading markers", () => {
    expect(stripMarkdown("# Piano")).toBe("Piano");
    expect(stripMarkdown("### Sotto-piano")).toBe("Sotto-piano");
  });

  it("drops bold/italic/strikethrough markers, keeps the words", () => {
    expect(stripMarkdown("**Piano**")).toBe("Piano");
    expect(stripMarkdown("_corsivo_ e *anche*")).toBe("corsivo e anche");
    expect(stripMarkdown("~~fatto~~")).toBe("fatto");
  });

  it("unwraps links and images to their text/alt", () => {
    expect(stripMarkdown("vedi [la board](https://x/y)")).toBe("vedi la board");
    expect(stripMarkdown("![diagramma](/img.png)")).toBe("diagramma");
  });

  it("strips list and blockquote markers per line", () => {
    expect(stripMarkdown("- primo\n- secondo")).toBe("primo\nsecondo");
    expect(stripMarkdown("1. uno\n2. due")).toBe("uno\ndue");
    expect(stripMarkdown("> citazione")).toBe("citazione");
  });

  it("removes code fences but keeps inline code content", () => {
    expect(stripMarkdown("```ts\nconst x = 1\n```")).toBe("const x = 1");
    expect(stripMarkdown("usa `filtro` qui")).toBe("usa filtro qui");
  });

  it("handles a realistic plan preview", () => {
    const plan = "# Piano\n\n**Obiettivo:** aggiungere i filtri.\n\n1. `FilterBar` component\n2. wire allo store\n\n> nota: riusa useBoard";
    expect(stripMarkdown(plan)).toBe(
      "Piano\n\nObiettivo: aggiungere i filtri.\n\nFilterBar component\nwire allo store\n\nnota: riusa useBoard",
    );
  });

  it("is a no-op on plain text and empty input", () => {
    expect(stripMarkdown("solo testo normale")).toBe("solo testo normale");
    expect(stripMarkdown("")).toBe("");
  });
});
