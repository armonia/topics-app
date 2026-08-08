import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { warnDeprecatedEnv } from './env-alias';
import {
  settingClaudeEffort,
  settingCodexReasoningEffort,
  resolveOutputLanguage,
} from '../services/app-settings';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../shared/effort';
import type { OutputLanguage } from '../../shared/types';

/**
 * La riga che dice al modello in che lingua rispondere. UNA riga, e sempre la
 * stessa: è l'unico posto in cui la scelta dell'utente diventa testo per il
 * modello, e le tre bocche che parlano — il prompt di sistema di chat/terminale
 * qui sotto, il kickoff della board (`services/task-dispatcher.ts`) e il blocco
 * sintetico del contesto (`context/assemble.ts`) — la chiedono tutte a questa
 * funzione invece di scriversela per conto proprio. È il motivo per cui prima
 * la lingua dell'agente non era la scelta di nessuno: in chat era inglese
 * perché così era scritta la costante, sulla board italiano perché così era
 * scritto il kickoff, e il selettore non spostava né l'uno né l'altro.
 *
 * `auto` torna stringa vuota — nessuna direttiva. NON è una svista: quando
 * l'utente non ha scelto una lingua, inventargliene una sarebbe peggio che
 * lasciare il modello libero di rispondere nella lingua in cui gli si parla.
 * Chi chiama deve quindi controllare che la stringa non sia vuota prima di
 * concatenarla, altrimenti si ritrova una riga bianca nel prompt.
 */
export function languageDirective(lang: OutputLanguage = resolveOutputLanguage()): string {
  switch (lang) {
    case 'it':
      return 'Rispondi sempre in italiano, qualunque sia la lingua della richiesta.';
    case 'en':
      return 'Always answer in English, whatever language the request is written in.';
    default:
      return '';
  }
}

/**
 * System-prompt fragment appended to every Topics-launched Claude session
 * (interactive PTY terminals AND the headless chat provider).
 *
 * It steers the agent to drive long-running processes THROUGH Topics — where
 * they're tracked, shown in the Processes panel with live logs/ports/stop, and
 * survive reloads — instead of backgrounding them in the bare shell. The Topics
 * MCP (`mcp__topics__*`) is already wired into every session. Kept short and
 * additive: it nudges; the user's project CLAUDE.md still governs everything else.
 *
 * Note: even when the agent ignores this and starts a server with a bare shell
 * command, Topics auto-detects the listening process under the session's PTY and
 * registers it (see the process detector in routes/processes.ts) — so this prompt
 * is the preferred path, not the only safety net.
 */
const TOPICS_AGENT_PROCESS_PROMPT = [
  'You are running inside Topics, a workspace that tracks long-running processes.',
  'To start a long-running dev server, watcher, or build process, ALWAYS prefer the',
  'Topics MCP tool `mcp__topics__run_script` (it runs a script declared in the',
  "project's package.json) instead of backgrounding the command in the shell.",
  'Processes started this way appear in the Topics Processes panel with live logs,',
  'status, port links, and a stop button, and are managed across restarts.',
  'Use `mcp__topics__list_processes` to see what is running, `mcp__topics__read_process_output`',
  'to read a process’s logs, and `mcp__topics__stop_process` to stop one.',
  'Only fall back to a bare shell command when no matching package.json script exists',
  'or the command is a short one-off.',
].join(' ');

/**
 * Il prompt di sistema completo per una sessione lanciata da Topics: la parte
 * sui processi qui sopra, più la direttiva di lingua quando ce n'è una.
 *
 * Era una COSTANTE, e questo era il difetto: una costante non può sapere in che
 * lingua l'utente vuole essere servito, quindi la risposta era sempre quella in
 * cui era scritta la costante. I due chiamanti — `providers/claude-code.ts`
 * (chat headless) e `routes/terminal.ts` (PTY interattivo) — sono gli stessi di
 * prima: passare da funzione qui copre entrambe le superfici in un colpo, che è
 * esattamente il motivo per cui questo frammento vive in un file condiviso.
 *
 * La lingua si risolve al momento della chiamata, non all'import: cambiare
 * lingua in Impostazioni vale dalla sessione successiva senza riavviare il
 * server (stesso contratto di `resolveClaudeCodeModel`).
 */
export function topicsAgentSystemPrompt(lang: OutputLanguage = resolveOutputLanguage()): string {
  const directive = languageDirective(lang);
  return directive ? `${TOPICS_AGENT_PROCESS_PROMPT} ${directive}` : TOPICS_AGENT_PROCESS_PROMPT;
}

/**
 * Effort tier for Topics-launched Claude sessions — the "ultracode" tier in the
 * TUI is just the top effort (`xhigh`) plus dynamic workflows.
 *
 * `claude` resolves effort from `--effort` flag → `CLAUDE_EFFORT` env →
 * settings.json `effortLevel`. Topics spawns `claude` directly: under launchd
 * the server's env carries no `CLAUDE_EFFORT`, and the user's global
 * `effortLevel` defaults to "low", so without help every Topics session starts
 * at low effort — unlike a Warp shell, which exports `CLAUDE_EFFORT=xhigh` and
 * therefore "starts in ultracode". We pass `--effort` explicitly so the tier is
 * deterministic and independent of the spawn environment.
 *
 * Resolution order: `TOPICS_CLAUDE_EFFORT` (Topics override; "off"/"none"/
 * "default" disables and lets the CLI's own settings win) → `CLAUDE_EFFORT`
 * (mirror the shell when present) → `"xhigh"` (the Warp default). Returns null
 * when disabled or the value is not a recognised tier, in which case no flag is
 * passed.
 */
const VALID_CLAUDE_EFFORTS = new Set<string>(EFFORT_TIERS);

/**
 * L'effort scelto per un topic (`topics.effort`, migration 033), da dare in pasto
 * a `resolveClaudeEffort`.
 *
 * Esiste perché il percorso PTY interattivo chiamava `resolveClaudeEffort()` NUDA,
 * saltando il primo ramo della catena: il selettore del model picker era quindi
 * morto sul terminale — un topic messo a "medium" apriva comunque un PTY a xhigh,
 * mentre la stessa topic in chat rispettava la scelta. Due superfici, due effort,
 * un solo selettore. Estratta qui invece che inline nello spawn così è
 * verificabile senza far partire un PTY.
 *
 * Best-effort: un topic assente, un DB vecchio o una query che fallisce tornano
 * `null` e fanno cadere sul default globale — questa è un'informazione, non deve
 * poter impedire l'apertura di un terminale.
 */
export function topicEffortFor(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  topicId: string | null | undefined,
): string | null {
  if (!topicId) return null;
  try {
    const row = db.prepare("SELECT effort FROM topics WHERE id = ?").get(topicId) as
      | { effort?: string | null }
      | undefined;
    return row?.effort ?? null;
  } catch {
    return null;
  }
}

export function resolveClaudeEffort(topicOverride?: string | null): string | null {
  // A valid per-topic override (migration 033, set via the model-picker's
  // effort selector) wins over every env-based default. Anything else
  // (null/empty/unknown tier) falls through to the global resolution below,
  // so clearing the topic override restores the env default.
  const perTopic = (topicOverride ?? '').trim().toLowerCase();
  if (perTopic && VALID_CLAUDE_EFFORTS.has(perTopic)) return perTopic;

  // Global Settings default (Phase B) wins over env, below the per-topic pick.
  const setting = (settingClaudeEffort() ?? '').trim().toLowerCase();
  if (setting && VALID_CLAUDE_EFFORTS.has(setting)) return setting;

  const override = (process.env.TOPICS_CLAUDE_EFFORT ?? '').trim().toLowerCase();
  if (override === 'off' || override === 'none' || override === 'default') return null;
  // `CLAUDE_EFFORT` is a deprecated alias (the Warp shell convention we used to
  // mirror). Still honoured as a fallback, but `TOPICS_CLAUDE_EFFORT` is canonical.
  let legacy = '';
  if (!override) {
    legacy = (process.env.CLAUDE_EFFORT ?? '').trim().toLowerCase();
    if (legacy) warnDeprecatedEnv('CLAUDE_EFFORT', 'TOPICS_CLAUDE_EFFORT');
  }
  const candidate = override || legacy || 'xhigh';
  return VALID_CLAUDE_EFFORTS.has(candidate) ? candidate : null;
}

/**
 * Reasoning-effort tier for Topics-launched Codex sessions — the Codex
 * analogue of `resolveClaudeEffort()` above. Codex reads
 * `model_reasoning_effort` from `~/.codex/config.toml`; we resolve a tier
 * explicitly and pass it as a `-c model_reasoning_effort=<tier>` override so
 * the value is deterministic under launchd AND surfaced in the provider
 * snapshot (picker badge).
 *
 * Valid tiers, probed against codex-cli 0.144.0-alpha.4: the API enum is
 * `none/minimal/low/medium/high/xhigh`; `ultra` is additionally accepted
 * end-to-end on current ChatGPT-bound models (Codex itself writes it into the
 * user config), so it is recognised here too.
 *
 * Resolution order: `TOPICS_CODEX_REASONING_EFFORT` (Topics override;
 * "off"/"default" disables — NOT "none", which is a real Codex tier) →
 * `CODEX_REASONING_EFFORT` (mirror the shell when present) → the user's own
 * `~/.codex/config.toml` value (an explicit user choice like `ultra` must
 * never be downgraded by our default) → `"xhigh"` (highest API-documented
 * tier). Returns null when disabled or the value is not a recognised tier, in
 * which case no override is passed and no badge is shown.
 */
const VALID_CODEX_REASONING_EFFORTS = new Set<string>(CODEX_REASONING_EFFORTS);

export function resolveCodexReasoningEffort(opts?: { configPath?: string }): string | null {
  // Global Settings default (Phase B) wins over env.
  const setting = (settingCodexReasoningEffort() ?? '').trim().toLowerCase();
  if (setting && VALID_CODEX_REASONING_EFFORTS.has(setting)) return setting;

  const override = (process.env.TOPICS_CODEX_REASONING_EFFORT ?? '').trim().toLowerCase();
  if (override === 'off' || override === 'default') return null;
  // `CODEX_REASONING_EFFORT` is a deprecated alias (shell mirror). Still honoured
  // as a fallback, but `TOPICS_CODEX_REASONING_EFFORT` is canonical.
  let legacy = '';
  if (!override) {
    legacy = (process.env.CODEX_REASONING_EFFORT ?? '').trim().toLowerCase();
    if (legacy) warnDeprecatedEnv('CODEX_REASONING_EFFORT', 'TOPICS_CODEX_REASONING_EFFORT');
  }
  const candidate =
    override ||
    legacy ||
    readCodexConfigReasoningEffort(opts?.configPath) ||
    'xhigh';
  return VALID_CODEX_REASONING_EFFORTS.has(candidate) ? candidate : null;
}

function readCodexConfigReasoningEffort(configPath?: string): string | null {
  try {
    const path = configPath ?? join(homedir(), '.codex', 'config.toml');
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      // Root-level key only: stop at the first table header — a
      // `model_reasoning_effort` inside e.g. a profile table is not the
      // value the bare CLI invocation would use.
      if (line.startsWith('[')) break;
      const m = line.match(/^model_reasoning_effort\s*=\s*"?([A-Za-z]+)"?/);
      if (m) return m[1].toLowerCase();
    }
  } catch {
    // No config / unreadable → fall through to the default tier.
  }
  return null;
}
