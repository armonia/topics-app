/**
 * Quello che il runtime nativo NON aveva e la CLI sì.
 *
 * Un topic sul runtime nativo e una sessione `claude` nel terminale sembrano la
 * stessa cosa e non lo erano. Misurato il 02/09 sullo stesso prompt e nella
 * stessa cartella: la CLI rispondeva con Opus 5, 54 skill in elenco e le regole
 * globali dell'utente in contesto; il nativo con Sonnet, ZERO skill e nessuna
 * regola. Non è una sfumatura di qualità: è un altro agente.
 *
 * Qui stanno i due pezzi di contesto che mancavano. Il modello e il thinking
 * sono altrove (`providers/index.ts`, `native/agent-loop.ts`) perché sono
 * parametri della richiesta, non testo.
 *
 * PERCHÉ SOLO PER IL NATIVO. `claude` carica `~/.claude/CLAUDE.md` e l'elenco
 * delle skill da sé: iniettarglieli di nuovo raddoppierebbe lo stesso testo in
 * un prompt che paghiamo a token. Chi chiama deve passare `native: true`.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { skillDirs } from "./slash-command-source";

/** Oltre questo, un file di regole è un allegato, non un'istruzione. */
const MAX_RULES_BYTES = 64 * 1024;
/** Come `skillListingMaxDescChars` di Claude Code: l'elenco costa a ogni turno. */
const MAX_DESC_CHARS = 180;

/**
 * `~/.claude/CLAUDE.md`, con una passata di `@percorso` espansi.
 *
 * L'espansione non è un lusso: nel file di Attilio le regole sui tool arrivano
 * TUTTE da un `@~/.claude/jarvis/agents/_shared/TOOLS.md`, quindi senza questa
 * riga il blocco che iniettiamo direbbe metà delle cose e nessuno saprebbe
 * quale metà. Un livello solo: un import che ne importa un altro si ferma lì —
 * la profondità arbitraria è un modo per farsi entrare in contesto un albero
 * senza volerlo.
 */
export function readUserRules(home = homedir()): string | null {
  const file = join(home, ".claude", "CLAUDE.md");
  if (!existsSync(file)) return null;
  try {
    if (statSync(file).size > MAX_RULES_BYTES) return null;
    const raw = readFileSync(file, "utf-8");
    return raw.replace(/^@(\S+)$/gm, (intero, p: string) => {
      const abs = p.startsWith("~/") ? join(home, p.slice(2)) : resolve(dirname(file), p);
      try {
        if (!existsSync(abs) || statSync(abs).size > MAX_RULES_BYTES) return intero;
        return readFileSync(abs, "utf-8");
      } catch { return intero; }
    });
  } catch { return null; }
}

export interface SkillEntry { name: string; description: string }

/**
 * La descrizione dal frontmatter, anche quando e' un blocco YAML.
 *
 * `description: |` seguito da righe rientrate e' valido quanto la forma su una
 * riga, e sette skill su quaranta lo usano: con la sola regex a una riga la
 * descrizione diventava letteralmente «|» — un elenco che dice il nome e niente,
 * cioe' un elenco che il modello non puo' usare per scegliere.
 */
export function descrizioneDaFrontmatter(testa: string): string {
  const m = /^description:[ \t]*(.*)$/m.exec(testa);
  if (!m) return "";
  const primo = m[1].trim();
  if (primo && primo !== "|" && primo !== ">" && primo !== "|-" && primo !== ">-") {
    return primo.replace(/^["']|["']$/g, "");
  }
  const resto = testa.slice(m.index + m[0].length).split("\n").slice(1);
  const righe: string[] = [];
  for (const r of resto) {
    if (!r.trim()) { if (righe.length) break; continue; }
    if (!/^\s/.test(r)) break;            // finito il blocco rientrato
    righe.push(r.trim());
  }
  return righe.join(" ");
}

/**
 * Nome e descrizione di ogni skill installata, presi dal frontmatter di
 * `SKILL.md`. Il corpo NON entra: è il patto del meccanismo — l'elenco sta in
 * contesto sempre, le istruzioni si caricano solo quando serve (tool `skill`).
 */
export function listSkills(home = homedir()): SkillEntry[] {
  const out: SkillEntry[] = [];
  // Le cartelle si guardano DIRETTE, non passando da `listSlashCommandFiles`:
  // quella deduplica per nome contro i comandi, e cinque skill che si chiamano
  // come un comando (`commit`, `recap`, `vai`…) sparivano dall'elenco pur
  // essendo installate.
  const visti = new Set<string>();
  const files: Array<{ name: string; file: string }> = [];
  for (const dir of skillDirs(home)) {
    let voci: string[] = [];
    try { voci = readdirSync(dir); } catch { continue; }
    for (const nome of voci) {
      if (visti.has(nome)) continue;
      const md = join(dir, nome, "SKILL.md");
      if (!existsSync(md)) continue;
      visti.add(nome);
      files.push({ name: nome, file: md });
    }
  }
  for (const f of files) {
    let description = "";
    try {
      description = descrizioneDaFrontmatter(readFileSync(f.file, "utf-8").slice(0, 8192));
    } catch { /* skill senza frontmatter leggibile: resta il nome */ }
    if (description.length > MAX_DESC_CHARS) description = description.slice(0, MAX_DESC_CHARS) + "…";
    out.push({ name: f.name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Il blocco di sistema che presenta l'elenco. Vuoto = nessuna skill installata. */
export function skillsBlock(home = homedir()): string {
  const skills = listSkills(home);
  if (skills.length === 0) return "";
  const righe = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return [
    "## Skill disponibili",
    "",
    "Procedure già scritte per compiti ricorrenti. Quando il compito corrisponde a una",
    "di queste, chiama il tool `skill` con il suo nome PRIMA di improvvisare: quello che",
    "torna sono le istruzioni da seguire al posto del tuo approccio di default.",
    "Se l'utente scrive `/<nome>`, è una richiesta esplicita di invocarla.",
    "",
    ...righe,
  ].join("\n");
}

/**
 * L'EFFORT DIVENTA UN BUDGET DI THINKING.
 *
 * Su `claude` l'effort è un flag della CLI; sull'API è `thinking.budget_tokens`,
 * e il runtime nativo non lo mandava affatto — quindi lo slider dell'effort, che
 * la UI mostra su ogni topic, sul nativo non spostava niente.
 *
 * `low` = niente thinking (non «poco»): sotto i 1024 token l'API rifiuta, e un
 * budget simbolico costerebbe latenza per un ragionamento che non ci sta.
 *
 * Il budget deve stare SOTTO `max_tokens`, altrimenti la richiesta è invalida:
 * chi chiama alza il tetto o taglia il budget, e la scelta sta in `agent-loop`
 * perché è lì che si conosce `max_tokens` di quel turno.
 */
export const THINKING_BUDGET: Record<string, number> = {
  low: 0,
  medium: 4_000,
  high: 10_000,
  xhigh: 24_000,
  max: 32_000,
};

export function thinkingBudgetFor(effort: string | null | undefined): number {
  return THINKING_BUDGET[(effort ?? "").trim().toLowerCase()] ?? 0;
}
