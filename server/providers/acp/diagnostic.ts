/**
 * La DIAGNOSTICA di un agente ACP: cosa dire a chi apre il pannello provider e
 * trova la riga spenta.
 *
 * Sta fuori da `acp.ts` perche' risponde a una domanda che non e' «servire un
 * turno» ma «spiegare perche' non si puo'», e perche' quel file aveva superato
 * le 800 righe di `check:bloat` (995 il 2026-08-16).
 *
 * PURA, e questo e' il punto: prende lo stato gia' misurato e lo traduce in
 * requisiti. Cosi' i tre casi che contano — eseguibile assente, handshake non
 * ancora fatto, versione di protocollo che non sappiamo parlare — si provano
 * senza un agente vero, e soprattutto senza dover DISINSTALLARE jcode per
 * vedere cosa legge l'utente quando manca.
 */
import type { ProviderDiagnostic, ProviderRequirement } from "../types";

export interface DiagnosticInput {
  name: string;
  /** Il comando come sta scritto in configurazione: finisce nel suggerimento. */
  command: string;
  /** Il percorso risolto dell'eseguibile, o `null` se non si e' trovato. */
  bin: string | null;
  probe: { available: boolean; path?: string; version?: string };
  /** L'handshake e' stato fatto e il canale e' ancora aperto? */
  connected: boolean;
  protocolVersion: number;
  versionMismatch: { agentVersion: number; reason: string } | null;
}

export function buildDiagnostic(i: DiagnosticInput): ProviderDiagnostic {
  const requirements: ProviderRequirement[] = [
    {
      key: `${i.name}-binary`,
      label: `Eseguibile "${i.command}" disponibile`,
      present: i.probe.available || !!i.bin,
      hint: i.bin ? undefined : `Installa "${i.command}" o dichiaralo in ACP_AGENTS`,
    },
    {
      key: `${i.name}-handshake`,
      label: "Handshake ACP completato",
      present: i.connected,
      hint: i.connected ? undefined : "Si negozia al primo messaggio",
    },
    {
      key: `${i.name}-protocol`,
      label: `Protocollo ACP v${i.protocolVersion}`,
      present: !i.versionMismatch,
      hint: i.versionMismatch
        ? `L'agente parla ACP v${i.versionMismatch.agentVersion}: aggiorna Topics o installa una versione dell'agente che parli v${i.protocolVersion}`
        : undefined,
    },
  ];
  return {
    name: i.name,
    // L'handshake avviene al primo turno: non averlo ancora fatto non è un
    // guasto. Conta solo l'eseguibile — e la versione, quando l'agente ne ha
    // già dichiarata una che non sappiamo parlare: lì l'eseguibile c'è ed è
    // proprio il motivo per cui non serve a niente.
    status: i.versionMismatch ? "unavailable" : i.bin ? "ready" : "unavailable",
    binaryPath: i.probe.path ?? i.bin ?? undefined,
    version: i.probe.version,
    requirements,
    lastError: i.versionMismatch?.reason,
  };
}
