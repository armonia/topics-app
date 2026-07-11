# Design — chat-rendering-parity

## Highlighting (CHAT-RND-01)

`highlight.js/lib/core` + registrazione esplicita di un set curato (~16 linguaggi:
js/ts/jsx-tsx via xml, python, bash/shell, json, yaml, html/xml, css, rust, go,
java, sql, markdown, diff, c/cpp, php, ruby, swift). Modulo
`client/src/lib/syntaxHighlight.ts` con `highlightCode(code, lang): string|null`:
- lang mappato con alias comuni (ts→typescript, sh→bash, …);
- ritorna HTML evidenziato o `null` (lang ignoto / code >50KB / throw) → il
  CodeBlock usa il testo plain come oggi;
- nessun autodetect di default (costoso e impreciso sugli snippet corti).

Integrazione NEL CodeBlock esistente (`MessageContent.tsx`): memo su
(displayContent, language); render con `dangerouslySetInnerHTML` SOLO quando
l'HTML proviene da hljs (output sanificato per costruzione: hljs escapa il
sorgente). Il path line-numbers resta plain. Palette: regole `.hljs-*` compatte
in `index.css` scoped a `.code-block-wrapper` — il code block ha già sfondo scuro
in entrambi i temi, quindi UNA palette basta.

## KaTeX (CHAT-RND-02)

Modulo condiviso `client/src/lib/markdownPlugins.ts`:
```ts
export const chatRemarkPlugins = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
export const chatRehypePlugins = [rehypeRaw?, rehypeKatex];
```
NB: MessageContent oggi NON usa rehypeRaw nei call-site chat (solo remarkGfm) —
si aggiunge SOLO rehypeKatex per non cambiare la superficie HTML. CSS: `import
'katex/dist/katex.min.css'` in MessageContent (una volta). Call-site aggiornati:
i 4 ReactMarkdown di MessageContent + PlanView (chat surface). Il costo statico di
katex (~270KB) finisce nel chunk markdown già esistente.

## Mermaid (CHAT-RND-03)

Componente `MermaidBlock` in MessageContent:
- `const mermaid = await import('mermaid')` alla prima occorrenza (chunk lazy);
- `mermaid.initialize({ startOnLoad:false, theme: dark? 'dark':'default', securityLevel:'strict' })`;
- render in useEffect con debounce 300ms sul testo (streaming-safe: i parziali
  falliscono il parse e si resta sul fallback finché il blocco si stabilizza);
- `mermaid.parse()` prima di `render()` → su errore si mostra il CodeBlock plain
  (nessun tentativo di render che inietta error-div globali);
- id univoco per render (`mermaid-<uuid>`), svg iniettato via ref, max-width 100%.

## Rischi

- Peso: hljs core+16 lang ≈ ~120KB min nel chunk markdown; katex ~270KB; mermaid
  ~1.3MB ma SOLO lazy. Accettabile per app desktop; nessun impatto sul first
  paint (il chunk markdown è già lazy rispetto alla shell).
- Streaming: highlight ricalcolato per delta — memo su testo+lang, blocchi lunghi
  sono comunque collassati a 10 righe di preview (si evidenzia il testo mostrato).
- `singleDollarTextMath:false` evita i falsi positivi sui prezzi; il display math
  `$$` resta pienamente supportato.
