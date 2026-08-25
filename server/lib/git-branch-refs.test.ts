/**
 * Le righe di prova non sono inventate: sono l'output letterale di
 * `git branch -a --format=…` su un clone con DUE remote (`origin` e
 * `upstream`), catturato mentre si cercava perché cliccare un ramo remoto
 * staccasse HEAD. È il caso che nessuno prova a mano.
 *
 * This parse is where the branch indicator, its upstream and the name a
 * switch is performed with come from.
 *
 * @covers FILE-02
 */
import { test, expect } from "bun:test";
import { parseBranchLine, parseBranchLines } from "./git-branch-refs";

const REAL_OUTPUT = [
  "refs/heads/feat|feat|*|origin/feat",
  "refs/heads/main|main| |origin/main",
  "refs/remotes/origin/HEAD|origin| |",
  "refs/remotes/origin/feat|origin/feat| |",
  "refs/remotes/origin/main|origin/main| |",
  "refs/remotes/upstream/HEAD|upstream| |",
  "refs/remotes/upstream/feat|upstream/feat| |",
  "refs/remotes/upstream/main|upstream/main| |",
].join("\n");

test("il puntatore …/HEAD non è un ramo e sparisce, per OGNI remote", () => {
  const refs = parseBranchLines(REAL_OUTPUT);
  // Il nome corto di `refs/remotes/origin/HEAD` è `origin`: scartarlo
  // confrontando `name === "origin/HEAD"` non scartava niente.
  expect(refs.map(r => r.name)).not.toContain("origin");
  expect(refs.map(r => r.name)).not.toContain("upstream");
  expect(refs).toHaveLength(6);
});

test("un remote che non si chiama origin resta un REMOTO", () => {
  const refs = parseBranchLines(REAL_OUTPUT);
  const up = refs.find(r => r.name === "upstream/feat")!;
  expect(up.isRemote).toBe(true);
  expect(up.remote).toBe("upstream");
  // Il vecchio `name.startsWith("origin/")` lo dava per locale.
  const locals = refs.filter(r => !r.isRemote).map(r => r.name);
  expect(locals.sort()).toEqual(["feat", "main"]);
});

test("shortName è il nome su cui si fa switch, senza il remote", () => {
  const refs = parseBranchLines(REAL_OUTPUT);
  expect(refs.find(r => r.name === "origin/feat")!.shortName).toBe("feat");
  expect(refs.find(r => r.name === "upstream/main")!.shortName).toBe("main");
  // È questo il valore che evita `git switch origin/feat`, cioè HEAD staccato.
  expect(refs.find(r => r.name === "origin/feat")!.name).not.toBe(
    refs.find(r => r.name === "origin/feat")!.shortName,
  );
});

test("un ramo con lo slash dentro non viene tagliato al posto sbagliato", () => {
  const ref = parseBranchLine("refs/remotes/origin/topics/gruppi-spazi|origin/topics/gruppi-spazi| |")!;
  expect(ref.remote).toBe("origin");
  expect(ref.shortName).toBe("topics/gruppi-spazi");
});

test("il ramo corrente e il suo upstream", () => {
  const refs = parseBranchLines(REAL_OUTPUT);
  const current = refs.filter(r => r.current);
  expect(current).toHaveLength(1);
  expect(current[0].name).toBe("feat");
  expect(current[0].upstream).toBe("origin/feat");
  // I remoti non portano upstream: è il campo che governa il calcolo di
  // ahead/behind, e chiederlo per una ref remota costerebbe uno spawn a vuoto.
  expect(refs.find(r => r.name === "origin/main")!.upstream).toBeUndefined();
});

test("righe vuote e spazzatura non producono rami fantasma", () => {
  expect(parseBranchLine("")).toBeNull();
  expect(parseBranchLine("   ")).toBeNull();
  expect(parseBranchLines("\n\n" + REAL_OUTPUT + "\n\n")).toHaveLength(6);
});
