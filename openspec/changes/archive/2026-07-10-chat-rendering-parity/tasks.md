# Tasks — chat-rendering-parity

> STATO: implementata e verificata (2026-07-10). tsc verde; build ok (katex 77KB gz,
> mermaid.core 148KB gz in chunk LAZY separati); e2e nuovo "syntax highlighting,
> KaTeX math and mermaid" verde al primo run; chat.spec completa 18/18 verdi.

Convenzione: `[ ]` da fare, `[x]` fatto+verificato.

## Phase 1 — Highlighting
- [x] 1.1 `client/src/lib/syntaxHighlight.ts` — hljs core + 16 linguaggi, alias,
  guardie (unknown/oversize/throw → null).
- [x] 1.2 CodeBlock (`MessageContent.tsx`) — render evidenziato memoizzato con
  fallback plain; path line-numbers invariato.
- [x] 1.3 Palette `.hljs-*` scoped a `.code-block-wrapper` in `index.css`.

## Phase 2 — KaTeX
- [x] 2.1 `client/src/lib/markdownPlugins.ts` — plugin condivisi (remarkGfm +
  remarkMath singleDollarTextMath:false; rehypeKatex).
- [x] 2.2 Call-site chat aggiornati (4× MessageContent, PlanView) + import CSS katex.

## Phase 3 — Mermaid
- [x] 3.1 `MermaidBlock` lazy con parse-first, debounce 300ms, fallback CodeBlock,
  tema dark/light.
- [x] 3.2 Routing fence ```mermaid → MermaidBlock nel renderer `pre`.

## Phase 4 — Gate
- [x] 4.1 tsc client verde; build ok (mermaid in chunk separato).
- [x] 4.2 E2E: estendere il test "renders markdown formatting" (hljs token, katex
  span, mermaid svg) e verificare verde.
- [x] 4.3 Commit pathspec esplicito (no trailer, no push).
