import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIcon, scanDirForIcon } from "./project-icon";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "proj-icon-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function put(rel: string, content: string | Uint8Array = "x"): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe("scanDirForIcon", () => {
  test("finds a root favicon", () => {
    const p = put("favicon.png");
    expect(scanDirForIcon(dir)).toBe(p);
  });

  test("prefers conventional files over the manifest", () => {
    const fav = put("public/favicon.svg");
    put("icons/big.png");
    put("manifest.json", JSON.stringify({ icons: [{ src: "icons/big.png", sizes: "512x512" }] }));
    expect(scanDirForIcon(dir)).toBe(fav);
  });

  test("picks the LARGEST manifest icon, skipping remote/data srcs", () => {
    put("icons/small.png");
    const big = put("icons/big.png");
    put("public/manifest.json", JSON.stringify({ icons: [
      { src: "https://cdn.example.com/x.png", sizes: "1024x1024" },
      { src: "data:image/png;base64,AAAA", sizes: "999x999" },
      { src: "icons/small.png", sizes: "32x32" },
      { src: "icons/big.png", sizes: "512x512" },
    ] }));
    // manifest srcs resolve relative to the manifest's own directory
    mkdirSync(join(dir, "public/icons"), { recursive: true });
    writeFileSync(join(dir, "public/icons/small.png"), "x");
    const bigPub = join(dir, "public/icons/big.png");
    writeFileSync(bigPub, "x");
    expect(scanDirForIcon(dir)).toBe(bigPub);
    void big;
  });

  test("tolerates a malformed manifest", () => {
    put("manifest.json", "{not json");
    expect(scanDirForIcon(dir)).toBeNull();
  });

  test("falls back to index.html <link rel=icon>", () => {
    const ico = put("art/fav.ico");
    put("index.html", `<html><head><link rel="icon" href="/art/fav.ico"></head></html>`);
    expect(scanDirForIcon(dir)).toBe(ico);
  });

  test("ignores remote index.html icon hrefs", () => {
    put("index.html", `<link rel="icon" href="https://cdn.example.com/f.ico">`);
    expect(scanDirForIcon(dir)).toBeNull();
  });

  test("finds Tauri and electron-builder desktop icons", () => {
    const tauri = put("src-tauri/icons/icon.png");
    expect(scanDirForIcon(dir)).toBe(tauri);
  });

  test("returns null for a plain folder", () => {
    put("README.md");
    expect(scanDirForIcon(dir)).toBeNull();
  });
});

describe("resolveProjectIcon (nested-app layouts)", () => {
  test("root icon wins over nested ones", () => {
    const root = put("favicon.svg");
    put("site/public/favicon.png");
    expect(resolveProjectIcon(dir)).toBe(root);
  });

  test("finds an icon one level down in site/ (AcquaPub layout)", () => {
    const nested = put("site/public/favicon.png");
    expect(resolveProjectIcon(dir)).toBe(nested);
  });

  test("finds an icon in client/ via its index.html", () => {
    const ico = put("client/fav.svg");
    put("client/index.html", `<link href="/fav.svg" rel="icon">`);
    expect(resolveProjectIcon(dir)).toBe(ico);
  });

  test("scans apps/<name>/ monorepo apps", () => {
    put("apps/api/README.md");
    const web = put("apps/web/public/favicon.ico");
    expect(resolveProjectIcon(dir)).toBe(web);
  });

  test("returns null when nothing anywhere", () => {
    put("src/main.ts");
    put("client/src/app.tsx");
    expect(resolveProjectIcon(dir)).toBeNull();
  });
});
