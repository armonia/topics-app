/**
 * The pure family logic: merged board ids, parent rules, sibling suggestions.
 *
 * @covers WORKTREE-STD-06
 */
import { describe, expect, test } from "bun:test";
import {
  boardIdOfRow, familyLinks, formatProjectFamilyLabel, inheritedSettingsBoardId, mergedBoardIds, mergedParentMap, parentChoices, projectFamilyLabel,
  refuseParent, siblingScore, suggestParents,
  type FamilyRow,
} from "./project-family";

const row = (id: string, path: string, over: Partial<FamilyRow> = {}): FamilyRow => ({
  id, path, parentId: null, mergeMode: "accorpa", name: path.split("/").pop(), ...over,
});

const shop = row("p-shop", "/w/Shop/shopcms");
const modules = row("p-mod", "/w/Shop/shopcms-moduli", { parentId: "p-shop" });
const gym = row("p-gym", "/w/dark-proposal", { parentId: "p-shop", mergeMode: "separa" });
const other = row("p-other", "/w/Other/acme-site");
const rows = [shop, modules, gym, other];

describe("mergedBoardIds", () => {
  test("a parent shows itself and its merged children, not the separated ones", () => {
    expect(mergedBoardIds(rows, boardIdOfRow(shop))).toEqual([boardIdOfRow(shop), boardIdOfRow(modules)]);
  });
  test("a child, a project without children and an unknown id answer with themselves", () => {
    expect(mergedBoardIds(rows, boardIdOfRow(modules))).toEqual([boardIdOfRow(modules)]);
    expect(mergedBoardIds(rows, boardIdOfRow(other))).toEqual([boardIdOfRow(other)]);
    expect(mergedBoardIds(rows, "nope-abc123")).toEqual(["nope-abc123"]);
  });
  test("an archived child leaves the board, and so does an archived parent's family", () => {
    const archivedChild = [shop, { ...modules, archived: true }];
    expect(mergedBoardIds(archivedChild, boardIdOfRow(shop))).toEqual([boardIdOfRow(shop)]);
  });
  test("a trailing slash on the path is the same board", () => {
    expect(boardIdOfRow(row("x", "/w/Shop/shopcms/"))).toBe(boardIdOfRow(shop));
  });
});

describe("familyLinks / mergedParentMap", () => {
  test("lists both modes in board ids and keeps only merging links in the map", () => {
    const links = familyLinks(rows);
    expect(links.map((l) => [l.projectId, l.parentProjectId, l.mode])).toEqual([
      [boardIdOfRow(modules), boardIdOfRow(shop), "accorpa"],
      [boardIdOfRow(gym), boardIdOfRow(shop), "separa"],
    ]);
    expect([...mergedParentMap(links)]).toEqual([[boardIdOfRow(modules), boardIdOfRow(shop)]]);
  });
  test("a link whose parent is archived or missing is dropped", () => {
    expect(familyLinks([{ ...shop, archived: true }, modules])).toEqual([]);
    expect(familyLinks([modules])).toEqual([]);
  });
});

describe("projectFamilyLabel", () => {
  const names = new Map([["mother", "Sito Armonia"], ["child", "Nuvola"], ["solo", "Nuvola"]]);
  const nameOf = (id: string) => names.get(id) ?? id;

  test("a merged child answers with its parent's name AND its own", () => {
    const parentOf = mergedParentMap([{ projectId: "child", parentProjectId: "mother", mode: "accorpa" }]);
    expect(projectFamilyLabel("child", parentOf, nameOf)).toEqual({ parent: "Sito Armonia", child: "Nuvola" });
    expect(formatProjectFamilyLabel(projectFamilyLabel("child", parentOf, nameOf))).toBe("Sito Armonia · Nuvola");
  });
  test("separated, top-level or unknown projects answer with their own name only", () => {
    const parentOf = mergedParentMap([{ projectId: "child", parentProjectId: "mother", mode: "separa" }]);
    expect(projectFamilyLabel("child", parentOf, nameOf)).toEqual({ parent: null, child: "Nuvola" });
    expect(projectFamilyLabel("solo", new Map(), nameOf)).toEqual({ parent: null, child: "Nuvola" });
    expect(formatProjectFamilyLabel(projectFamilyLabel("solo", new Map(), nameOf))).toBe("Nuvola");
  });
});

describe("refuseParent", () => {
  test("accepts a sibling and accepts becoming top level", () => {
    expect(refuseParent(rows, "p-other", "p-shop")).toBeNull();
    expect(refuseParent(rows, "p-mod", null)).toBeNull();
  });
  test("refuses itself, unknown ids, a child as parent, a parent as child, and one path twice", () => {
    expect(refuseParent(rows, "p-shop", "p-shop")).toBe("self");
    expect(refuseParent(rows, "ghost", "p-shop")).toBe("unknown_project");
    expect(refuseParent(rows, "p-other", "ghost")).toBe("unknown_parent");
    expect(refuseParent(rows, "p-other", "p-mod")).toBe("parent_is_child");
    expect(refuseParent(rows, "p-shop", "p-other")).toBe("has_children");
    expect(refuseParent([shop, row("dup", "/w/Shop/shopcms/")], "dup", "p-shop")).toBe("same_path");
  });
});

describe("suggestions", () => {
  test("a name prefix outranks a shared folder, and a bare folder match is still a hint", () => {
    const cloud = row("p-cloud", "/w/Shop/sim-lab");
    const all = [shop, cloud, other, row("p-nameless", "/elsewhere/shopcms-extra")];
    expect(siblingScore(cloud, shop)).toBe(1);
    expect(siblingScore(row("m", "/w/Shop/shopcms-moduli"), shop)).toBe(5);
    expect(suggestParents(all, "p-cloud").map((r) => r.id)).toEqual(["p-shop"]);
    expect(suggestParents([...all, row("m", "/w/Shop/shopcms-moduli")], "m").map((r) => r.id)).toEqual(["p-shop", "p-nameless", "p-cloud"]);
  });
  test("never suggests a project that could not be the parent", () => {
    // gym is a child already, shop has children: neither can take `other`... only shop can (top level)
    const ids = suggestParents(rows, "p-other").map((r) => r.id);
    expect(ids).not.toContain("p-mod");
    expect(ids).not.toContain("p-other");
  });
  test("parentChoices puts the suggestions first and drops the impossible", () => {
    const { suggested, others } = parentChoices([shop, other, row("m2", "/w/Shop/shopcms-moduli")], "m2");
    expect(suggested.map((r) => r.id)).toEqual(["p-shop"]);
    expect(others.map((r) => r.id)).toEqual(["p-other"]);
  });
});

describe("inheritedSettingsBoardId", () => {
  test("only a merged child under a live parent falls back on the parent's board", () => {
    expect(inheritedSettingsBoardId(rows, boardIdOfRow(modules))).toBe(boardIdOfRow(shop));
    expect(inheritedSettingsBoardId(rows, boardIdOfRow(gym))).toBeNull(); // separa
    expect(inheritedSettingsBoardId(rows, boardIdOfRow(shop))).toBeNull(); // a parent
    expect(inheritedSettingsBoardId([{ ...shop, archived: true }, modules], boardIdOfRow(modules))).toBeNull();
  });
});
