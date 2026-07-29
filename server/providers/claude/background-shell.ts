/**
 * Le shell in background, lette dal risultato dei tool (3.5).
 *
 * Una `Bash(run_in_background: true)` non è un tool che finisce: è un processo
 * che RESTA. Finora l'unica traccia era la card nel transcript — cioè un
 * ricordo, non uno stato: scorreva via, non si contava e non si poteva
 * ammazzare. Qui c'è solo il pezzo che sa leggere il CLI; chi tiene il
 * registro è `routes/processes.ts`, che è già il posto dove i processi vivi
 * si vedono e si fermano.
 *
 * Perché parsing e non un campo strutturato: il CLI risponde a questi tool in
 * prosa (`Command running in background with ID: bash_1`) e con dei tag
 * (`<status>`, `<exit_code>`). Non è un contratto, e cambia tra versioni —
 * quindi ogni funzione qui è deliberatamente permissiva e torna `null` invece
 * di indovinare. Una shell non riconosciuta resta invisibile come oggi; una
 * riconosciuta male sarebbe un bottone «Stop» puntato su qualcos'altro.
 */

import type { ToolCallDetail } from "../../types";

/** Stati terminali che il CLI sa riportare, più `running`. */
export type ShellStatus = "running" | "completed" | "failed" | "killed";

/** Cosa fare del registro delle shell, dato un risultato di tool. */
export type ShellToolAction =
  | { kind: "start"; shellId: string; command: string; cwd?: string }
  | { kind: "output"; shellId: string; output: string; status?: ShellStatus; exitCode?: number }
  | { kind: "kill"; shellId: string };

/**
 * Traduce il risultato di un tool nell'effetto che ha sul registro, o `null`
 * quando non ne ha nessuno. Sta qui e non nella route perché è tutta lettura di
 * formati altrui: la route deve solo eseguire l'effetto.
 */
export function classifyShellToolResult(
  detail: ToolCallDetail | undefined,
  result: string | undefined,
  isError?: boolean,
): ShellToolAction | null {
  if (!detail) return null;

  // Una Bash in background che è FALLITA non ha lasciato niente in giro.
  if (detail.type === "shell" && detail.background === true && !isError) {
    const shellId = parseBackgroundShellId(result);
    if (!shellId) return null;
    return {
      kind: "start",
      shellId,
      command: detail.command,
      ...(detail.cwd ? { cwd: detail.cwd } : {}),
    };
  }

  if (detail.type === "bash_output" && detail.shellId) {
    const st = parseShellStatus(result);
    return {
      kind: "output",
      shellId: detail.shellId,
      output: parseShellOutput(result),
      ...(st?.status ? { status: st.status } : {}),
      ...(st?.exitCode != null ? { exitCode: st.exitCode } : {}),
    };
  }

  if (detail.type === "kill_shell" && detail.shellId) {
    return { kind: "kill", shellId: detail.shellId };
  }

  return null;
}

/**
 * L'id che il CLI assegna alla shell appena avviata, letto dal risultato della
 * `Bash`. Da chiamare SOLO quando `run_in_background` era true: su una Bash
 * normale qualunque output che contenga «ID: …» darebbe un falso positivo.
 */
export function parseBackgroundShellId(result: string | undefined): string | null {
  if (!result) return null;
  const patterns: RegExp[] = [
    // Forma JSON, se un giorno il CLI smette di rispondere in prosa.
    /"(?:shell_?id|bash_?id|id)"\s*:\s*"([^"]+)"/i,
    // La frase attuale: «Command running in background with ID: bash_1».
    /\bID[:=]\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)/i,
    /\bID\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)/i,
    // Ultima spiaggia: l'id nudo, senza etichetta.
    /\b(bash_[A-Za-z0-9]+)\b/i,
  ];
  for (const re of patterns) {
    const m = result.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Lo stato riportato da un `BashOutput`. `null` quando il risultato non dice
 * niente sullo stato: chi chiama tiene quello che aveva, non inventa un
 * «completed» dal silenzio.
 */
export function parseShellStatus(
  result: string | undefined,
): { status: ShellStatus; exitCode?: number } | null {
  if (!result) return null;

  const raw =
    result.match(/<status>\s*([a-z_]+)\s*<\/status>/i)?.[1] ??
    result.match(/"status"\s*:\s*"([a-z_]+)"/i)?.[1] ??
    null;
  if (!raw) return null;

  const exitRaw =
    result.match(/<exit_?code>\s*(-?\d+)\s*<\/exit_?code>/i)?.[1] ??
    result.match(/"exit_?code"\s*:\s*(-?\d+)/i)?.[1] ??
    null;
  const exitCode = exitRaw != null ? Number(exitRaw) : undefined;

  const status = normalizeStatus(raw, exitCode);
  if (!status) return null;
  return exitCode != null ? { status, exitCode } : { status };
}

function normalizeStatus(raw: string, exitCode?: number): ShellStatus | null {
  switch (raw.toLowerCase()) {
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "complete":
    case "done":
    case "success":
      // Un «completed» con exit code diverso da 0 è un fallimento: lo dice il
      // codice, non l'etichetta.
      return exitCode != null && exitCode !== 0 ? "failed" : "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "terminated":
      return "killed";
    default:
      return null;
  }
}

/**
 * Il testo utile di un `BashOutput`: via i tag di stato, e `<stdout>`/`<stderr>`
 * srotolati. Quello che resta è quello che la shell ha davvero stampato, che è
 * l'unica cosa che ha senso mostrare nel pannello.
 */
export function parseShellOutput(result: string | undefined): string {
  if (!result) return "";
  return result
    // Via i tag di metadato con tutto il loro contenuto.
    .replace(/<(status|exit_?code|timestamp)>[^]*?<\/\1>/gi, "")
    // I due canali si srotolano: nel pannello sono una riga come le altre.
    .replace(/<\/?(stdout|stderr)>/gi, "")
    .trim();
}
