/**
 * Chi si può PARCHEGGIARE, e chi no.
 *
 * IL PROBLEMA. Le chat hanno un reaper di inattività (15 minuti) e un tetto di
 * vita (2 ore). I terminali agente non avevano né l'uno né l'altro: misurate il
 * 2026-08-02, tredici CLI `claude --resume` vive da **tre giorni e cinque ore**,
 * ~1,2% di CPU e 65-326 MB ciascuna a fare niente — circa il 15% di una macchina
 * e 0,9 GB per sessioni ferme a un prompt.
 *
 * PARCHEGGIARE, NON UCCIDERE. Lo stato di una sessione Claude sta su disco (è
 * ciò che `claude --resume` rilegge), e il resto dell'impianto esiste già:
 * uccidere la PTY fa scattare il percorso di uscita che marca la riga `dormant`
 * (`routes/terminal.ts`, caso "exit"), e `POST /sessions/:id/revive` la rilancia
 * con `--resume`. Qui non si decide come, si decide SE.
 *
 * PERCHÉ È UNA FUNZIONE PURA. Un reaper su questo sottosistema ha già ucciso
 * turni VIVI una volta. Ogni condizione qui sotto è un modo in cui questo può
 * fare danno, e ognuna ha un test. La regola generale: **in mancanza di dati non
 * si parcheggia**. Un `null`, un campo assente, una fase sconosciuta sono tutti
 * "no": l'errore di non parcheggiare costa un po' di RAM, l'errore opposto costa
 * il lavoro di qualcuno.
 */

import type { ClaudeSessionPhase } from "../../shared/types";

/** Tutto ciò che serve per decidere, già raccolto dal chiamante. */
export interface ParkCandidate {
  id: string;
  /** `shell` non si parcheggia mai: non ha un `--resume`, il suo scrollback È il suo stato. */
  type: string;
  /** L'id da passare a `--resume`. Senza, la sessione non tornerebbe. */
  claudeSessionId?: string;
  /** La PTY sta scrivendo ADESSO (`terminalActivity.busy`). */
  busy: boolean;
  /** Da quanto la PTY è muta. `null` = non lo sappiamo (nessuna misura). */
  idleMs: number | null;
  /** Quanti client hanno il WebSocket di questa sessione aperto. */
  attachedClients: number;
  /** Il transcript è ancora su disco? Senza, `--resume` fallirebbe per sempre. */
  hasTranscript: boolean;
  /** Fase della macchina a stati Claude, `null` se sconosciuta. */
  phase: ClaudeSessionPhase | null;
}

export type ParkDecision =
  | { park: true }
  | { park: false; reason: ParkRefusal };

export type ParkRefusal =
  | "not-resumable-type"
  | "no-resume-id"
  | "no-transcript"
  | "busy"
  | "watched"
  | "phase-active"
  | "idle-unknown"
  | "too-recent";

/**
 * Le fasi in cui un turno è VIVO. Parcheggiare qui è il guasto già successo.
 *
 * `awaiting-user` NON è nell'elenco ed è deliberato: è la sessione ferma al
 * prompt in attesa di una persona — cioè esattamente le tredici misurate, e il
 * caso che questo meccanismo esiste per recuperare. `watching` invece ci sta
 * dentro: sta seguendo qualcosa, e non abbiamo modo di sapere quanto manchi.
 */
const ACTIVE_PHASES: ReadonlySet<string> = new Set<ClaudeSessionPhase>([
  "starting",
  "running",
  "tool-running",
  "awaiting-approval",
  "watching",
]);

/**
 * Solo le sessioni Claude si parcheggiano.
 *
 * `codex` è escluso di proposito: il percorso di uscita in `routes/terminal.ts`
 * calcola `canResume` sui soli tipi claude, quindi uccidere una PTY codex ne
 * CANCELLA la riga invece di renderla dormiente — parcheggiarla la perderebbe.
 */
const RESUMABLE_TYPES: ReadonlySet<string> = new Set(["claude-code", "claude-code-team"]);

export function decidePark(c: ParkCandidate, idleThresholdMs: number): ParkDecision {
  if (!RESUMABLE_TYPES.has(c.type)) return { park: false, reason: "not-resumable-type" };
  if (!c.claudeSessionId) return { park: false, reason: "no-resume-id" };
  if (!c.hasTranscript) return { park: false, reason: "no-transcript" };
  if (c.busy) return { park: false, reason: "busy" };
  if (c.attachedClients > 0) return { park: false, reason: "watched" };
  if (c.phase !== null && ACTIVE_PHASES.has(c.phase)) return { park: false, reason: "phase-active" };
  if (c.idleMs === null) return { park: false, reason: "idle-unknown" };
  if (c.idleMs < idleThresholdMs) return { park: false, reason: "too-recent" };
  return { park: true };
}

/** Testo leggibile per il log: un parcheggio che non si spiega è un parcheggio che nessuno può smentire. */
export function refusalLabel(reason: ParkRefusal): string {
  switch (reason) {
    case "not-resumable-type": return "tipo non ripristinabile";
    case "no-resume-id": return "nessun claude_session_id";
    case "no-transcript": return "transcript assente dal disco";
    case "busy": return "PTY attiva adesso";
    case "watched": return "qualcuno la sta guardando";
    case "phase-active": return "turno in corso";
    case "idle-unknown": return "inattivita' non misurata";
    case "too-recent": return "ferma da troppo poco";
  }
}

/**
 * Da quanto una PTY dev'essere muta prima di parcheggiarla, letto
 * dall'ambiente. **Assente = meccanismo spento**, ed è il default.
 *
 * Non è prudenza generica: con il client di oggi una sessione parcheggiata
 * mostra l'overlay «Sessione scaduta» col bottone Ricarica finché non la si
 * rianima. È accettabile solo dove la rianimazione automatica c'è
 * (`SingleTerminalPane` la fa quando la pane torna attiva), quindi la si accende
 * di proposito, non per inerzia.
 */
export function idleParkThresholdMs(env: Record<string, string | undefined>): number | null {
  const raw = env.TOPICS_TERMINAL_IDLE_PARK_MS?.trim();
  if (!raw) return null;
  const n = Number(raw);
  // Un valore incomprensibile non deve degradare in "parcheggia tutto subito":
  // meglio restare spenti e dirlo.
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[Terminal] TOPICS_TERMINAL_IDLE_PARK_MS="${raw}" non è un numero di millisecondi > 0 — parcheggio disattivato.`,
    );
    return null;
  }
  // Sotto il minuto si parcheggerebbe una sessione fra un comando e l'altro.
  const MIN_MS = 60_000;
  return Math.max(MIN_MS, n);
}
