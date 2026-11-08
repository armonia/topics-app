import fs from "node:fs";
import { join, resolve } from "node:path";
import { getDatabase } from "../db";
import type { PtyBridgeReason } from "../../shared/pty-bridge";

export type PtyBridgeSelection = { cmd: string; args: string[]; implementation: "rust" | "node"; reason: PtyBridgeReason; path: string | null };

export function choosePtyBridgeCommand(input: {
  enabled: boolean;
  override: string | null;
  checkoutBinary: string | null;
  binaryMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  nodePath: string;
}): PtyBridgeSelection {
  if (input.override) return { cmd: input.override, args: [], implementation: "rust", reason: "override", path: input.override };
  if (!input.enabled) return { cmd: "node", args: [input.nodePath], implementation: "node", reason: "disabled", path: input.nodePath };
  if (!input.checkoutBinary || input.binaryMtimeMs === null) {
    return { cmd: "node", args: [input.nodePath], implementation: "node", reason: "notBuilt", path: input.nodePath };
  }
  if (input.newestSourceMtimeMs !== null && input.binaryMtimeMs < input.newestSourceMtimeMs) {
    return { cmd: "node", args: [input.nodePath], implementation: "node", reason: "stale", path: input.nodePath };
  }
  return { cmd: input.checkoutBinary, args: [], implementation: "rust", reason: "checkout", path: input.checkoutBinary };
}

export function ptyBridgeOverride(): string | null {
  return process.env.TOPICS_PTY_BRIDGE_BIN || null;
}

export function newestFileMtime(paths: string[]): number | null {
  let newest: number | null = null;
  for (const path of paths) {
    try { newest = Math.max(newest ?? 0, fs.statSync(path).mtimeMs); } catch { /* source removed while walking */ }
  }
  return newest;
}

function newestPtyBridgeSourceMtime(): number | null {
  const root = resolve(import.meta.dir, "../../desktop-tauri/pty-bridge");
  const paths = [join(root, "Cargo.toml"), join(root, "Cargo.lock")];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  visit(join(root, "src"));
  return newestFileMtime(paths);
}

function rustPtyBridgeEnabled(): boolean {
  try {
    const row = getDatabase().query("SELECT value FROM ui_state WHERE key = ?").get("settings") as { value?: string } | null;
    const settings: unknown = row?.value ? JSON.parse(row.value) : null;
    return !!settings && typeof settings === "object" && !Array.isArray(settings)
      && (settings as Record<string, unknown>).rustPtyBridgeEnabled === true;
  } catch {
    return false;
  }
}

function checkoutRustBridgePath(): string | null {
  const root = resolve(import.meta.dir, "../../desktop-tauri/src-tauri/binaries");
  if (process.platform === "darwin") return join(root, "pty-bridge-universal-apple-darwin");
  if (process.platform === "linux" && process.arch === "x64") return join(root, "pty-bridge-x86_64-unknown-linux-gnu");
  if (process.platform === "win32" && process.arch === "x64") return join(root, "pty-bridge-x86_64-pc-windows-msvc.exe");
  return null;
}

function checkoutRustBridgeIsBuilt(path: string): boolean {
  try {
    const info = fs.statSync(path);
    if (!info.isFile() || info.size === 0) return false;
    if (process.platform !== "win32") fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The explicit override wins; otherwise Rust requires the user toggle and a fresh binary. */
export function resolvePtyBridgeCommand(override: string | null = null): PtyBridgeSelection {
  const checkoutBinary = checkoutRustBridgePath();
  // runtime-dep-ok: only a checkout gets here. An installed app either runs the Rust
  // bridge it ships (the override, routes/terminal.ts bundledBridge) or has no
  // terminals at all, so it never asks for the Node bridge or its runtime.
  const nodePath = resolve(import.meta.dir, "../pty-bridge.mjs");
  const built = checkoutBinary && checkoutRustBridgeIsBuilt(checkoutBinary) ? checkoutBinary : null;
  return choosePtyBridgeCommand({
    enabled: rustPtyBridgeEnabled(),
    override,
    checkoutBinary: built,
    binaryMtimeMs: built ? fs.statSync(built).mtimeMs : null,
    newestSourceMtimeMs: built ? newestPtyBridgeSourceMtime() : null,
    nodePath,
  });
}
