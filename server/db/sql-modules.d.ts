// Bun embeds `import x from "./foo.sql" with { type: "text" }` as the file's text
// content (and bakes it into `bun build --compile` binaries). TypeScript has no
// built-in knowledge of this, so declare `.sql` modules as string-default exports
// — used by migrations-embedded.ts to embed the SQL migrations into the compiled
// server sidecar. Runtime-only feature; this is purely for the typechecker.
declare module "*.sql" {
  const content: string;
  export default content;
}
