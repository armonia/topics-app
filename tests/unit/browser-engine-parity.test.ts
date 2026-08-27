/**
 * @covers NATIVEOPS-02
 *
 * THE TWO ENGINES MUST CARRY THE SAME OPERATIONS — the bench that was missing.
 *
 * WHERE THIS CAME FROM. An audit of the closed cards crossed the delivered work
 * against the requirements that declare it, and out of 2171 closed cards it
 * produced exactly one real gap, a cluster of three: purge_cache, screenshot and
 * cookie get/set "on WebView2 and WebKitGTK". Those three shipped ENGINE PARITY,
 * and no requirement asked for it.
 *
 * WHY NATIVEOPS-01 DID NOT ALREADY COVER IT. That requirement is written per
 * OPERATION: "every browser operation SHALL have a declared native mapping". An
 * operation that works on one engine and says nothing on the other satisfies it
 * word for word. The hole is not inside an operation, it is BETWEEN the engines,
 * and nothing was looking there.
 *
 * WHY THIS CAN BE PROVEN FROM ANY MACHINE. The behaviour of WebView2 needs
 * Windows and the behaviour of WebKitGTK needs Linux, and neither can be
 * measured from a Mac. But the two engines live in TWIN MODULES, and their
 * symmetry is a fact about the source: which operations each one exports, and
 * whether the shell dispatches every one of them to both. That is what this file
 * reads. It proves the DECLARATION, not the runtime, and says so out loud rather
 * than promising more than it checks. WKWebView is inline in the shell and has no
 * module boundary to read, so it is deliberately out of scope here.
 *
 * WHY A DECLARED GAP IS ACCEPTED. One exists today and it is correct: WebView2
 * exposes no history list, so there is no index for `go_to_index` to jump to.
 * The difference that matters is between "that engine cannot" and "nobody
 * noticed": the first is a decision and gets written down, the second is the
 * loss. Without a machine-readable marker the two are the same silence, which is
 * exactly the failure mode `NATIVEOPS-01` names for a single operation.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src");
const WIN = readFileSync(join(SRC, "browser_win.rs"), "utf8");
const LINUX = readFileSync(join(SRC, "browser_linux.rs"), "utf8");
const SHELL = readFileSync(join(SRC, "lib.rs"), "utf8");

/**
 * The operations a module offers to the shell: its top-level public functions.
 *
 * Every form Rust allows for one counts, and that is not pedantry. This file
 * reads a set difference, so a declaration form it does not recognise is not a
 * miss, it is a SILENT PASS: an operation added to one engine as `pub async fn`
 * would be invisible on both sides and the asymmetry would read as parity. The
 * shape the bench cannot see is the shape the next gap will have.
 */
const EXPORTED_OP = /^pub(?:\((?:crate|super)\))? (?:async )?(?:unsafe )?fn ([a-z_0-9]+)/gm;

function exportedOps(src: string): string[] {
  return [...src.matchAll(EXPORTED_OP)].map((m) => m[1]).sort();
}

/**
 * Whether the shell routes `op` to that engine's module. Anchored on a word
 * boundary: plain substring matching lets `browser_win::reload_hard` answer for
 * `reload`, which is a longer name vouching for a shorter one that may not be
 * dispatched at all.
 */
function dispatchesIn(src: string, module: string, op: string): boolean {
  return new RegExp(`${module}::${op}\\b`).test(src);
}

function shellDispatches(module: string, op: string): boolean {
  return dispatchesIn(SHELL, module, op);
}

/**
 * A hole the engine cannot fill, written down on the module that lacks it:
 * `PARITY-GAP: <op> - <why>`. The reason is required and must be a sentence, not
 * a shrug: a marker with nothing after the dash would re-open the silence it
 * exists to close.
 */
function declaredGaps(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/PARITY-GAP:\s*([a-z_0-9]+)\s*-\s*(.+)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const winOps = exportedOps(WIN);
const linuxOps = exportedOps(LINUX);
const winGaps = declaredGaps(WIN);
const linuxGaps = declaredGaps(LINUX);

describe("i due motori non-Apple portano lo stesso insieme di operazioni", () => {
  test("il banco non e' vuoto: entrambi i moduli esportano operazioni", () => {
    // Guards the whole file against a regex that stopped matching: every
    // assertion below is a set difference, and two empty sets agree perfectly.
    expect(winOps.length).toBeGreaterThan(8);
    expect(linuxOps.length).toBeGreaterThan(8);
  });

  test("ogni operazione di un motore esiste sull'altro, o e' un buco dichiarato", () => {
    const missingOnWin = linuxOps.filter((op) => !winOps.includes(op) && !winGaps.has(op));
    const missingOnLinux = winOps.filter((op) => !linuxOps.includes(op) && !linuxGaps.has(op));
    expect({ missingOnWin, missingOnLinux }).toEqual({ missingOnWin: [], missingOnLinux: [] });
  });

  test("un buco dichiarato porta il suo motivo, e riguarda un'operazione che l'altro motore ha davvero", () => {
    for (const [op, reason] of winGaps) {
      expect(reason.length).toBeGreaterThan(20);
      expect(linuxOps).toContain(op);
    }
    for (const [op, reason] of linuxGaps) {
      expect(reason.length).toBeGreaterThan(20);
      expect(winOps).toContain(op);
    }
  });

  test("il buco che esiste oggi e' quello atteso, e non uno in piu'", () => {
    // Pinned on purpose: this is the one asymmetry we accept, and a second one
    // appearing must be read by a person, not absorbed by a green test.
    expect([...winGaps.keys()]).toEqual(["go_to_index"]);
    expect([...linuxGaps.keys()]).toEqual([]);
  });

  test("ogni operazione condivisa e' smistata dal guscio per ENTRAMBI i motori", () => {
    const shared = winOps.filter((op) => linuxOps.includes(op));
    const oneSided = shared.filter(
      (op) => shellDispatches("browser_win", op) !== shellDispatches("browser_linux", op),
    );
    expect(oneSided).toEqual([]);
  });

  test("nessuna operazione esportata resta senza chiamante", () => {
    // A module op the shell never calls is a capability that quietly left that
    // engine: it compiles, it is covered by nothing, and it looks like parity.
    const orphanWin = winOps.filter((op) => !shellDispatches("browser_win", op));
    const orphanLinux = linuxOps.filter((op) => !shellDispatches("browser_linux", op));
    expect({ orphanWin, orphanLinux }).toEqual({ orphanWin: [], orphanLinux: [] });
  });
});

describe("il banco vede le forme che dichiara di leggere", () => {
  // A bench built on set differences fails OPEN: whatever it cannot read is
  // absent from both sides and therefore agrees. These cases are the reading
  // itself under test, on synthetic source, so the day an engine grows an
  // `async` operation the parity check is the thing that notices.
  test("un'operazione pubblica conta in ogni forma che Rust ammette", () => {
    const src = [
      "pub fn plain_op(wv: &Webview) {}",
      "pub async fn async_op(wv: &Webview) {}",
      "pub(crate) fn crate_op(wv: &Webview) {}",
      "pub unsafe fn unsafe_op(wv: &Webview) {}",
    ].join("\n");
    expect(exportedOps(src)).toEqual(["async_op", "crate_op", "plain_op", "unsafe_op"]);
  });

  test("cio' che non e' un'operazione del modulo resta fuori", () => {
    const src = ["fn private_op() {}", "    pub fn nested_op() {}", "// pub fn commented_op() {}"].join("\n");
    expect(exportedOps(src)).toEqual([]);
  });

  test("un nome piu' lungo non risponde per uno piu' corto", () => {
    const shell = "browser_win::reload_hard(wv)?;";
    expect(dispatchesIn(shell, "browser_win", "reload_hard")).toBe(true);
    expect(dispatchesIn(shell, "browser_win", "reload")).toBe(false);
  });
});
