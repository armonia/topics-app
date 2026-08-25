/**
 * Le fixture non sono inventate: sono file veri, e per make, deno e cargo la
 * risposta attesa e' quella che ha dato lo STRUMENTO su questa macchina
 * (`make -pRrq`, `deno task`, `cargo metadata`). E' cosi' che e' saltato fuori
 * il binario implicito di Cargo, che nel TOML non e' scritto da nessuna parte.
 *
 * This detection is what the script runner lists — including the case where
 * a project has no runnable script at all.
 *
 * @covers PROCESS-01
 */
import { test, expect, describe } from "bun:test";
import {
  pickPackageManager, parsePackageScripts, parseMakefileTargets, parseTomlTables,
  parseCargoBins, parsePyprojectTasks, stripJsonComments, parseDenoTasks,
  parseComposerScripts, parseJustRecipes, parseTaskfileTasks,
  detectScripts, resolveScript, type Fs,
} from "./project-scripts";

// ── package.json ────────────────────────────────────────────────────────────

describe("package.json", () => {
  test("legge gli script e salta i valori che non sono comandi", () => {
    const s = parsePackageScripts('{"scripts":{"dev":"vite","x":{"a":1},"build":"tsc"}}');
    expect(s).toEqual([{ name: "dev", detail: "vite" }, { name: "build", detail: "tsc" }]);
  });

  test("un package.json rotto non fa cadere il rilevamento", () => {
    expect(parsePackageScripts("{ non json")).toEqual([]);
  });

  test("il gestore viene dal lock, non da un'ipotesi", () => {
    // `npm run` era cablato: su un progetto Bun o pnpm lanciava comunque npm.
    expect(pickPackageManager(f => f === "bun.lock")).toBe("bun");
    expect(pickPackageManager(f => f === "bun.lockb")).toBe("bun");
    expect(pickPackageManager(f => f === "pnpm-lock.yaml")).toBe("pnpm");
    expect(pickPackageManager(f => f === "yarn.lock")).toBe("yarn");
    expect(pickPackageManager(() => false)).toBe("npm");
  });

  test("bun vince su yarn quando ci sono tutt'e due i lock", () => {
    // Capita nei repo migrati a meta': il lock piu' specifico e' quello vero.
    expect(pickPackageManager(f => f === "bun.lock" || f === "yarn.lock")).toBe("bun");
  });
});

// ── Makefile ────────────────────────────────────────────────────────────────

// Makefile LETTERALE usato per la verifica.
const MAKEFILE = `# un commento
CC := gcc
FLAGS = -O2
.PHONY: test lint aiuto

aiuto:
\t@echo "aiuto"

test: build
\t@echo "test"

build:
\t@echo "build"

lint:
\t@echo "lint"

%.o: %.c
\t$(CC) -c $<

.SUFFIXES:

install:: build
\t@echo "install"

VAR_CON_DUE_PUNTI := non:un:target
`;

describe("Makefile", () => {
  test("gli stessi target che elenca make", () => {
    // `make -pRrq` su questo file: aiuto build install lint test
    // (piu' `%.o`, che e' una regola a modello, e `Makefile`, che e' il file).
    expect(parseMakefileTargets(MAKEFILE).sort()).toEqual(["aiuto", "build", "install", "lint", "test"]);
  });

  test("un assegnamento coi due punti non e' un target", () => {
    // `VAR := non:un:target` ha tre `:` e zero target.
    expect(parseMakefileTargets("VAR := non:un:target\n")).toEqual([]);
    expect(parseMakefileTargets("A ?= x:y\nB += z:w\nC = q:r\n")).toEqual([]);
  });

  test("le regole a modello e le direttive restano fuori", () => {
    expect(parseMakefileTargets("%.o: %.c\n\tcc\n")).toEqual([]);
    expect(parseMakefileTargets(".PHONY: a\n.SUFFIXES:\n")).toEqual([]);
  });

  test("il doppio due punti E' un target", () => {
    expect(parseMakefileTargets("install:: build\n\techo\n")).toEqual(["install"]);
  });

  test("una riga puo' dichiarare piu' target", () => {
    expect(parseMakefileTargets("a b c: dep\n\techo\n")).toEqual(["a", "b", "c"]);
  });

  test("le righe di ricetta (TAB) non si leggono come dichiarazioni", () => {
    // Dentro una ricetta ci possono essere due punti a bizzeffe.
    expect(parseMakefileTargets("t:\n\tssh host:/path\n\tfoo: bar\n")).toEqual(["t"]);
  });
});

// ── TOML ────────────────────────────────────────────────────────────────────

describe("parseTomlTables", () => {
  test("tabelle, tabelle-array e valori stringa", () => {
    const { tables, arrays } = parseTomlTables(`[package]
name = "esempio"

[[bin]]
name = "server"

[[bin]]
name = "cli"
`);
    expect(tables.get("package")?.get("name")).toBe("esempio");
    expect((arrays.get("bin") ?? []).map(b => b.get("name"))).toEqual(["server", "cli"]);
  });

  test("una tabella in linea si riduce al suo comando", () => {
    const { tables } = parseTomlTables(`[tool.pdm.scripts]
prova = { cmd = "pytest -q" }
`);
    expect(tables.get("tool.pdm.scripts")?.get("prova")).toBe("pytest -q");
  });

  test("i commenti non finiscono nei valori", () => {
    const { tables } = parseTomlTables(`[a]\nx = "uno"  # nota\n`);
    expect(tables.get("a")?.get("x")).toBe("uno");
  });
});

describe("Cargo.toml", () => {
  const CARGO = `[package]
name = "esempio"
version = "0.1.0"

[[bin]]
name = "server"
path = "src/bin/server.rs"

[[bin]]
name = "cli"
path = "src/bin/cli.rs"

[dependencies]
`;

  test("gli stessi binari che elenca cargo metadata", () => {
    // `cargo metadata` su questo progetto: cli, esempio, server.
    // `esempio` viene da src/main.rs e nel TOML NON e' scritto da nessuna parte:
    // un parser che legge solo `[[bin]]` lo perde.
    expect(parseCargoBins(CARGO, true).sort()).toEqual(["cli", "esempio", "server"]);
  });

  test("senza src/main.rs il binario implicito non esiste", () => {
    expect(parseCargoBins(CARGO, false).sort()).toEqual(["cli", "server"]);
  });

  test("una libreria senza binari non ne inventa", () => {
    expect(parseCargoBins('[package]\nname = "lib"\n', false)).toEqual([]);
  });
});

describe("pyproject.toml", () => {
  test("legge i quattro elenchi di task che sono davvero task", () => {
    const t = parsePyprojectTasks(`[tool.taskipy.tasks]
test = "pytest"

[tool.pdm.scripts]
_.env = "x"
lint = "ruff check"

[tool.poe.tasks]
fmt = "black ."

[tool.hatch.envs.default.scripts]
cov = "pytest --cov"
`);
    expect(t.map(x => [x.name, x.argv.join(" ")])).toEqual([
      ["test", "task test"],
      ["lint", "pdm run lint"],
      ["fmt", "poe fmt"],
      ["cov", "hatch run cov"],
    ]);
  });

  test("gli entry point del pacchetto NON sono task", () => {
    // `[project.scripts]` e `[tool.poetry.scripts]` esistono solo dopo
    // l'installazione: elencarli darebbe bottoni che falliscono.
    const t = parsePyprojectTasks(`[project.scripts]
mio = "pacchetto:main"

[tool.poetry.scripts]
altro = "pacchetto:altro"
`);
    expect(t).toEqual([]);
  });

  test("le chiavi di servizio di pdm si saltano", () => {
    expect(parsePyprojectTasks('[tool.pdm.scripts]\n_.env_file = ".env"\nok = "x"\n').map(x => x.name))
      .toEqual(["ok"]);
  });
});

// ── deno ────────────────────────────────────────────────────────────────────

describe("deno", () => {
  // deno.jsonc LETTERALE, con i commenti.
  const DENO = `{
  // i task del progetto
  "tasks": {
    "dev": "deno run --watch main.ts",
    "test": "deno test -A",
    "build": { "command": "deno compile main.ts", "description": "compila" }
  },
  "imports": { "std/": "https://deno.land/std/" }
}
`;

  test("gli stessi task che elenca `deno task`", () => {
    // `deno task` su questo file: dev, test, build — le due forme (stringa e
    // oggetto con `command`) elencate allo stesso modo.
    expect(parseDenoTasks(DENO)).toEqual([
      { name: "dev", detail: "deno run --watch main.ts" },
      { name: "test", detail: "deno test -A" },
      { name: "build", detail: "deno compile main.ts" },
    ]);
  });

  test("i commenti si tolgono, quelli DENTRO le stringhe no", () => {
    expect(JSON.parse(stripJsonComments('{"a":"http://x//y"} // fine')).a).toBe("http://x//y");
    expect(JSON.parse(stripJsonComments('{"a":1, /* blocco */ "b":2}')).b).toBe(2);
  });

  test("una virgola finale non fa cadere il file", () => {
    expect(JSON.parse(stripJsonComments('{"a":1,}')).a).toBe(1);
  });
});

// ── composer / just / Taskfile ──────────────────────────────────────────────

describe("composer", () => {
  test("uno script puo' essere una lista di comandi", () => {
    const s = parseComposerScripts('{"scripts":{"test":"phpunit","ci":["phpcs","phpunit"]}}');
    expect(s).toEqual([{ name: "test", detail: "phpunit" }, { name: "ci", detail: "phpcs && phpunit" }]);
  });
});

describe("justfile", () => {
  test("le ricette si', gli assegnamenti no", () => {
    expect(parseJustRecipes(`versione := "1.0"
# un commento

build:
    cargo build

test filtro="":
    cargo test {{filtro}}

@zitto:
    echo
`)).toEqual(["build", "test", "zitto"]);
  });

  test("il corpo indentato non produce ricette", () => {
    expect(parseJustRecipes("a:\n    b:\n    c: d\n")).toEqual(["a"]);
  });
});

describe("Taskfile", () => {
  test("i nomi al primo rientro sotto `tasks:`", () => {
    expect(parseTaskfileTasks(`version: '3'

tasks:
  build:
    cmds:
      - go build
  test:
    cmds:
      - go test ./...
`)).toEqual(["build", "test"]);
  });

  test("le chiavi DENTRO un task non sono task", () => {
    // `cmds`, `deps`, `desc` stanno piu' a fondo: contarli darebbe una lista
    // di bottoni che non esistono.
    const t = parseTaskfileTasks("tasks:\n  a:\n    desc: x\n    cmds:\n      - echo\n");
    expect(t).toEqual(["a"]);
  });

  test("una sezione successiva chiude l'elenco", () => {
    expect(parseTaskfileTasks("tasks:\n  a:\n    cmds: []\nvars:\n  b: 1\n")).toEqual(["a"]);
  });
});

// ── il rilevamento nel suo insieme ──────────────────────────────────────────

function finto(files: Record<string, string>): Fs {
  return {
    exists: rel => rel in files,
    read: rel => (rel in files ? files[rel] : null),
  };
}

describe("detectScripts", () => {
  test("una cartella senza manifest: nessuno script, e nessun manifest trovato", () => {
    const r = detectScripts("/x", finto({}));
    expect(r.scripts).toEqual([]);
    expect(r.found).toEqual([]);
  });

  test("dice QUALI manifest ha trovato: e' cio' che lo stato vuoto racconta", () => {
    const r = detectScripts("/x", finto({ "Cargo.toml": '[package]\nname = "q"\n' }));
    expect(r.found).toEqual(["Cargo.toml"]);
  });

  test("un progetto Rust ha i suoi comandi anche senza package.json", () => {
    const r = detectScripts("/x", finto({ "Cargo.toml": '[package]\nname = "q"\n', "src/main.rs": "" }));
    expect(r.scripts.map(s => s.name)).toEqual(["build", "test", "run"]);
    expect(r.scripts.find(s => s.name === "run")!.argv).toEqual(["cargo", "run"]);
  });

  test("con piu' binari si lancia quello scelto, non «il primo»", () => {
    const r = detectScripts("/x", finto({
      "Cargo.toml": '[package]\nname = "q"\n\n[[bin]]\nname = "a"\n\n[[bin]]\nname = "b"\n',
      "src/main.rs": "",
    }));
    expect(r.scripts.filter(s => s.name.startsWith("run ")).map(s => s.argv.join(" ")))
      .toEqual(["cargo run --bin q", "cargo run --bin a", "cargo run --bin b"]);
  });

  test("lo stesso nome in due manifest resta raggiungibile", () => {
    // `test` in package.json e `test` nel Makefile sono due comandi diversi:
    // e' il motivo per cui l'identita' e' `<manifest>#<nome>` e non il nome.
    const r = detectScripts("/x", finto({
      "package.json": '{"scripts":{"test":"vitest"}}',
      "Makefile": "test:\n\techo\n",
    }));
    expect(r.scripts.map(s => s.id)).toEqual(["package.json#test", "Makefile#test"]);
    expect(resolveScript(r, "Makefile#test")!.argv).toEqual(["make", "test"]);
    expect(resolveScript(r, "package.json#test")!.argv).toEqual(["npm", "run", "test"]);
  });

  test("il gestore di pacchetti entra nell'argv", () => {
    const r = detectScripts("/x", finto({ "package.json": '{"scripts":{"dev":"vite"}}', "bun.lock": "" }));
    expect(r.scripts[0].argv).toEqual(["bun", "run", "dev"]);
  });

  test("un progetto misto elenca tutto, ognuno col suo runner", () => {
    const r = detectScripts("/x", finto({
      "package.json": '{"scripts":{"dev":"vite"}}',
      "Makefile": "deploy:\n\techo\n",
      "justfile": "fmt:\n    cargo fmt\n",
      "deno.json": '{"tasks":{"check":"deno check"}}',
    }));
    expect(r.scripts.map(s => `${s.from}:${s.name}`)).toEqual([
      "package.json:dev", "Makefile:deploy", "deno.json:check", "justfile:fmt",
    ]);
    expect(r.found).toEqual(["package.json", "Makefile", "deno.json", "justfile"]);
  });

  test("per nome si risolve, per chi ha in mano solo quello", () => {
    const r = detectScripts("/x", finto({ "package.json": '{"scripts":{"dev":"vite"}}' }));
    expect(resolveScript(r, "dev")!.id).toBe("package.json#dev");
    expect(resolveScript(r, "inesistente")).toBeNull();
  });

  test("un manifest presente ma senza script conta come TROVATO", () => {
    // E' la differenza fra «non ho guardato» e «ho guardato e non c'e' niente»,
    // che e' esattamente cio' che lo stato vuoto deve saper dire.
    const r = detectScripts("/x", finto({ "package.json": '{"name":"x"}' }));
    expect(r.scripts).toEqual([]);
    expect(r.found).toEqual(["package.json"]);
  });
});
