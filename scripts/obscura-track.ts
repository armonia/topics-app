#!/usr/bin/env bun
/**
 * obscura-track — tiene le NOSTRE patch appoggiate all'upstream di Obscura,
 * invece di forkarlo.
 *
 * La strategia (decisa 2026-08-19, vedi spike/browser-engine-alt/EVALUATION.md):
 * non manteniamo un fork da 138k righe per portarci dietro 143 righe nostre.
 * Puntiamo al `main` upstream e ci appoggiamo sopra una pila di patch, in modo
 * da SCARICARE le migliorie degli altri a ogni aggiornamento e pagare solo per
 * ciò che abbiamo scritto noi.
 *
 * Il rischio di questo schema è UNO solo e va misurato, non sperato: che
 * upstream tocchi le stesse righe e la patch smetta di applicarsi. Questo
 * script lo trasforma in un check che esce non-zero, così lo scopriamo noi in
 * CI e non l'utente a build rotta.
 *
 * Ciclo di vita di una patch:
 *   1. `pending`  — scritta da noi, non ancora proposta upstream
 *   2. `proposed` — PR aperta (il campo `pr` porta l'URL)
 *   3. `landed`   — mergiata upstream: la patch va CANCELLATA, non tenuta.
 *                   Se resta, al prossimo aggiornamento fallisce da sola —
 *                   ed è giusto così: il fallimento è il promemoria.
 *
 * Comandi:
 *   check    verifica che ogni patch si applichi ancora sull'upstream corrente
 *   apply    clona/aggiorna upstream, applica la pila, lascia l'albero pronto
 *   build    apply + cargo build, produce il binario
 *   status   dove siamo rispetto a upstream e cosa abbiamo di nostro
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const REPO = "https://github.com/h4ckf0r0day/obscura.git";
const SPIKE = resolve(import.meta.dir, "../spike/browser-engine-alt");
const PATCHES = join(SPIKE, "patches");
const WORK = process.env.OBSCURA_WORKDIR ?? join(process.env.HOME!, ".cache/topics/obscura-src");

interface PatchMeta {
  file: string;
  /** pending | proposed | landed */
  status: string;
  /** URL della PR, quando status !== pending */
  pr?: string;
  why: string;
}

function readManifest(): PatchMeta[] {
  const f = join(PATCHES, "manifest.json");
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, "utf8")) as PatchMeta[];
}

function patchFiles(): string[] {
  if (!existsSync(PATCHES)) return [];
  return readdirSync(PATCHES).filter((f) => f.endsWith(".patch")).sort();
}

async function ensureUpstream(): Promise<void> {
  if (!existsSync(WORK)) {
    mkdirSync(join(WORK, ".."), { recursive: true });
    console.log(`clono upstream in ${WORK} ...`);
    await $`git clone --quiet ${REPO} ${WORK}`;
    return;
  }
  await $`git -C ${WORK} fetch --quiet origin main`.quiet();
  await $`git -C ${WORK} reset --hard --quiet origin/main`.quiet();
  await $`git -C ${WORK} clean -fdq`.quiet();
}

/** true se la patch si applica pulita sull'albero corrente. Non tocca nulla. */
async function applies(file: string): Promise<boolean> {
  const r = await $`git -C ${WORK} apply --check ${join(PATCHES, file)}`.quiet().nothrow();
  return r.exitCode === 0;
}

/** true se la patch è GIÀ dentro upstream (le nostre righe ci sono già). */
async function alreadyUpstream(file: string): Promise<boolean> {
  const r = await $`git -C ${WORK} apply --reverse --check ${join(PATCHES, file)}`.quiet().nothrow();
  return r.exitCode === 0;
}

async function cmdCheck(): Promise<number> {
  await ensureUpstream();
  const head = (await $`git -C ${WORK} rev-parse --short HEAD`.text()).trim();
  const meta = new Map(readManifest().map((m) => [m.file, m]));
  const files = patchFiles();
  if (files.length === 0) {
    console.log("nessuna patch: niente da verificare");
    return 0;
  }
  console.log(`upstream main @ ${head} — ${files.length} patch\n`);
  let bad = 0;
  for (const f of files) {
    const m = meta.get(f);
    const landed = await alreadyUpstream(f);
    const ok = await applies(f);
    if (landed) {
      // Il caso lieto: upstream ha preso il nostro lavoro. La patch va rimossa.
      console.log(`  LANDED   ${f}`);
      console.log(`           upstream contiene già queste righe → cancella la patch`);
      bad++;
    } else if (ok) {
      console.log(`  OK       ${f}  [${m?.status ?? "?"}]${m?.pr ? " " + m.pr : ""}`);
    } else {
      console.log(`  CONFLITTO ${f}`);
      console.log(`           upstream ha toccato le stesse righe: va riscritta`);
      bad++;
    }
  }
  console.log(bad === 0 ? "\ntutte le patch reggono" : `\n${bad} patch da sistemare`);
  return bad === 0 ? 0 : 1;
}

async function cmdApply(): Promise<number> {
  await ensureUpstream();
  for (const f of patchFiles()) {
    if (await alreadyUpstream(f)) {
      console.log(`salto ${f} (già upstream)`);
      continue;
    }
    const r = await $`git -C ${WORK} apply ${join(PATCHES, f)}`.nothrow();
    if (r.exitCode !== 0) {
      console.error(`FALLITA ${f} — l'albero resta parziale, in ${WORK}`);
      return 1;
    }
    console.log(`applicata ${f}`);
  }
  console.log(`\nalbero pronto: ${WORK}`);
  return 0;
}

async function cmdBuild(): Promise<number> {
  const rc = await cmdApply();
  if (rc !== 0) return rc;
  console.log("\ncargo build (la prima volta V8 compila da sorgente, ~15-20 min)...");
  const r = await $`cargo build --release -p obscura-cli --bins --features render`
    .cwd(WORK).nothrow();
  if (r.exitCode !== 0) return r.exitCode;
  console.log(`\nbinario: ${join(WORK, "target/release/obscura")}`);
  return 0;
}

async function cmdStatus(): Promise<number> {
  if (!existsSync(WORK)) {
    console.log("upstream non ancora clonato — lancia `apply` o `build`");
  } else {
    await $`git -C ${WORK} fetch --quiet origin main`.quiet().nothrow();
    const head = (await $`git -C ${WORK} rev-parse --short origin/main`.text()).trim();
    const when = (await $`git -C ${WORK} log -1 --format=%cd --date=short origin/main`.text()).trim();
    console.log(`upstream main @ ${head} (${when})`);
  }
  const meta = readManifest();
  if (meta.length === 0) { console.log("nessuna patch nostra"); return 0; }
  console.log(`\nle nostre ${meta.length} patch:`);
  for (const m of meta) {
    console.log(`  [${m.status}] ${m.file}${m.pr ? "  " + m.pr : ""}`);
    console.log(`         ${m.why}`);
  }
  return 0;
}

const cmd = process.argv[2] ?? "check";
const table: Record<string, () => Promise<number>> = {
  check: cmdCheck, apply: cmdApply, build: cmdBuild, status: cmdStatus,
};
const fn = table[cmd];
if (!fn) {
  console.error(`comando sconosciuto: ${cmd}\nusa: check | apply | build | status`);
  process.exit(2);
}
process.exit(await fn());
