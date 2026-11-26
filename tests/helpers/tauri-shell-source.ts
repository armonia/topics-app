import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");

// lib.rs was split by seam; source-text guards read the whole shell, lib.rs first.
const SHELL_FILES = [
  "lib.rs",
  "browser_panes.rs",
  "window_chrome.rs",
  "traffic_light_geometry.rs",
  "shortcuts_menu.rs",
  "sidecar_boot.rs",
  "perf_metrics.rs",
  "os_integration.rs",
];

export function readTauriShellSource(): string {
  return SHELL_FILES.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
}

/**
 * The slice of a Rust function body, from its signature to the next `fn` at
 * column 0. Source-text guards read one function at a time, so a match found
 * elsewhere in the shell cannot pass for a match inside the function under test.
 */
export function rustFnBody(rust: string, signature: string): string {
  const start = rust.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found in the tauri shell source`);
  const rest = rust.slice(start + signature.length);
  const end = rest.search(/\n(?:pub(?:\(crate\))? )?(?:async )?fn /);
  return end === -1 ? rest : rest.slice(0, end);
}
