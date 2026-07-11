# Proposal — chat-rendering-parity

## Why

Benchmark 2026 (lobe-chat, open-webui, LibreChat — audit 2026-07-10 con fonti): i tre
gap di rendering della chat Topics rispetto ai "table stakes" sono
1. **niente syntax highlighting** nei code block (solo mono; `ToolCards.tsx:12`
   "No fancy syntax highlighting yet — future polish"),
2. **niente LaTeX/KaTeX** (zero dipendenze math nel repo),
3. **niente Mermaid** (i fence ```mermaid cadono nel code block generico).

Tutto il resto del rendering (GFM, tabelle, copy/collapse/line-numbers, immagini,
link dedupe, streaming con auto-chiusura fence) è già a livello — mancano solo i
tre renderer.

## What Changes

1. **Syntax highlighting** nei code block della chat: highlight.js (core + set
   curato di linguaggi comuni) dentro il CodeBlock ESISTENTE — stessi header
   copy/lines/collapse, i token colorati con una palette compatta scoped al blocco
   (coerente col tema, non un CSS theme esterno). Guardie: linguaggio dichiarato o
   auto-detect corto, skip per blocchi enormi (>50KB), fallback plain su qualunque
   errore. Il path line-numbers resta plain (tabella riga-per-riga).
2. **LaTeX/KaTeX**: `remark-math` (con `singleDollarTextMath: false` — "$5" non è
   matematica) + `rehype-katex` + CSS, condivisi da un modulo unico usato dai
   ReactMarkdown della chat (MessageContent, PlanView).
3. **Mermaid**: fence ```mermaid → componente dedicato con `import('mermaid')`
   LAZY (chunk separato, caricato solo alla prima occorrenza), render debounced
   (streaming-safe), fallback al code block su errore di parse, tema derivato da
   dark/light correnti.

**Non-goal:** rendering math/mermaid negli editor di file (superficie diversa);
shiki (bundle e pipeline più pesanti — highlight.js basta per la chat); esecuzione
di codice/artifacts.
