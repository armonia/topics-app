/**
 * @covers NATIVEOPS-03
 *
 * EVERY BROWSER OPERATION ANSWERS FOR ALL THREE ENGINES, OR IT IS NOT SHIPPED.
 *
 * WHAT THIS ADDS TO NATIVEOPS-02. That requirement reads the two TWIN MODULES,
 * `browser_win.rs` and `browser_linux.rs`, and holds them symmetric. It cannot
 * see WKWebView, which is inline in the shell and has no module boundary, and it
 * cannot see an operation whose asymmetry lives OUTSIDE those modules. Both
 * blind spots are the same operation shape, and the shell has two of them today:
 * `browser_take_nav_errors` and `browser_take_nav_state` are plain queue drains,
 * identical on the three engines, fed by an objc hook that exists only on
 * macOS. Off macOS they return an empty list, which the caller reads as "nothing
 * happened". A failed navigation on Windows is therefore not an error, it is a
 * silence, and no set difference between the twin modules would ever notice.
 *
 * WHAT IT READS. The `invoke_handler` registration list is the operation
 * REGISTRY: exactly what the client is allowed to call. For each registered
 * `browser_*` command this bench demands a declaration on the command that names
 * the engines that carry it and, for each engine that does NOT, a gap with its
 * reason. The union must be the three engines: an operation may be unavailable,
 * it may not be undiscussed.
 *
 * WHAT IT DOES NOT CLAIM. WebView2 needs Windows and WebKitGTK needs Linux, and
 * neither behaviour can be measured from a Mac. This proves the DECLARATION, not
 * the runtime, which is the strongest thing provable from any machine and is
 * stated out loud rather than dressed up as more.
 *
 * WHY A DECLARED GAP IS ACCEPTED, AND PINNED. "That engine cannot" is a decision
 * and gets written down; "nobody noticed" is the loss, and without the marker
 * the two are the same silence. The set of gaps is pinned below so a THIRD one
 * has to be read by a person instead of being absorbed by a green test.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SHELL = readFileSync(
  join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "src", "lib.rs"),
  "utf8",
);

const ENGINES = ["wkwebview", "webview2", "webkitgtk"] as const;
type Engine = (typeof ENGINES)[number];

/**
 * The operations the client may call: the `browser_*` entries of the single
 * `tauri::generate_handler!` list. Reading the registration rather than the `fn`
 * definitions is deliberate. A command that exists in the file but is not
 * registered is unreachable, and holding it to the parity bar would be noise;
 * a command that IS registered is a promise made to the client on whichever
 * machine the build runs.
 */
function registeredOps(): string[] {
  const list = SHELL.slice(SHELL.indexOf("generate_handler!"));
  const end = list.indexOf("])");
  return [...list.slice(0, end).matchAll(/^\s*(browser_[a-z_0-9]+),/gm)].map((m) => m[1]).sort();
}

/**
 * The declaration carried by each command:
 *   // ENGINES: <engine>[, <engine>...] - <why one body serves them, or where the arms are>
 *   // ENGINES-GAP: <engine> - <why that engine cannot carry it>
 * Both are read from the whole file and keyed by the command they sit above, so
 * a declaration orphaned by a renamed or deleted command shows up as a
 * declaration for an operation nobody registered.
 */
interface Declaration {
  carries: Engine[];
  gaps: Map<Engine, string>;
  reason: string;
}

function declarations(): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  const lines = SHELL.split("\n");
  let pending: { carries: Engine[]; reason: string } | null = null;
  let gaps = new Map<Engine, string>();
  for (const line of lines) {
    const carry = line.match(/^\s*\/\/ ENGINES:\s*([a-z0-9, ]+?)\s*-\s*(.+)$/);
    if (carry) {
      pending = {
        carries: carry[1].split(",").map((e) => e.trim()) as Engine[],
        reason: carry[2].trim(),
      };
      gaps = new Map();
      continue;
    }
    const gap = line.match(/^\s*\/\/ ENGINES-GAP:\s*([a-z0-9]+)\s*-\s*(.+)$/);
    if (gap) {
      gaps.set(gap[1] as Engine, gap[2].trim());
      continue;
    }
    const fn = line.match(/^\s*(?:pub )?(?:async )?fn (browser_[a-z_0-9]+)/);
    if (fn && pending) {
      out.set(fn[1], { carries: pending.carries, gaps, reason: pending.reason });
      pending = null;
      gaps = new Map();
    }
  }
  return out;
}

const ops = registeredOps();
const declared = declarations();

/** The gaps we accept today, and the only ones. A fourth line here is a decision. */
const PINNED_GAPS = [
  "browser_go_to_index on webview2",
  "browser_take_nav_errors on webkitgtk",
  "browser_take_nav_errors on webview2",
  "browser_take_nav_state on webkitgtk",
  "browser_take_nav_state on webview2",
];

describe("ogni operazione del browser risponde per tutti e tre i motori", () => {
  test("il banco non e' vuoto: il registro dei comandi si legge davvero", () => {
    // Every assertion below quantifies over this list, and an empty list agrees
    // with anything. A regex that stopped matching must fail here, loudly,
    // instead of turning the whole file into a green no-op.
    expect(ops.length).toBeGreaterThan(25);
    expect(ops).toContain("browser_screenshot");
  });

  test("ogni operazione registrata porta la sua dichiarazione", () => {
    const undeclared = ops.filter((op) => !declared.has(op));
    expect(undeclared).toEqual([]);
  });

  test("nessuna dichiarazione orfana: si dichiara solo cio' che e' registrato", () => {
    const orphans = [...declared.keys()].filter((op) => !ops.includes(op)).sort();
    expect(orphans).toEqual([]);
  });

  test("per ogni operazione i tre motori sono coperti: portati, oppure buco dichiarato", () => {
    const unanswered: string[] = [];
    for (const op of ops) {
      const d = declared.get(op);
      if (!d) continue; // already red above
      for (const engine of ENGINES) {
        const answered = d.carries.includes(engine) || d.gaps.has(engine);
        if (!answered) unanswered.push(`${op} on ${engine}`);
      }
    }
    expect(unanswered).toEqual([]);
  });

  test("un motore non puo' essere insieme portato e buco, e i nomi sono quelli dei tre motori", () => {
    for (const [op, d] of declared) {
      for (const engine of [...d.carries, ...d.gaps.keys()]) {
        expect({ op, engine, known: ENGINES.includes(engine) }).toEqual({ op, engine, known: true });
      }
      const both = d.carries.filter((e) => d.gaps.has(e));
      expect({ op, both }).toEqual({ op, both: [] });
    }
  });

  test("ogni dichiarazione porta una ragione, e un buco dice perche' quel motore non ce la fa", () => {
    // A marker with a shrug after the dash re-opens the silence it exists to
    // close, so the reason has to be a sentence, not a word.
    for (const [op, d] of declared) {
      expect({ op, reason: d.reason.length > 25 }).toEqual({ op, reason: true });
      for (const [engine, why] of d.gaps) {
        expect({ op, engine, why: why.length > 25 }).toEqual({ op, engine, why: true });
      }
    }
  });

  test("i buchi sono quelli attesi, e non uno in piu'", () => {
    const found: string[] = [];
    for (const [op, d] of declared) {
      for (const engine of d.gaps.keys()) found.push(`${op} on ${engine}`);
    }
    expect(found.sort()).toEqual(PINNED_GAPS);
  });

  test("il banco e' rosso su almeno un motore: la parita' non e' raggiunta oggi", () => {
    // The bar this bench was written to meet. A parity check that finds nothing
    // on the day it lands is measuring nothing: the two nav drains are macOS
    // only, and that fact has to be visible here rather than implied.
    const engines = new Set<Engine>();
    for (const d of declared.values()) for (const e of d.gaps.keys()) engines.add(e);
    expect([...engines].sort()).toEqual(["webkitgtk", "webview2"]);
  });
});
