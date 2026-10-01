/**
 * @covers PROJECT-09
 * @covers PROJECT-14
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProjectIcon, scanDirForIcon, extractIconHref, parseDataUriIcon, type ResolvedProjectIcon,
  projectIconVersion, projectIconWatchDirs, iconRelevantEntry,
} from "./project-icon";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "proj-icon-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function put(rel: string, content: string | Uint8Array = "x"): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}
const file = (path: string): ResolvedProjectIcon => ({ kind: "file", path });

describe("scanDirForIcon — files, manifest, index.html", () => {
  test("finds a root favicon", () => {
    const p = put("favicon.png");
    expect(scanDirForIcon(dir)).toEqual(file(p));
  });

  test("prefers conventional files over the manifest", () => {
    const fav = put("public/favicon.svg");
    put("icons/big.png");
    put("manifest.json", JSON.stringify({ icons: [{ src: "icons/big.png", sizes: "512x512" }] }));
    expect(scanDirForIcon(dir)).toEqual(file(fav));
  });

  test("picks the LARGEST manifest icon, skipping remote srcs", () => {
    put("public/icons/small.png");
    const big = put("public/icons/big.png");
    put("public/manifest.json", JSON.stringify({ icons: [
      { src: "https://cdn.example.com/x.png", sizes: "1024x1024" },
      { src: "icons/small.png", sizes: "32x32" },
      { src: "icons/big.png", sizes: "512x512" },
    ] }));
    expect(scanDirForIcon(dir)).toEqual(file(big));
  });

  test("tolerates a malformed manifest", () => {
    put("manifest.json", "{not json");
    expect(scanDirForIcon(dir)).toBeNull();
  });

  test("falls back to index.html <link rel=icon>", () => {
    const ico = put("art/fav.ico");
    put("index.html", `<html><head><link rel="icon" href="/art/fav.ico"></head></html>`);
    expect(scanDirForIcon(dir)).toEqual(file(ico));
  });

  test("ignores remote index.html icon hrefs", () => {
    put("index.html", `<link rel="icon" href="https://cdn.example.com/f.ico">`);
    expect(scanDirForIcon(dir)).toBeNull();
  });

  test("finds Tauri desktop icons", () => {
    const tauri = put("src-tauri/icons/icon.png");
    expect(scanDirForIcon(dir)).toEqual(file(tauri));
  });

  test("returns null for a plain folder", () => {
    put("README.md");
    expect(scanDirForIcon(dir)).toBeNull();
  });
});

describe("scanDirForIcon — inline data: URI favicons (Vite pattern)", () => {
  test("serves a raw inline SVG favicon with single quotes and > inside", () => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80'>D</text></svg>`;
    put("index.html", `<head><link rel="icon" href="data:image/svg+xml,${svg}"></head>`);
    const r = scanDirForIcon(dir)!;
    expect(r.kind).toBe("inline");
    if (r.kind === "inline") {
      expect(r.contentType).toBe("image/svg+xml");
      expect(new TextDecoder().decode(r.bytes)).toBe(svg);
    }
  });

  test("serves a base64 data: PNG favicon", () => {
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    put("index.html", `<link rel="icon" href="data:image/png;base64,${png1x1}">`);
    const r = scanDirForIcon(dir)!;
    expect(r.kind).toBe("inline");
    if (r.kind === "inline") {
      expect(r.contentType).toBe("image/png");
      expect(r.bytes.length).toBeGreaterThan(20);
    }
  });

  test("rejects non-image data: URIs", () => {
    put("index.html", `<link rel="icon" href="data:text/html,<script>alert(1)</script>">`);
    expect(scanDirForIcon(dir)).toBeNull();
  });
});

describe("extractIconHref — quote-aware parsing", () => {
  test("captures a data: URI containing raw < > and single quotes", () => {
    const href = `data:image/svg+xml,<svg xmlns='x' viewBox='0 0 1 1'><path d='M0 0'/></svg>`;
    expect(extractIconHref(`<link rel="icon" href="${href}">`)).toBe(href);
  });

  test("skips a preceding stylesheet link and finds the icon's own href", () => {
    const html = `<link rel="stylesheet" href="styles.css"><link rel="icon" href="/fav.svg">`;
    expect(extractIconHref(html)).toBe("/fav.svg");
  });

  test("handles href-before-rel attribute order", () => {
    expect(extractIconHref(`<link href='/f.png' rel='icon'>`)).toBe("/f.png");
  });

  test("returns null when no icon link exists", () => {
    expect(extractIconHref(`<link rel="stylesheet" href="a.css">`)).toBeNull();
  });
});

describe("parseDataUriIcon", () => {
  test("null on oversized payloads", () => {
    expect(parseDataUriIcon(`data:image/png;base64,${"A".repeat(300 * 1024)}`)).toBeNull();
  });
  test("null on disallowed content types", () => {
    expect(parseDataUriIcon("data:application/javascript,alert(1)")).toBeNull();
  });
  test("normalizes image/vnd.microsoft.icon", () => {
    expect(parseDataUriIcon("data:image/vnd.microsoft.icon;base64,AAAA")?.contentType).toBe("image/x-icon");
  });
});

describe("scanDirForIcon — fuzzy filename scan", () => {
  test("finds a loosely-named root logo (logo-acme.png)", () => {
    const p = put("logo-acme.png");
    put("photo.jpg"); // must NOT match
    expect(scanDirForIcon(dir)).toEqual(file(p));
  });

  test("prefers favicon-prefixed over logo-prefixed", () => {
    put("logo-brand.png");
    const fav = put("favicon-32.png");
    expect(scanDirForIcon(dir)).toEqual(file(fav));
  });

  test("scans common asset dirs but not arbitrary names", () => {
    const p = put("assets/icon_dark.svg");
    put("assets/catalogo.png"); // prefix 'catalogo' ≠ 'logo' — must NOT match
    expect(scanDirForIcon(dir)).toEqual(file(p));
  });

  test("declared standards beat the fuzzy scan", () => {
    put("logo-brand.png");
    const declared = put("art/fav.ico");
    put("index.html", `<link rel="icon" href="/art/fav.ico">`);
    expect(scanDirForIcon(dir)).toEqual(file(declared));
  });
});

describe("resolveProjectIcon (nested-app layouts)", () => {
  test("root icon wins over nested ones", () => {
    const root = put("favicon.svg");
    put("site/public/favicon.png");
    expect(resolveProjectIcon(dir)).toEqual(file(root));
  });

  test("finds an icon one level down in site/ (AcquaPub layout)", () => {
    const nested = put("site/public/favicon.png");
    expect(resolveProjectIcon(dir)).toEqual(file(nested));
  });

  test("finds an inline data: favicon in client/index.html (dancerooms layout)", () => {
    put("client/index.html", `<link rel="icon" href="data:image/svg+xml,<svg xmlns='x'><text>D</text></svg>">`);
    expect(resolveProjectIcon(dir)?.kind).toBe("inline");
  });

  test("scans apps/<name>/ monorepo apps", () => {
    put("apps/api/README.md");
    const web = put("apps/web/public/favicon.ico");
    expect(resolveProjectIcon(dir)).toEqual(file(web));
  });

  test("returns null when nothing anywhere", () => {
    put("src/main.ts");
    put("client/src/app.tsx");
    expect(resolveProjectIcon(dir)).toBeNull();
  });
});

describe("projectIconVersion — the identity of what is served", () => {
  test("null when there is no icon", () => {
    expect(projectIconVersion(null)).toBeNull();
  });

  test("stable while the file is untouched, different once it is rewritten, even with the same size", () => {
    const p = put("favicon.svg", "<svg>aa</svg>");
    const v1 = projectIconVersion(resolveProjectIcon(dir));
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(projectIconVersion(resolveProjectIcon(dir))).toBe(v1);
    writeFileSync(p, "<svg>bb</svg>");
    const v2 = projectIconVersion(resolveProjectIcon(dir));
    expect(v2).not.toBeNull();
    expect(v2).not.toBe(v1);
  });

  test("a different file winning the resolution is a different version", () => {
    put("public/logo.png");
    const before = projectIconVersion(resolveProjectIcon(dir));
    put("favicon.png");
    expect(projectIconVersion(resolveProjectIcon(dir))).not.toBe(before);
  });

  test("an inline icon is identified by its bytes", () => {
    const a = projectIconVersion({ kind: "inline", contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") });
    const b = projectIconVersion({ kind: "inline", contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") });
    const c = projectIconVersion({ kind: "inline", contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg />") });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe("projectIconWatchDirs — the folders whose entries can change the answer", () => {
  test("only folders that exist: the root, and the asset folders present", () => {
    mkdirSync(join(dir, "public"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "docs"));
    expect(projectIconWatchDirs(dir).sort()).toEqual([dir, join(dir, "public")].sort());
  });

  test("nested apps and apps/<name> are scanned roots too", () => {
    mkdirSync(join(dir, "site", "public"), { recursive: true });
    mkdirSync(join(dir, "apps", "web", "static"), { recursive: true });
    const dirs = projectIconWatchDirs(dir);
    for (const d of [dir, join(dir, "site"), join(dir, "site", "public"), join(dir, "apps"), join(dir, "apps", "web"), join(dir, "apps", "web", "static")]) {
      expect(dirs).toContain(d);
    }
  });

  test("the folder of a file a manifest points to is watched even off the usual places", () => {
    const icon = put("public/brand/mark.png");
    put("public/manifest.json", JSON.stringify({ icons: [{ src: "brand/mark.png", sizes: "512x512" }] }));
    expect(resolveProjectIcon(dir)).toEqual(file(icon));
    expect(projectIconWatchDirs(dir)).toContain(join(dir, "public", "brand"));
  });

  test("the folder a manifest names is watched while the icon is missing, so the icon is seen when it lands", () => {
    // `public/icons/` is not one of the usual places: only the manifest says
    // the icon lives there. It must be watched before the file exists (an icon
    // added later) and after it is gone (an icon regenerated: removed, then
    // written back).
    mkdirSync(join(dir, "public", "icons"), { recursive: true });
    put("public/manifest.json", JSON.stringify({ icons: [{ src: "/icons/icon.svg", sizes: "192x192" }] }));
    expect(resolveProjectIcon(dir)).toBeNull();
    expect(projectIconWatchDirs(dir)).toContain(join(dir, "public", "icons"));
  });

  test("for a named folder that does not exist yet, its nearest existing ancestor is watched", () => {
    mkdirSync(join(dir, "media"));
    put("index.html", '<link rel="icon" href="/media/brand/mark.svg">');
    const dirs = projectIconWatchDirs(dir);
    expect(dirs).toContain(join(dir, "media"));
    expect(dirs).not.toContain(join(dir, "media", "brand"));
  });

  test("a manifest pointing outside the project adds no folder outside it", () => {
    put("manifest.json", JSON.stringify({ icons: [{ src: "../../elsewhere/icon.png" }] }));
    for (const d of projectIconWatchDirs(dir)) expect(d === dir || d.startsWith(dir + "/")).toBe(true);
  });
});

describe("iconRelevantEntry — which events are worth a look", () => {
  test("images, manifests, pages, folders and unnamed events are; source files are not", () => {
    for (const n of ["favicon.svg", "logo-acme.PNG", "site.webmanifest", "manifest.json", "index.html", "public", "icons", null]) {
      expect(iconRelevantEntry(n)).toBe(true);
    }
    for (const n of ["App.tsx", "server.ts", "bun.lock", "styles.css", "README.md"]) {
      expect(iconRelevantEntry(n)).toBe(false);
    }
  });
});
