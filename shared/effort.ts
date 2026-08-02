/**
 * La scala dell'effort di ragionamento, in UN posto solo, letta dai due lati del filo.
 *
 * Era riscritta a mano in 11 posti — 8 per claude, 3 per codex: la validazione
 * del server (`services/tasks.ts`, `routes/topics.ts` ×2, `routes/app-settings.ts`,
 * `lib/topics-agent-prompt.ts` ×2) e i selettori del client (`Settings`, `Board`,
 * `lib/effortTiers.ts`). Le copie erano identiche, ma il precedente di
 * `shared/board.ts` era già stato pagato una volta: un contratto duplicato
 * prima o poi deriva. Il tipo DERIVA dal valore, così aggiungere un tier senza
 * aggiornare i consumatori non compila più.
 *
 * `as const` conserva l'ORDINE, e non è un dettaglio: lo slider dell'effort ci
 * si appoggia (`max` sta DOPO `xhigh`), ed è il motivo per cui l'UI è uno slider
 * e non cinque pill affiancate — cinque pill non dicono che `max` viene dopo.
 *
 * `shared/` è l'unica cartella che entrambi i progetti TS possono includere
 * senza violare il confine composite (TS6307) — vedi `shared/board.ts`.
 *
 * ATTENZIONE allo schema: `EFFORT_TIERS` (claude) rispecchia il CHECK di
 * `topics.effort` (migration 033) e la colonna `app_settings.claude_effort`
 * (054); `CODEX_REASONING_EFFORTS` rispecchia `codex_reasoning_effort` (054).
 * Se qui si cambia la scala, il CHECK constraint SQLite va allineato a mano — in
 * questo repo l'union TS e il CHECK sono già divergiti due volte (migr. 029, 066).
 */

/** Scala effort di claude-code (`--effort`). Ordinata: lo slider indicizza qui. */
export const EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Scala reasoning-effort di codex (`-c model_reasoning_effort=…`). Più larga:
 * `none`/`minimal` sotto e `ultra` sopra la scala claude (vedi
 * `lib/topics-agent-prompt.ts` per il perché di `ultra`).
 */
export const CODEX_REASONING_EFFORTS = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra',
] as const;
