// Bun embeds `import x from "./foo.sh" with { type: "text" }` as the file's text
// (and bakes it into `bun build --compile` binaries). Used by
// `topics-hook-script.ts` for the hook script. Runtime-only feature; this is
// purely for the typechecker.
declare module "*.sh" {
  const content: string;
  export default content;
}
