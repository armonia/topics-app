/**
 * Product identity and third-party notices must describe the app that ships today.
 *
 * These two files rot in a way nothing else catches: a manifest description and a
 * license notice are never executed, never typechecked and never rendered in a
 * test, so "Companion app for OpenClaw" survived the pivot to a CLI-agent desktop
 * workspace, and the notices kept crediting Electron a whole major version after
 * the Electron shell was archived (v2.0.0, `electron-archive` branch). A stale
 * notice is not cosmetic: it names software we do not ship and omits the one
 * library whose license actually asks for a notice (WebKitGTK, LGPL, linked
 * dynamically on Linux).
 *
 * `client/public/*` are the SOURCES, `public/*` are the copies the client build
 * writes. Editing one of a pair silently ships the other, so the pair equality is
 * asserted on bytes, not on parsed JSON.
  * @covers RELEASE-05
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NOTICES = join(ROOT, "THIRD-PARTY-NOTICES.md");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const bytes = (rel: string) => readFileSync(join(ROOT, rel));

const MANIFESTS = [
  "public/manifest.json",
  "public/manifest-dev.json",
  "client/public/manifest.json",
  "client/public/manifest-dev.json",
] as const;

/** The dead positioning, in every wording it was ever written in. */
const STALE_IDENTITY = /companion (app )?for OpenClaw/i;

/**
 * npm ids are lowercase; this shape is what separates a package name from the
 * other things that live in backticks here (env vars are upper case, tag globs
 * carry a `*`, config keys carry a capital or a slash without a scope).
 */
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Backticked words that are `AI_PROVIDER` VALUES, not packages: the services
 * section names the modes a reader sets in `.env`, and `claude-code`, `codex`,
 * `claude`, `openai` and `openclaw` all have the exact shape of an npm id.
 * Anything else in backticks is claimed to be a dependency and has to be one.
 *
 * Hand-writing the pair {claude, openclaw} was a landmine, not a shortcut: the
 * services section credited only Anthropic, and the correct fix (naming OpenAI
 * and the two CLI modes, none of which is a declared package) turned this test
 * red on an edit that made the document TRUE. Reading the list out of the code
 * means a new provider carries its own exemption.
 *
 * Parsed, not imported: `server/providers/index.ts` reaches
 * `services/app-settings` -> `getDatabase()`, and a doc test must never open
 * the real SQLite database. Same trick, same reason, as product-docs.test.ts.
 */
function providerModes(): Set<string> {
  const src = read("server/providers/index.ts");
  const block = src.match(/const PROVIDER_PREFERENCE_ORDER\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    // Thrown, not `expect`ed: this runs at module load, where a failed
    // assertion has no test to attach to and would surface as a crash with no
    // name on it.
    throw new Error("PROVIDER_PREFERENCE_ORDER no longer parses out of server/providers/index.ts");
  }
  const names = [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (names.length < 2) {
    throw new Error(`PROVIDER_PREFERENCE_ORDER parsed to ${names.length} name(s): the parse is wrong`);
  }
  return new Set(names);
}

const NOT_PACKAGES = providerModes();

function declaredPackages(): Set<string> {
  const names = new Set<string>();
  for (const rel of ["package.json", "client/package.json"]) {
    const pkg = JSON.parse(read(rel)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const n of Object.keys(pkg.dependencies ?? {})) names.add(n);
    for (const n of Object.keys(pkg.devDependencies ?? {})) names.add(n);
  }
  return names;
}

/** Backticked package names in `markdown` that no package.json declares. */
function undeclaredBackticks(markdown: string, declared: Set<string>): string[] {
  const found = new Set<string>();
  for (const [, token] of markdown.matchAll(/`([^`\n]+)`/g)) {
    if (!NPM_NAME.test(token)) continue;
    if (NOT_PACKAGES.has(token)) continue;
    if (!declared.has(token)) found.add(token);
  }
  return [...found].sort();
}

/** The compiled binaries in the installers. Their own names are not components. */
const SIDECARS = ["topics-server", "pty-bridge", "webrtc-bridge"] as const;

/** Any license token a notice would legitimately use to discharge the credit. */
const LICENSE = /\b(MIT|Apache-2\.0|BSD[- ][23][- ]Clause|LGPL[\w.+-]*|GPL[\w.+-]*|MPL-2\.0|ISC|Zlib|CC0)\b/;

/** The bullet that describes one sidecar, by the bold name it opens with. */
function sidecarBullet(markdown: string, name: string): string {
  const line = markdown.split("\n").find((l) => l.startsWith(`- **${name}**`));
  expect(line, `no sidecar bullet for ${name}`).toBeTruthy();
  return line!;
}

/**
 * Bold names inside a bullet with no license in the span that is theirs.
 *
 * The span ends at the next bold name on purpose: `**zune-jpeg**, and Cisco's
 * **OpenH264** (BSD-2-Clause)` reads as licensed to any character-window sieve,
 * and that is precisely how an unlicensed credit survived review.
 */
function unlicensedComponents(bullet: string): string[] {
  const parts = bullet.split("**"); // even index = plain text, odd = bold name
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    if ((SIDECARS as readonly string[]).includes(name)) continue;
    if (!LICENSE.test(parts[i + 1] ?? "")) out.push(name);
  }
  return out;
}

/** Sentences that credit Electron without saying it is the archived shell. */
function presentTenseElectron(markdown: string): string[] {
  return markdown
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => /\bElectron\b/.test(s))
    .filter((s) => !/\b(legacy|archived|no longer|older|previous|until v1)\b/i.test(s));
}

describe("product identity", () => {
  it("no manifest still calls the app a companion for OpenClaw", () => {
    const stale = MANIFESTS.filter((rel) => STALE_IDENTITY.test(read(rel)));
    expect(stale).toEqual([]);
  });

  it("the root package.json description does not either", () => {
    const { description } = JSON.parse(read("package.json")) as { description: string };
    expect(description).not.toMatch(STALE_IDENTITY);
    // A description that lost the old line but says nothing is not a fix.
    expect(description.length).toBeGreaterThan(30);
  });

  it("every manifest description mentions the agents the app is for", () => {
    for (const rel of MANIFESTS) {
      const { description } = JSON.parse(read(rel)) as { description: string };
      expect(description).toMatch(/agents?/i);
    }
  });

  it("public/ manifests are byte-identical to their client/public/ sources", () => {
    for (const name of ["manifest.json", "manifest-dev.json"]) {
      // String compare first: a mismatch prints the diff instead of "false".
      expect(read(`public/${name}`)).toBe(read(`client/public/${name}`));
      expect(bytes(`public/${name}`).equals(bytes(`client/public/${name}`))).toBe(true);
    }
  });

  it("the identity sieve is not vacuous", () => {
    expect(STALE_IDENTITY.test('"description": "AI Chat companion for OpenClaw"')).toBe(true);
    expect(STALE_IDENTITY.test("Companion app for OpenClaw, with project context")).toBe(true);
  });
});

describe("third-party notices", () => {
  const md = readFileSync(NOTICES, "utf8");

  it("names the shell that ships and the webview per platform", () => {
    expect(md).toContain("Tauri");
    expect(md).toContain("WKWebView");
    expect(md).toContain("WebView2");
    // The shell's own LGPL obligation: dynamically linked, Linux only.
    expect(md).toContain("WebKitGTK");
    expect(md).toMatch(/WebKitGTK[\s\S]{0,200}LGPL/);
  });

  it("every third-party component credited in a sidecar bullet carries a license", () => {
    // `zune-jpeg` shipped named and unlicensed. A "within N characters" window
    // would not have caught it: the NEXT component's `(BSD-2-Clause)` sits 40
    // characters away and reads as if it covered both. So the window is the
    // text up to the next bold name, which is the only span that belongs to
    // this component.
    for (const name of SIDECARS) {
      expect(unlicensedComponents(sidecarBullet(md, name)), `${name} credits a component with no license`).toEqual([]);
    }
  });

  it("the license sieve can fail", () => {
    // Exactly the shape that shipped: two licensed neighbours around a name
    // with nothing of its own.
    expect(
      unlicensedComponents("- **webrtc-bridge**: built on **webrtc-rs** (MIT or Apache-2.0), **zune-jpeg**, and **OpenH264** (BSD-2-Clause)."),
    ).toEqual(["zune-jpeg"]);
  });

  it("names the LGPL engine the compiled server carries on EVERY platform", () => {
    // `scripts/build-server-sidecar.sh` builds the `topics-server` sidecar with
    // `bun build --compile`, and that statically embeds Bun's JS engine —
    // JavaScriptCore, WebKit's, LGPL — inside the binary shipped in every
    // installer. Measured on the universal sidecar in the tree: 1649 hits for
    // "JavaScriptCore" in `strings`. So calling WebKitGTK "the one bundled-code
    // notice obligation" was wrong twice over: that one is Linux-only and
    // linked dynamically, this one ships on macOS and Windows too and is
    // linked statically, which is the case the LGPL is strictest about.
    expect(read("scripts/build-server-sidecar.sh"), "the sidecar is no longer a --compile binary: revisit the JSC notice").toContain(
      "--compile",
    );
    expect(md).toContain("JavaScriptCore");
    expect(md).toMatch(/JavaScriptCore[\s\S]{0,300}LGPL/);
    expect(md, "WebKitGTK is still called the only bundled-code obligation").not.toMatch(
      /the one bundled-code notice obligation/i,
    );
  });

  it("names the three compiled sidecars", () => {
    for (const sidecar of SIDECARS) {
      expect(md).toContain(sidecar);
    }
  });

  it("does not claim the app bundles Electron today", () => {
    expect(presentTenseElectron(md)).toEqual([]);
    // ...but the legacy installers on the Releases page still do, and saying so
    // is the honest half of this fix.
    expect(md).toMatch(/\blegacy\b[\s\S]{0,200}\bElectron\b/i);
  });

  it("credits no package that is not in a package.json", () => {
    expect(undeclaredBackticks(md, declaredPackages())).toEqual([]);
  });

  it("both sieves catch the text this file replaced", () => {
    // The exact prose that was in THIRD-PARTY-NOTICES.md before the rewrite.
    const old = [
      "The desktop application embeds:",
      "- **Electron** and the bundled **Chromium** and **Node.js** runtimes.",
      "- `electron-updater` / `electron-builder` are MIT.",
    ].join("\n");
    expect(presentTenseElectron(old)).toHaveLength(1);
    expect(undeclaredBackticks(old, declaredPackages())).toEqual([
      "electron-builder",
      "electron-updater",
    ]);
  });

  it("the package sieve ignores what is not a package name", () => {
    // Env vars, tag globs and config keys share the backticks with real ids.
    const noise = "`ANTHROPIC_API_KEY` `v*` `bundle.externalBin` `claude` `openclaw`";
    expect(undeclaredBackticks(noise, declaredPackages())).toEqual([]);
    // And it does not stop at the first line of a list.
    expect(undeclaredBackticks("- `zod`\n- `not-a-real-package`", declaredPackages())).toEqual([
      "not-a-real-package",
    ]);
  });

  it("naming any AI_PROVIDER mode in the services section is not a failure", () => {
    // The regression this guards: the exemption used to be the literal pair
    // {claude, openclaw}, so writing the services section honestly — it named
    // Anthropic alone while the app also drives `codex`, `claude-code` and the
    // OpenAI API — failed the suite. None of the five is a declared package,
    // and none of them is meant to be.
    const declared = declaredPackages();
    for (const mode of NOT_PACKAGES) {
      expect(declared.has(mode), `${mode} is a real dependency now: drop it from the exemption`).toBe(false);
      expect(
        undeclaredBackticks(`used in \`${mode}\` mode`, declared),
        `naming the ${mode} provider in backticks must not read as a package claim`,
      ).toEqual([]);
    }
    // The exemption is the provider list and nothing wider: a name that merely
    // looks like one is still a package claim.
    expect(undeclaredBackticks("`claude-codex` `openai-sdk`", declared)).toEqual([
      "claude-codex",
      "openai-sdk",
    ]);
  });

  it("the services section names every backend the app can actually reach", () => {
    // A notices file that credits one vendor while the app ships four backends
    // is not a stale detail: it is the section a lawyer and a privacy-minded
    // reader both stop on. `claude-code` and `codex` reach Anthropic and OpenAI
    // under the user's own subscription, which is exactly the fact the README
    // leads with.
    const services = md.split(/^## /m).find((s) => s.startsWith("Third-party services"));
    expect(services, "the notices lost their Third-party services section").toBeTruthy();
    for (const vendor of ["Anthropic", "OpenAI", "OpenClaw"]) {
      expect(services!, `the services section never mentions ${vendor}`).toContain(vendor);
    }
    // "the primary backend" outlived the pivot to CLI-first: an API key is now
    // one of four ways in, and the default on a fresh clone is none of them.
    expect(services!, "a single backend is still being called the primary one").not.toMatch(
      /primary backend/i,
    );
  });
});
