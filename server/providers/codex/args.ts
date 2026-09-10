/**
 * L'argv con cui si lancia `codex exec` — come FUNZIONE PURA.
 *
 * Stessa ragione della gemella `claude/args.ts`: l'argv di una CLI di terze
 * parti è la superficie che si rompe a ogni release, e finché resta un array
 * letterale in mezzo alla funzione che spawna, la rottura arriva in produzione
 * invece che in CI. Qui non si legge ambiente né disco: tutto entra dai
 * parametri, così uno snapshot test può fotografare l'elenco.
 *
 * Le decisioni (quale modello, quale sandbox, quale tier di reasoning) restano
 * a monte: questo file le mette in fila, non le prende.
 */

/** Ciò che serve per montare l'argv di un turno di chat. */
export interface CodexExecArgsOptions {
  /**
   * Modello esplicito, o null/undefined per NON passare la flag.
   * Non è pigrizia: senza `--model` la CLI pesca da `~/.codex/config.toml`, ed
   * è l'unico modo perché funzionino gli account ChatGPT (che rifiutano
   * `gpt-5-codex` passato a mano).
   */
  model?: string | null;
  /** `full-access` opta per il bypass; qualunque altra cosa resta sandboxata. */
  approvalMode?: string | null;
  /** Narrow sessions may be read-only even when the app default is workspace-write. */
  sandbox?: "workspace-write" | "read-only";
  /**
   * Do not merge user config/rules into a registry-owned narrow profile.
   * Authentication still uses CODEX_HOME; explicit `-c mcp_servers.*` values
   * below remain the only configured operational tools.
   */
  isolated?: boolean;
  /**
   * Il bridge MCP di Topics, o null quando non si è potuto montare. Codex legge
   * `mcp_servers.*` dal config: si inietta per-invocazione con `-c`, e il valore
   * è TOML — `JSON.stringify` produce una stringa/array TOML valido.
   */
  bridge?: { command: string; args: string[] } | null;
  /** Tier di reasoning già risolto, o null per non forzarlo. */
  reasoningEffort?: string | null;
}

/** L'argv di un turno di chat. */
export function buildCodexArgs(opts: CodexExecArgsOptions): string[] {
  // `codex exec --json` è l'ingresso non interattivo canonico. Il prompt entra
  // da stdin, non da argv, per non incontrare il limite di lunghezza.
  const args = ["exec", "--json", "--skip-git-repo-check"];
  return args.concat(codexSharedFlags(opts, false));
}

/**
 * Same message-turn flags as `buildCodexArgs`, minus the `exec --json
 * --skip-git-repo-check` prefix that differs between a fresh turn and a
 * resumed one. Both entry points must forward model/sandbox/bridge/effort
 * identically, since none of those live inside the persisted thread: they are
 * re-applied on every process spawn, resume included.
 *
 * `viaConfigSandbox` exists because `codex exec resume` (checked against
 * `codex exec resume --help` on codex-cli 0.153.4) has NO `--sandbox`/`-s`
 * flag at all, unlike plain `codex exec`. The sandbox is still settable on a
 * resumed turn, just through the generic `-c sandbox_mode=<value>` config
 * override instead (verified against the live CLI: `-c
 * sandbox_mode=workspace-write --strict-config` parses cleanly, and an
 * invalid value is rejected with the exact same enum `codex exec --sandbox`
 * takes: read-only, workspace-write, danger-full-access).
 */
function codexSharedFlags(opts: CodexExecArgsOptions, viaConfigSandbox: boolean): string[] {
  const args: string[] = [];
  if (opts.isolated) args.push("--ignore-user-config", "--ignore-rules");
  if (opts.model) args.push("--model", opts.model);
  // `--approval` non è una flag valida di `codex exec` nelle versioni correnti:
  // la sandbox si sceglie così.
  if (opts.approvalMode === "full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (viaConfigSandbox) {
    args.push("-c", `sandbox_mode=${JSON.stringify(opts.sandbox ?? "workspace-write")}`);
  } else {
    args.push("--sandbox", opts.sandbox ?? "workspace-write");
  }
  if (opts.bridge) {
    args.push("-c", `mcp_servers.topics.command=${JSON.stringify(opts.bridge.command)}`);
    args.push("-c", `mcp_servers.topics.args=${JSON.stringify(opts.bridge.args)}`);
  }
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  }
  return args;
}

/**
 * The argv for a resumed turn: `codex exec resume <thread_id>` instead of a
 * fresh `codex exec`. Codex keeps the full conversation server-side once
 * resumed, so the caller sends only the new message on stdin, not a
 * client-truncated transcript.
 */
export function buildCodexResumeArgs(opts: CodexExecArgsOptions & { threadId: string }): string[] {
  const args = ["exec", "resume", opts.threadId, "--json", "--skip-git-repo-check"];
  return args.concat(codexSharedFlags(opts, true));
}

/**
 * L'argv di un completamento usa-e-getta (auto-titolo, digest, fallback SSE).
 * Niente `--json`: qui si legge il testo, non gli eventi.
 */
export function buildCodexOneshotArgs(opts: { model?: string | null; reasoningEffort?: string; isolated?: boolean }): string[] {
  const args = ["exec"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
  if (opts.isolated) args.push(
    "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
    "-c", 'features.shell_tool=false', "-c", 'web_search="disabled"',
  );
  return args;
}
