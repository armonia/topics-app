#!/usr/bin/env bun
// LA PROVA che la quota di core si rilegge a metà sessione.
//
// Il dubbio legittimo su questa feature è: «l'ambiente di un processo si scrive
// una volta sola, quindi come fa un agente già partito a cambiare recinto?».
// Questo script lo mostra invece di raccontarlo, e usa le funzioni VERE del
// server (`refreshLiveJobQuotas`, `installQuotaShims`), non una loro imitazione.
//
// La scena: un finto `cargo` che stampa il proprio `CARGO_BUILD_JOBS`, eseguito
// tre volte attraverso lo shim con UN AMBIENTE SEMPRE UGUALE — quello congelato
// allo spawn. In mezzo cambia solo il roster degli agenti vivi sul DB. Se il
// numero stampato cambia, la rilettura c'è; se resta quello congelato, non c'è.
//
// È anche una BARRA: le tre attese sono asserzioni, e lo script esce non-zero
// se una sola non torna. `bun run scripts/job-quota-live-demo.ts`
//
// Il log finisce in JSON accanto al video (`scripts/job-quota-live-video.mjs`).

import { Database } from "bun:sqlite";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeJobQuota,
  installQuotaShims,
  quotaChannelDir,
  readLiveQuota,
  refreshLiveJobQuotas,
} from "../server/services/agent-job-quota";

const RADICE = mkdtempSync(join(os.tmpdir(), "job-quota-demo-"));
process.env.TOPICS_JOB_QUOTA_DIR = join(RADICE, "canale");

const CORES = Math.max(1, os.cpus().length);
const SESSIONE = "topic:demo";
const t0 = Date.now();
const righe: Array<{ ms: number; testo: string; tipo: string }> = [];

function riga(testo: string, tipo: "info" | "atto" | "misura" | "ok" | "ko" = "info") {
  const ms = Date.now() - t0;
  righe.push({ ms, testo, tipo });
  const colore = { info: "", atto: "\x1b[36m", misura: "\x1b[33m", ok: "\x1b[32m", ko: "\x1b[31m" }[tipo];
  console.log(`${colore}[${String(ms).padStart(5)}ms] ${testo}\x1b[0m`);
}

// ---- Il DB: le colonne che la quota legge davvero (migration 001/026/065/090).
const db = new Database(":memory:");
db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
db.run(`CREATE TABLE tasks (
  id TEXT PRIMARY KEY, assigned_topic_id TEXT, dispatch_weight TEXT,
  status TEXT, dispatch_state TEXT, archived INTEGER NOT NULL DEFAULT 0)`);
db.run(`CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idx INTEGER NOT NULL, topic_id TEXT, state TEXT)`);
db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER)`);
db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)").run();

function nasce(n: number, sessionKey = `topic:agente-${n}`) {
  db.prepare("INSERT INTO topics (id, session_key) VALUES (?,?)").run(`t${n}`, sessionKey);
  db.prepare(
    "INSERT INTO tasks (id, assigned_topic_id, status, dispatch_state, archived) VALUES (?,?,'in_progress','working',0)",
  ).run(`k${n}`, `t${n}`);
}
function finisce(n: number) {
  db.prepare("UPDATE tasks SET status='review', dispatch_state=NULL WHERE id=?").run(`k${n}`);
}

// ---- Il finto `cargo`: dice solo quanti job gli hanno dato.
const finta = join(RADICE, "toolchain");
mkdirSync(finta, { recursive: true });
writeFileSync(join(finta, "cargo"), '#!/bin/sh\necho "${CARGO_BUILD_JOBS:-nessun recinto}"\n', { mode: 0o755 });

riga(`macchina: ${CORES} core logici · tetto "Agent in parallelo": 4 (fisso)`, "info");
riga("l'agente di questa scena è `topic:demo`; gli altri sono i suoi compagni di macchina", "info");

// ---- Lo spawn: qui, e SOLO qui, si scrive l'ambiente del processo figlio.
nasce(0, SESSIONE);
for (let n = 1; n <= 3; n++) nasce(n);
refreshLiveJobQuotas(db);
const congelato = readLiveQuota(SESSIONE)!;
riga(`SPAWN con 4 agenti vivi → quota ${congelato}. Da adesso l'ambiente del figlio NON cambia più.`, "atto");

const shim = installQuotaShims(SESSIONE, finta);
if (!shim) throw new Error("shim non installato");
riga(`shim installati (${shim.installed.join(", ")}) in testa al PATH del figlio`, "atto");

const AMBIENTE = { ...process.env, CARGO_BUILD_JOBS: String(congelato), MAKEFLAGS: `-j${congelato}` };
const cargo = join(quotaChannelDir(SESSIONE), "bin", "cargo");
const compila = () => execFileSync(cargo, ["build"], { env: AMBIENTE, encoding: "utf8" }).trim();

const atteso4 = computeJobQuota({ cores: CORES, cap: 4, weight: null, peers: 4 });
const expectedOnly = Math.max(1, CORES - 1);
const atteso6 = computeJobQuota({ cores: CORES, cap: 4, weight: null, peers: 6 });

const prove: Array<{ nome: string; atteso: number; letto: number }> = [];

riga(`cargo build  (ambiente congelato: CARGO_BUILD_JOBS=${congelato})`, "atto");
prove.push({ nome: "in quattro", atteso: atteso4, letto: Number(compila()) });
riga(`  → -j${prove[0]!.letto}  ·  in quattro sulla macchina, un quarto a testa`, "misura");

// ---- A METÀ SESSIONE: i compagni finiscono. Nessuno respawna niente.
for (let n = 1; n <= 3; n++) finisce(n);
riga("i tre compagni consegnano. Il processo dell'agente resta lo stesso, vivo, con lo stesso ambiente.", "atto");
const scritti = refreshLiveJobQuotas(db);
riga(`giro del dispatcher (ogni 10s in produzione): ${scritti} file riscritto → quota ${readLiveQuota(SESSIONE)}`, "atto");

riga(`cargo build  (ambiente ANCORA congelato: CARGO_BUILD_JOBS=${congelato})`, "atto");
prove.push({ nome: "rimasto solo", atteso: expectedOnly, letto: Number(compila()) });
riga(`  → -j${prove[1]!.letto}  ·  da solo su ${CORES} core, meno quello dell'umano`, "misura");

// ---- E si richiude: arrivano in cinque.
for (let n = 4; n <= 8; n++) nasce(n);
refreshLiveJobQuotas(db);
riga(`arrivano altri cinque agenti → quota ${readLiveQuota(SESSIONE)}`, "atto");
riga(`cargo build  (ambiente sempre lo stesso: CARGO_BUILD_JOBS=${congelato})`, "atto");
prove.push({ nome: "in sei", atteso: atteso6, letto: Number(compila()) });
riga(`  → -j${prove[2]!.letto}  ·  il recinto si richiude da sé`, "misura");

// ---- La barra.
let rotte = 0;
for (const p of prove) {
  if (p.letto === p.atteso) riga(`OK  ${p.nome}: -j${p.letto} (atteso -j${p.atteso})`, "ok");
  else { rotte++; riga(`KO  ${p.nome}: -j${p.letto}, atteso -j${p.atteso}`, "ko"); }
}
if (prove[0]!.letto === prove[1]!.letto && prove[1]!.letto === prove[2]!.letto) {
  rotte++;
  riga("KO  tre numeri uguali: il recinto è ancora congelato allo spawn", "ko");
}

const OUT = process.env.JOB_QUOTA_DEMO_OUT || "/tmp/job-quota-live/log.json";
mkdirSync(join(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify({ cores: CORES, congelato, righe }, null, 2));
riga(`log in ${OUT}`, "info");

if (rotte) { console.error(`\n${rotte} attesa/e non tornata/e.`); process.exit(1); }
console.log("\nLa quota si rilegge a metà sessione: stesso processo, stesso ambiente, tre recinti diversi.");
