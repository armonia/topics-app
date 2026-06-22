/**
 * Standalone functional verification for the unified browser tool surface.
 * Drives the REAL Playwright web-fallback path (no CDP, no running server) so
 * it proves snapshot/diff/act/get_text/extract/eval regardless of which server
 * is live. Network-free: uses a data: URL.
 *
 *   bun run scripts/verify-browser-parity.ts
 */
import { createBrowserService } from "../server/browser-service";
import { playwrightOps } from "../server/browser-ops-adapter";
import { serialize } from "../server/browser-snapshot";
import {
  handleBrowserObserve,
  handleBrowserAct,
} from "../server/browser-tools-handler";

const HTML = `<!doctype html><html><head><title>Harness</title></head><body>
<h1>Hello Harness</h1>
<a href="https://example.com/next">Home</a>
<button id="b">Sign in</button>
<input id="i" placeholder="Email"/>
<select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>
<input type="checkbox" id="c"/>
</body></html>`;
const URL = "data:text/html," + encodeURIComponent(HTML);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const svc = await createBrowserService({});
const ctx = "verify-parity";
try {
  await svc.createContext(ctx);
  await svc.navigate(ctx, URL);
  const ops = playwrightOps(svc, ctx);

  // 1. snapshot — compact ref lines
  const snap = await ops.snapshot({ max: 50 });
  const text = serialize(snap);
  console.log("--- snapshot ---\n" + text + "\n----------------");
  check("snapshot has button", /button "Sign in"/.test(text));
  check("snapshot has link", /link "Home"/.test(text));
  check("snapshot has textbox", /textbox/.test(text));
  check("snapshot has combobox(select)", /combobox/.test(text));

  const refOf = (re: RegExp) => {
    const el = snap.elements.find((e) => re.test(`${e.role} ${e.name}`));
    return el?.ref;
  };
  const inputRef = snap.elements.find((e) => e.role === "textbox")?.ref;
  const selRef = snap.elements.find((e) => e.role === "combobox")?.ref;
  const cbRef = snap.elements.find((e) => e.role === "checkbox")?.ref;

  // 2. observe via handler → full then incremental
  const obsFull = await handleBrowserObserve(svc, ctx, { full: true });
  check("observe full=true", obsFull.full === true && obsFull.count > 0);
  const obsDiff = await handleBrowserObserve(svc, ctx, {});
  check("observe incremental stable", /no element changes/.test(obsDiff.snapshot), `got: ${obsDiff.snapshot}`);

  // 3. fill input → value reflected
  if (inputRef != null) {
    await ops.actByRef(inputRef, "fill", { text: "hi@x.com" });
    const after = await ops.snapshot({ max: 50 });
    const inAfter = after.elements.find((e) => e.role === "textbox");
    check("fill set input value", inAfter?.value === "hi@x.com", `got: ${inAfter?.value}`);
  } else check("fill set input value", false, "no input ref");

  // 4. select option
  if (selRef != null) {
    await ops.actByRef(selRef, "select", { value: "b" });
    const v = await ops.evalExpression("return document.getElementById('s').value");
    check("select set option", (v as { result?: unknown }).result === "b", `got: ${JSON.stringify(v)}`);
  } else check("select set option", false, "no select ref");

  // 5. check checkbox
  if (cbRef != null) {
    await ops.actByRef(cbRef, "check", {});
    const v = await ops.evalExpression("return document.getElementById('c').checked");
    check("check checkbox", (v as { result?: unknown }).result === true, `got: ${JSON.stringify(v)}`);
  } else check("check checkbox", false, "no checkbox ref");

  // 6. get_text
  const gt = await ops.getText({});
  check("get_text returns body text", /Hello Harness/.test(gt.text), `got: ${gt.text.slice(0, 60)}`);

  // 7. eval
  const ev = await ops.evalExpression("return document.title");
  check("eval returns title", (ev as { result?: unknown }).result === "Harness", `got: ${JSON.stringify(ev)}`);

  // 8. extract (deterministic CSS)
  const ex = await ops.extractFields({ h1: "h1", link: { selector: "a", attr: "href" } });
  check("extract h1", ex.h1 === "Hello Harness", `got: ${JSON.stringify(ex)}`);
  check("extract link href", String(ex.link).includes("example.com/next"), `got: ${JSON.stringify(ex)}`);

  // 9. press (page-level, no ref) — should not throw
  await ops.dispatchInput("keypress", { key: "Tab" });
  check("press Tab (no throw)", true);

  // 10. scroll (page-level) — should not throw
  await ops.dispatchInput("scroll", { deltaY: 100 });
  check("scroll (no throw)", true);

  // 11. act via handler returns a diff
  const actRes = await handleBrowserAct(svc, ctx, { action: "get_text" });
  check("act get_text via handler", typeof actRes.text === "string" && /Hello/.test(actRes.text!));

  void refOf;
} finally {
  await svc.destroyContext(ctx).catch(() => {});
  await svc.close().catch(() => {});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
