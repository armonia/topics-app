// scripts/ui-crawl-stress.mjs - six contract-page crawls at once (CRAWL_DEBUG on): under that load the dialog «Nuova variante» sometimes loses its clicks to a transient click-away layer. Exit codes per crawl, logs in test-results/giro3/stress-*.log. allow-italian: quotes the words on screen
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const only = "orbit-contract,orbit-contract-comments,orbit-contract-obligations,orbit-signatures,orbit-compare";
const runs = ["orbit", "consorzio", "orbit", "consorzio", "orbit", "consorzio"].map((entry, i) => new Promise((done) => {
  const c = spawn(process.execPath, ["scripts/ui-app-crawl.mjs", "--entry", entry, "--only", only], { env: { ...process.env, CRAWL_DEBUG: "1" } });
  let out = "";
  c.stdout.on("data", (b) => { out += b; });
  c.stderr.on("data", (b) => { out += b; });
  c.on("close", (code) => { writeFileSync(`test-results/giro3/stress-${i}-${entry}.log`, out); done(code); });
}));
const codes = await Promise.all(runs);
console.log(codes.join(","));
process.exit(codes.some((c) => c !== 0) ? 1 : 0);
