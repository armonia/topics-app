# Design — chat-fast-mode

## Una decisione, una mappa

Fast mode è **solo un override del modello**, niente altro. No tagli context, no skip tool, no skip plan. Questo è deliberato: ogni cosa che faremmo "in più" sarebbe magia silenziosa difficile da spiegare ("perché il modello non ha visto il mio CLAUDE.md?"). L'utente vede `Topic.fastMode` ON/OFF, sa che significa "modello veloce nativo del provider", fine.

```
body.model ──┐
             ├──► overrideModel ──► provider.sendChat(..., { model })
body.fastMode┤
             │   (only if body.model is empty AND topic.model is empty)
             └──► getFastModelFor(provider.name)
```

## Perché un helper `getFastModelFor()` separato?

**Alternativa scartata #1**: mettere la mappatura inline in `topics.ts`. Cattiva idea — il route handler è già 3500+ righe; un dizionario provider→model è esattamente il tipo di costante che va estratto.

**Alternativa scartata #2**: ogni provider espone un metodo `getFastModel()`. Più pulito in teoria, ma:
- I provider sono iniettati con config; aggiungere un metodo richiede toccare 5 file.
- La scelta del fast model è una decisione di **policy** (quanto fast è "fast"?), non una proprietà intrinseca del provider. Il route handler decide la policy, i provider la eseguono.
- Test molto più semplici con un dizionario statico.

**Scelta**: helper puro stateless in `server/providers/fast-models.ts`. Test sono una tabella di asserzioni.

```ts
// server/providers/fast-models.ts
export const FAST_MODELS: Record<string, string | null> = {
  "claude-code": "claude-haiku-4-5",
  "claude": "claude-haiku-4-5-20251022",
  "codex": "gpt-4o-mini",
  "openai": "gpt-4o-mini",
  "openclaw": null, // gateway decides
};

export function getFastModelFor(name: string): string | null {
  return FAST_MODELS[name.toLowerCase()] ?? null;
}
```

## Perché compatibile con Plan mode (non mutex)

Plan mode strutturale: cambia come l'AI **organizza** la risposta (piano → step → action items).
Fast mode strutturale: cambia **quale** modello risponde.

Sono dimensioni ortogonali. Combinazioni:

| Plan | Fast | Risultato                                                     |
|------|------|---------------------------------------------------------------|
| OFF  | OFF  | Modello forte, risposta libera (default).                     |
| ON   | OFF  | Modello forte, output in formato plan (analisi profonda).     |
| OFF  | ON   | Modello fast, risposta libera (velocità + flessibilità).      |
| ON   | ON   | Modello fast, output in formato plan (plan quick & dirty).    |

L'opzione "ON+ON" è particolarmente utile per "fammi un quick plan di 3 step", uso reale che il pattern mutex impedirebbe.

## Persistenza per topic — perché localStorage E DB

**localStorage** (chiave `fastMode:${topic.id}`): hydration immediata al mount del ChatPane. Senza, l'utente vede ⚡ OFF per ~200ms mentre arriva la prima risposta `GET /api/topics`.

**DB column** (`topics.fast_mode`): single source of truth lato server. Cross-window sync via WS `topic:updated`. Se un dispositivo apre il topic, vede il toggle nello stato corretto subito (no flash).

Pattern identico a `planMode` (verificato in `ChatPane.tsx:114-115` e `server/routes/topics.ts:1401`). Stiamo replicando esattamente lo stesso shape — riduce rischio + carico cognitivo per chi rileggerà.

## Priorità modello: perché picker > fast > topic.model > default

Ragionamento dal più "esplicito" al meno:

1. **Picker manuale** (`body.model`): l'utente ha appena scelto un modello dal dropdown. Massima intenzionalità. Wins always.
2. **Fast mode flag** (`body.fastMode`): toggle binario, ma è un'azione cosciente che l'utente ha intrapreso "per questa chat". Vince sul default del topic.
3. **Topic-persisted** (`matchedTopic.model`): scelta fatta tempo fa, può essere stata dimenticata. Vince solo se niente di più recente.
4. **Provider default**: ultima spiaggia.

**Edge case**: utente ha sia ⚡ ON sia un model picker attivo per il turno. Il picker wins; il route logga `[Chat] Fast mode requested but picker override "X" takes precedence — fast model ignored`. Trasparente, non silente.

## Provider mapping — perché questi modelli specifici

| Provider     | Fast model              | Razionale                                                                 |
|--------------|-------------------------|---------------------------------------------------------------------------|
| claude-code  | `claude-haiku-4-5`      | CLI accetta `--model haiku`; alias risolto dal binario.                   |
| claude       | `claude-haiku-4-5-20251022` | Anthropic SDK richiede id completo; haiku 4.5 è il fast tier attuale. |
| codex        | `gpt-4o-mini`           | Codex CLI lo lista, ~10x più veloce di gpt-5-codex.                       |
| openai       | `gpt-4o-mini`           | OpenAI SDK; ottimo cost/latency.                                          |
| openclaw     | `null`                  | Gateway esposto come "modello unico"; ha il suo router fast/slow interno.|

**Validazione runtime**: il guard esistente in `topics.ts` (line ~1689) verifica che il modello richiesto sia nella lista che `snap.providers[].models` espone. Se non c'è (es. CLI vecchio, plan ChatGPT senza accesso al modello), il guard droppa l'override e fallisce open su default. Niente magia: solo log.

## Diagnostics: perché propagare `fastMode` nell'envelope

L'inspector del context (`/api/context/analyze` + UI) sarà la finestra di debug quando un utente dirà "fast mode non funziona, sembra lento". Senza `diagnostics.fastMode`, dovremmo correlare HTTP requests con UI state — friction alta.

Con `diagnostics.fastMode: boolean` esposto:
- Tab "Last sent" mostra "Fast mode: ON, modello effettivo: claude-haiku-4-5".
- Snapshot ring buffer (già esistente) lo conserva per i 5 turn precedenti.
- Test E2E può verificare lo state senza sniffare network.

**Costo**: 1 campo opzionale boolean in un envelope già grande. Zero performance impact.

## Migration DB — perché ALTER TABLE idempotente

`server/db/` di topics-app usa SQLite + script di migration che girano all'avvio. Pattern già in uso (vedi git log per recenti aggiunte di colonne). Stile:

```sql
-- migrations/00XX_add_fast_mode.sql
ALTER TABLE topics ADD COLUMN fast_mode INTEGER DEFAULT 0 NOT NULL;
```

SQLite supporta `ALTER TABLE ADD COLUMN` direttamente. Default 0 garantisce backward compat per ogni row esistente. Idempotenza ottenuta via `PRAGMA table_info(topics)` check (pattern già usato altrove).

## E2E test plan — cosa vogliamo davvero verificare

Non testiamo "haiku risponde più veloce di sonnet" — è una proprietà di Anthropic, non del nostro codice. Testiamo:

1. **UI wiring**: toggle ⚡ cambia colore e dispatcha state.
2. **Request payload**: `fastMode: true` arriva al server.
3. **Server policy**: il modello effettivo passato a `provider.sendChat` è quello che `getFastModelFor` ritorna.
4. **Persistenza**: refresh + riapertura topic → ⚡ resta ON.
5. **Cross-window**: window A attiva ⚡ → window B (stesso topic) lo vede ON.
6. **Picker wins**: utente sceglie modello dal picker mentre ⚡ è ON → picker prevale (log presente).

Video Playwright in `test-results/chat-fast-mode/` per UAT.

## Risk register

| Rischio                                                | Mitigazione                                                                  |
|--------------------------------------------------------|------------------------------------------------------------------------------|
| Fast model non disponibile (CLI vecchio)               | Guard esistente al line ~1689 droppa override, fallback a default, log warn. |
| Utente confuso da picker vs fast mode                  | Log esplicito quando picker > fast; tooltip mostra modello effettivo.        |
| openclaw gateway non rispetta delega (`null`)          | Log info-level; gateway-side è out-of-scope di questa change.                |
| Plan + Fast genera output strano (modello piccolo)     | Documentato in design.md; non bloccante (utente ha controllo).               |
| Token-cost dashboard mostra meno spending → ⚡ "buon"   | OK behavior, non bug. Phase futura potrebbe esporre savings.                 |

## Out of scope (espliciti)

- **Auto-selection** ("messaggio breve → suggerisci fast") — euristica fragile, fastidiosa.
- **Per-message badge** ("questo turn ha usato fast") — richiede storage del modello effettivo per StoredMessage, separate phase.
- **Fast mode per agent profiles** — agent profiles hanno il proprio meccanismo; questa change è per topic chat.
- **Cost telemetry comparativa** — utile ma non oggi.
- **Provider-specific fine-tuning del fast model** (es. `claude-haiku-4-5-with-reasoning`) — partiamo dal default, iteriamo se serve.
