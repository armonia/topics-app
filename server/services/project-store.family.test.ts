/**
 * The store's side of accorpa / separa: the one-level rule, the mode, and what a
 * delete does to the children.
 *
 * @covers WORKTREE-STD-06
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectStore, ParentRefusedError } from "./project-store";

function storeWithFamilyColumns() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    color TEXT, icon TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    org_id TEXT, owner_person_id TEXT, incognito INTEGER NOT NULL DEFAULT 0
  )`);
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261124110000-projects-parent-merge.sql"), "utf8"));
  const store = createProjectStore(db);
  const mk = (slug: string, path = `/w/${slug}`) => store.create({ name: slug, slug, path });
  return { db, store, mk };
}

describe("setFamily", () => {
  test("a new project is top level and merges by default", () => {
    const { mk } = storeWithFamilyColumns();
    const p = mk("shopcms");
    expect(p.parentId).toBeNull();
    expect(p.mergeMode).toBe("accorpa");
  });

  test("sets the parent, flips the mode, and detaches with null", () => {
    const { store, mk } = storeWithFamilyColumns();
    const parent = mk("shopcms");
    const child = mk("shopcms-moduli");
    expect(store.setFamily(child.id, { parentId: parent.id })!.parentId).toBe(parent.id);
    expect(store.setFamily(child.id, { mergeMode: "separa" })).toMatchObject({ parentId: parent.id, mergeMode: "separa" });
    expect(store.get(child.id)).toMatchObject({ parentId: parent.id, mergeMode: "separa" });
    expect(store.setFamily(child.id, { parentId: null })!.parentId).toBeNull();
  });

  test("detaching records the choice as 'separa', so the boot backfill does not put it back", () => {
    const { store, mk } = storeWithFamilyColumns();
    const parent = mk("shopcms");
    const child = mk("shopcms-moduli");
    store.setFamily(child.id, { parentId: parent.id, mergeMode: "accorpa" });
    expect(store.setFamily(child.id, { parentId: null })).toMatchObject({ parentId: null, mergeMode: "separa" });
    // Joining a parent again with no mode merges, as the menu offers it.
    expect(store.setFamily(child.id, { parentId: parent.id })).toMatchObject({ parentId: parent.id, mergeMode: "accorpa" });
  });

  test("refuses a second level in both directions, itself, and an unknown parent", () => {
    const { store, mk } = storeWithFamilyColumns();
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    store.setFamily(b.id, { parentId: a.id });
    expect(() => store.setFamily(c.id, { parentId: b.id })).toThrow(ParentRefusedError);
    expect(() => store.setFamily(a.id, { parentId: c.id })).toThrow(ParentRefusedError);
    expect(() => store.setFamily(a.id, { parentId: a.id })).toThrow(ParentRefusedError);
    expect(() => store.setFamily(a.id, { parentId: "ghost" })).toThrow(ParentRefusedError);
  });

  test("deleting a parent frees its children instead of failing on the reference", () => {
    const { store, mk } = storeWithFamilyColumns();
    const parent = mk("shopcms");
    const child = mk("shopcms-moduli");
    store.setFamily(child.id, { parentId: parent.id });
    expect(store.delete(parent.id)).toBe(true);
    expect(store.get(child.id)!.parentId).toBeNull();
  });

  test("an unknown id answers null", () => {
    const { store } = storeWithFamilyColumns();
    expect(store.setFamily("ghost", { mergeMode: "separa" })).toBeNull();
  });
});
