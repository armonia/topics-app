/**
 * @covers CHROME-09
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Windows gets the DWM Acrylic backdrop, and the four things that can silently
 * kill it.
 *
 * WHY THIS FILE EXISTS. The glass on Windows is not one feature, it is a CHAIN,
 * and every link is invisible when it breaks: nothing throws, nothing logs, the
 * window simply comes back flat and looks like a styling bug.
 *
 *   1. the Rust side asks DWM for Acrylic (not Mica: Mica samples only the
 *      desktop wallpaper, so a window sitting behind ours would not show);
 *   2. the WebView2 default background is TRANSPARENT. At A:255 the webview
 *      paints its own colour over the backdrop before the page draws, and no
 *      DWM curtain can ever appear. This is exactly the value the code used to
 *      carry, so it is the regression this file is here to catch;
 *   3. the page carries the `native-frost` class, or the CSS paints opaque on
 *      top of a backdrop that works perfectly;
 *   4. the shipped copy of the pre-paint script carries the same logic as its
 *      source, or the class never reaches the packaged app.
 *
 * WHAT IS NOT TESTED HERE, and cannot be: whether the frost is actually VISIBLE.
 * That takes the real machine, with the system transparency preference on. The
 * chain above is what a Mac can prove.
 */

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Run the REAL class-tagging block out of `boot.js` against a fake DOM, instead
 * of asserting on its text: the platform detection is the part that has to be
 * right, and a string match cannot tell working code from a comment about it.
 */
function tagHtml(opts: { ua: string; platform: string; tauri: boolean }): Set<string> {
  const src = read("client/public/boot.js");
  const from = src.indexOf("var __isMac =");
  expect(from).toBeGreaterThan(0);
  const to = src.indexOf("} catch (e) {}", from);
  expect(to).toBeGreaterThan(from);
  const block = src.slice(from, to);

  const classes = new Set<string>();
  const documentStub = {
    documentElement: { classList: { add: (...names: string[]) => names.forEach((n) => classes.add(n)) } },
  };
  const windowStub = opts.tauri ? { __TAURI_INTERNALS__: {} } : {};
  const locationStub = { protocol: "https:", hostname: "localhost" };
  const navigatorStub = { userAgent: opts.ua, platform: opts.platform };
  // eslint-disable-next-line no-new-func -- running the shipped source is the point
  new Function("window", "navigator", "location", "document", block)(
    windowStub,
    navigatorStub,
    locationStub,
    documentStub,
  );
  return classes;
}

const MAC = {
  ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  platform: "MacIntel",
};
const WIN = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  platform: "Win32",
};

describe("Windows acrylic: the page lets the backdrop through", () => {
  test("under the desktop shell each platform gets its own gate plus the shared one", () => {
    const mac = tagHtml({ ...MAC, tauri: true });
    expect(mac.has("native-frost")).toBe(true);
    expect(mac.has("electron-mac")).toBe(true);
    expect(mac.has("tauri-mac")).toBe(true);
    expect(mac.has("windows-acrylic")).toBe(false);

    const win = tagHtml({ ...WIN, tauri: true });
    expect(win.has("native-frost")).toBe(true);
    expect(win.has("windows-acrylic")).toBe(true);
    // Not `electron-mac`: parts of that CSS assume the gaps between the cards
    // fall on the real desktop, which whole-window DWM cannot do.
    expect(win.has("electron-mac")).toBe(false);
    expect(win.has("tauri-mac")).toBe(false);
  });

  test("in a plain browser nobody gets the frost classes", () => {
    expect(tagHtml({ ...WIN, tauri: false }).size).toBe(0);
    expect(tagHtml({ ...MAC, tauri: false }).size).toBe(0);
  });

  test("the shipped copy of boot.js carries the same logic as its source", () => {
    // `public/boot.js` is tracked and is what the packaged shell serves. It is
    // copied by hand, so it drifts silently: a Windows build with the old copy
    // would never tag the page, and the whole Rust side would look broken.
    expect(read("public/boot.js")).toBe(read("client/public/boot.js"));
  });

  test("the page background goes transparent on the SHARED class, not on the mac one", () => {
    const css = read("client/src/index.css");
    expect(css).toContain("html.native-frost,\nhtml.native-frost body,\nhtml.native-frost #root {");
    // Pre-paint too: a first frame painted opaque is a visible flash.
    expect(read("client/index.html")).toContain(
      "html.native-frost, html.native-frost body, html.native-frost #root { background-color: transparent; }",
    );
  });

  test("the per-region IPC stays behind the macOS gate", () => {
    // DWM has no per-region equivalent. Calling `vibrancy_set_regions` on
    // Windows would be an IPC into a command that no-ops there, and a promise
    // that the gaps are transparent when they are frosted.
    const hook = read("client/src/hooks/useFloatingVibrancy.ts");
    const resolver = hook.slice(hook.indexOf("function resolveVibrancy"));
    const gate = resolver.indexOf("isMacHost()");
    const firstIpc = resolver.indexOf("vibrancy_set_regions");
    expect(gate).toBeGreaterThan(-1);
    expect(firstIpc).toBeGreaterThan(gate);
  });
});

describe("Windows acrylic: the shell asks for the curtain", () => {
  const acrylic = read("desktop-tauri/src-tauri/src/windows_acrylic.rs");

  test("the backdrop is Acrylic, and swapping it stays ONE line", () => {
    expect(acrylic).toContain("const BACKDROP: Effect = Effect::Acrylic;");
    // One constant, one decision: no second Effect literal in the CODE (the
    // header names Mica on purpose, to say where to change your mind).
    const code = acrylic.split("\n").filter((l) => !l.trimStart().startsWith("//"));
    expect(code.join("\n").match(/Effect::(Acrylic|Mica|MicaDark|MicaLight|Tabbed|Blur)\b/g)).toHaveLength(1);
  });

  test("the webview background is transparent, or no curtain can show", () => {
    const repaint = read("desktop-tauri/src-tauri/src/windows_repaint.rs");
    const call = repaint.slice(repaint.indexOf("SetDefaultBackgroundColor"));
    expect(call).toContain("A: 0,");
    expect(call).not.toContain("A: 255,");
  });

  test("the theme reaches the backdrop through the door that already exists", () => {
    // `set_theme` is the one command that syncs native chrome to the theme MODE.
    // A second path would drift from it the first time either side changed.
    const lib = read("desktop-tauri/src-tauri/src/lib.rs");
    const cmd = lib.slice(lib.indexOf("fn set_theme(app: tauri::AppHandle, theme: String)"));
    expect(cmd.slice(0, 4000)).toContain("windows_acrylic::apply_theme_mode(&app, &theme)");
  });

  test("only the app shell windows get the backdrop", () => {
    // A browser pane loads the open web: a DWM curtain behind it would frost
    // somebody else's page.
    expect(acrylic).toContain('label == "main" || label.starts_with("detach-")');
  });
});
