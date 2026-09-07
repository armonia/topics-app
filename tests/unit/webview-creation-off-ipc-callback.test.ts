/**
 * @covers NATIVEOPS-04
 *
 * A COMMAND THAT BUILDS A WEBVIEW MUST NOT RUN INSIDE THE IPC CALLBACK.
 *
 * WHAT IT COST. Topics 2.2.281 shipped with `browser_open` declared as a plain
 * `#[tauri::command]`. A sync command runs inside the IPC callback of the
 * webview that invoked it, which on Windows is a WebView2 COM callback, and wry
 * waits for `CreateCoreWebView2Environment/Controller` with a NESTED message
 * loop (`webview2_com::wait_with_pump`). The pump keeps the window alive - the
 * chrome paints, shortcuts still answer - while the completion callback cannot
 * be delivered, so the wait never ends and the command never answers. Measured
 * on the real machine: the pane opened, the address bar accepted the URL, and
 * the client sat on `browser.native.initializing` for as long as anyone looked.
 * Tauri documents exactly this on `WebviewBuilder::new` ("on Windows, this
 * function deadlocks when used in a synchronous command or event handlers").
 *
 * WHY NOTHING ELSE WOULD HAVE CAUGHT IT. It compiles, it passes clippy, and on
 * macOS it works: WKWebView creation does not need a nested pump. The defect
 * only exists on the engine the developing machine cannot run, which is the
 * same blind spot `check-cross-shell.sh` was written for - except that one
 * reads types, and this is a threading rule that no type expresses.
 *
 * WHAT IT READS. Every `fn` in the shell crate, the commands among them, and
 * who calls whom. A SYNC command that can reach a webview construction is
 * rejected. Bodies are cut at the next `fn` rather than by matching braces: it
 * over-approximates a body by a few trailing lines, which for a reachability
 * question is the safe direction. Comments are stripped first, and that is not
 * tidiness: the doc comment of the NEXT function falls inside the previous
 * slice, so a paragraph naming `WebviewBuilder::new` - the one above
 * `browser_open`, explaining this very defect - made `no_abort` look like a
 * webview factory and painted 36 innocent commands red.
 *
 * WHAT IT DOES NOT CLAIM. That the pane works on Windows - that is measured by
 * `tools/win-desktop-check.sh` on real hardware. This holds the SHAPE that made
 * it impossible, and the shape is readable from any machine.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");

/** The three ways this crate can bring a native webview into the world. */
const CREATES_NATIVE_VIEW = [
  "WebviewBuilder::new",
  "WebviewWindowBuilder::new",
  ".add_child(",
];

/**
 * A thread hop breaks the chain. `std::thread::spawn` is the other legal answer
 * to the same rule (`rebuild_main_webview` uses it, and says why), so a function
 * that hops does not pass its danger on to whoever called it.
 */
const HOP = "std::thread::spawn";

/** Code only: comments and attributes cannot call anything. */
function code(rust: string): string {
  return rust
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // `[^:]` guards `https://` and friends, which are not the start of a comment.
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^[ \t]*#\[[^\n]*\]$/gm, "");
}

interface Fn {
  name: string;
  body: string;
  /** Declared as a command, and whether that command leaves the IPC callback. */
  command: boolean;
  asyncCommand: boolean;
}

function parse(source: string): Fn[] {
  // Every `fn name(` at the start of a line (any indentation), in file order.
  const heads: { name: string; at: number }[] = [];
  const re = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:extern[ \t]+"[^"]*"[ \t]+)?fn[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) heads.push({ name: m[1], at: m.index });

  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : source.length;
    const body = code(source.slice(h.at, end));
    // The attributes and doc comment of a function sit ABOVE its `fn` line, so
    // they belong to the previous slice: look back from the head instead.
    const before = source.slice(Math.max(0, h.at - 1200), h.at);
    const attr = /#\[tauri::command(\([^)]*\))?\][^]*$/.exec(before);
    const isCommand = attr !== null && /#\[tauri::command[^\]]*\][\s\S]{0,400}$/.test(before);
    const signature = source.slice(h.at, h.at + 200);
    return {
      name: h.name,
      body,
      command: isCommand,
      asyncCommand:
        (attr?.[1] ?? "").includes("async") || /^[^(]*\basync[ \t]+fn\b/.test(signature),
    };
  });
}

function shellFunctions(): Fn[] {
  const out: Fn[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".rs"))) {
    out.push(...parse(readFileSync(join(SRC, file), "utf8")));
  }
  return out;
}

describe("webview creation never happens inside the IPC callback", () => {
  const functions = shellFunctions();

  test("the crate is readable and the commands are found", () => {
    expect(functions.length).toBeGreaterThan(200);
    expect(functions.filter((f) => f.command).length).toBeGreaterThan(30);
    // The subject of the defect must still be a command, whatever its shape.
    expect(functions.find((f) => f.name === "browser_open")?.command).toBe(true);
  });

  test("no synchronous command can reach a webview construction", () => {
    const byName = new Map(functions.map((f) => [f.name, f]));
    const dangerous = new Set<string>();
    for (const f of functions) {
      if (f.body.includes(HOP)) continue;
      if (CREATES_NATIVE_VIEW.some((t) => f.body.includes(t))) dangerous.add(f.name);
    }
    // Propagate backwards until nothing new is dangerous.
    for (;;) {
      const before = dangerous.size;
      for (const f of functions) {
        if (dangerous.has(f.name) || f.body.includes(HOP)) continue;
        for (const target of dangerous) {
          if (target !== f.name && f.body.includes(`${target}(`)) {
            dangerous.add(f.name);
            break;
          }
        }
      }
      if (dangerous.size === before) break;
    }
    // Sanity: the builder itself has to be visible to this reading, otherwise
    // the check is measuring an empty set and would pass on anything.
    expect(dangerous.size).toBeGreaterThan(0);
    expect(byName.has("browser_open")).toBe(true);

    const offenders = functions
      .filter((f) => f.command && !f.asyncCommand && dangerous.has(f.name))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});
