import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");

// lib.rs was split by seam; source-text guards read the whole shell, lib.rs first.
const SHELL_FILES = [
  "lib.rs",
  "browser_panes.rs",
  "window_chrome.rs",
  "shortcuts_menu.rs",
  "sidecar_boot.rs",
  "perf_metrics.rs",
  "os_integration.rs",
];

export function readTauriShellSource(): string {
  return SHELL_FILES.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
}
