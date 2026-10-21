/**
 * Ctrl+Z verso un Claude Code lanciato da Topics lo congela per sempre.
 *
 * Su ctrl+z Claude Code smonta la sua interfaccia (esce dallo schermo
 * alternativo, spegne mouse e incolla), stampa «has been suspended. Run `fg`…»
 * e si manda SIGTSTP, restando in attesa di un SIGCONT per rimontarla. Sotto
 * Topics però è il figlio diretto della PTY e leader della propria sessione: il
 * suo gruppo è orfano e il kernel SCARTA il SIGTSTP. Il processo resta vivo,
 * nessuna shell farà mai `fg`, e da lì in poi scrive solo il titolo: sullo
 * schermo resta l'ultimo fotogramma e i resize non lo ridisegnano più. È la pane
 * «tagliata» del 21/10: PTY a 83 colonne, Claude Code fermo a 25 da ore, 17 KB
 * di soli titoli dopo il messaggio di sospensione. Un SIGCONT a mano l'ha
 * ridisegnato.
 *
 * Misurato su una PTY con il figlio leader di sessione, come nel bridge:
 * claude dopo ctrl+z risponde al resize con 0 byte e dopo SIGCONT con 2841;
 * codex, opencode e muse continuano a ridisegnarsi. Per questo il filtro vale
 * solo per i tipi Claude, e la shell tiene il suo ctrl+z (lì il job control
 * funziona).
 *
 * Con i binding di default toglierlo non perde niente: qui non c'è dove
 * tornare, e l'annulla di Claude Code è ctrl+_. Ctrl+Z però non è fra le
 * scorciatoie riservate: chi lo riassegna in `~/.claude/keybindings.json`, o
 * usa un $EDITOR aperto con ctrl+g che annulla con ctrl+z, dentro Topics lo
 * perde. Meglio un tasto in meno che una pane congelata. Va via anche
 * `ESC 0x1A` (alt+ctrl+z):
 * togliendo solo lo 0x1A resterebbe un ESC nudo, che in Claude Code interrompe
 * il turno in corso.
 */
export function withoutSuspendKey(sessionType: string | undefined, data: string): string {
  if (sessionType !== "claude-code" && sessionType !== "claude-code-team") return data;
  if (!data.includes("\x1a")) return data;
  return data.replaceAll("\x1b\x1a", "").replaceAll("\x1a", "");
}
