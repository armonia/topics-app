import { describe, it, expect } from "bun:test";
import { resolveOsOpenPath, type OsOpenProbe } from "./os-open-path";

/**
 * Un disco finto descritto in due righe: le cartelle, i file, i marcatori.
 * Il vero `statSync` qui non aggiungerebbe niente e toglierebbe la possibilità
 * di provare un monorepo senza crearlo davvero.
 */
function probe(spec: {
  dirs?: string[];
  files?: string[];
  markers?: Record<string, string[]>;
  known?: string[];
}): OsOpenProbe {
  const dirs = new Set(spec.dirs ?? []);
  const files = new Set(spec.files ?? []);
  return {
    kindOf: (p) => (dirs.has(p) ? "dir" : files.has(p) ? "file" : null),
    hasMarker: (dir, marker) => (spec.markers?.[dir] ?? []).includes(marker),
    knownProjects: () => spec.known ?? [],
  };
}

describe("resolveOsOpenPath", () => {
  it("una cartella diventa una tab di progetto", () => {
    const p = probe({ dirs: ["/w/app"] });
    expect(resolveOsOpenPath("/w/app", p)).toEqual({ kind: "project", key: "/w/app" });
  });

  it("un file apre il repository che lo contiene, col file a fuoco", () => {
    const p = probe({
      files: ["/w/app/src/index.ts"],
      markers: { "/w/app": [".git", "package.json"] },
    });
    expect(resolveOsOpenPath("/w/app/src/index.ts", p)).toEqual({
      kind: "file",
      key: "/w/app/src/index.ts",
      projectPath: "/w/app",
    });
  });

  it("dentro un monorepo vince la radice col .git, non il pacchetto", () => {
    const p = probe({
      files: ["/w/mono/packages/ui/src/a.ts"],
      markers: {
        "/w/mono": [".git"],
        "/w/mono/packages/ui": ["package.json"],
      },
    });
    expect(resolveOsOpenPath("/w/mono/packages/ui/src/a.ts", p)).toMatchObject({
      projectPath: "/w/mono",
    });
  });

  it("un progetto già aperto vince sui marcatori: niente doppioni", () => {
    const p = probe({
      files: ["/w/mono/packages/ui/src/a.ts"],
      markers: { "/w/mono/packages/ui": ["package.json"] },
      known: ["/w/mono/packages/ui", "/w/altro"],
    });
    expect(resolveOsOpenPath("/w/mono/packages/ui/src/a.ts", p)).toMatchObject({
      projectPath: "/w/mono/packages/ui",
    });
  });

  it("un file sciolto apre la cartella che lo contiene", () => {
    const p = probe({ files: ["/tmp/note.md"] });
    expect(resolveOsOpenPath("/tmp/note.md", p)).toMatchObject({ projectPath: "/tmp" });
  });

  it("il file:// del Finder passa dalla stessa porta", () => {
    const p = probe({ dirs: ["/w/il mio progetto"] });
    expect(resolveOsOpenPath("file:///w/il%20mio%20progetto", p)).toEqual({
      kind: "project",
      key: "/w/il mio progetto",
    });
  });

  it("un path che non esiste non apre niente", () => {
    expect(resolveOsOpenPath("/w/mai-esistito", probe({}))).toBeNull();
  });

  it("un path relativo non apre niente", () => {
    expect(resolveOsOpenPath("src/a.ts", probe({ files: ["src/a.ts"] }))).toBeNull();
  });

  it("smette di risalire dopo un tetto di antenati", () => {
    const deep = `/w${"/n".repeat(20)}/a.ts`;
    const asked: string[] = [];
    const p: OsOpenProbe = {
      kindOf: (x) => (x === deep ? "file" : null),
      hasMarker: (dir) => {
        asked.push(dir);
        return false;
      },
      knownProjects: () => [],
    };
    resolveOsOpenPath(deep, p);
    expect(new Set(asked).size).toBeLessThanOrEqual(12);
  });
});
