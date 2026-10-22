/**
 * @covers BROWSER-CHAT-06
 * Component attribution stays optional and bounded because page metadata is untrusted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DESCRIBE_ELEMENT_FN, formatElementContext } from "./element-describe";

const globalRecord = globalThis as unknown as Record<string, unknown>;
const previous = new Map<string, unknown>();

function installDom(target: Record<string, unknown>) {
  const root = { tagName: "HTML", parentElement: null, children: [], childNodes: [], attributes: [] };
  target.tagName = "DIV";
  target.id = "";
  target.parentElement = root;
  target.children = [];
  target.childNodes = [];
  target.attributes = [];
  target.textContent = "Price";
  target.getAttribute = () => null;
  target.getBoundingClientRect = () => ({ left: 1, top: 2, width: 30, height: 10 });
  const keys = ["document", "window", "location", "getComputedStyle"];
  for (const key of keys) previous.set(key, globalRecord[key]);
  globalRecord.document = { elementFromPoint: () => target, documentElement: root };
  globalRecord.window = { innerWidth: 800, innerHeight: 600 };
  globalRecord.location = { href: "https://fixture.test" };
  globalRecord.getComputedStyle = () => ({ getPropertyValue: () => "" });
}

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete globalRecord[key];
    else globalRecord[key] = value;
  }
  previous.clear();
});

const runProbe = () => DESCRIBE_ELEMENT_FN({ x: 2, y: 3 });

describe("DESCRIBE_ELEMENT_FN component attribution", () => {
  test("React 18 reads the selected host source, not the component use site", () => {
    function PriceCard() {}
    function PriceCatalog() {}
    function App() {}
    const target: Record<string, unknown> = {};
    const app = { type: App, return: null };
    const catalog = { type: PriceCatalog, return: app };
    const card = { type: PriceCard, return: catalog, _debugSource: { fileName: "src/pages/Pricing.tsx", lineNumber: 88 } };
    target["__reactFiber$test"] = { type: "div", return: card, _debugSource: { fileName: "src/cards/PriceCard.tsx", lineNumber: 42 } };
    installDom(target);

    const result = runProbe();
    expect(result?.component).toEqual({
      framework: "React", name: "PriceCard", file: "src/cards/PriceCard.tsx", line: 42,
      owners: ["PriceCatalog", "App"],
    });
    expect(formatElementContext(result!)).toContain("- componente: PriceCard (src/cards/PriceCard.tsx:42), dentro PriceCatalog › App");
  });

  test("React 19 parses V8 source from the selected host fiber", () => {
    function CartSummary() {}
    const target: Record<string, unknown> = {};
    target["__reactFiber$test"] = { type: "div", return: { type: CartSummary, return: null }, _debugStack: { stack: "Error\n    at react_stack_bottom_frame (node_modules/react-dom/cjs/react-dom-client.development.js:1:2)\n    at div (src/cart/CartSummary.tsx:19:3)" } };
    installDom(target);
    expect(runProbe()?.component).toMatchObject({
      framework: "React", name: "CartSummary", file: "src/cart/CartSummary.tsx", line: 19,
    });
  });

  test("React 19 parses WebKit @ frames and strips the Vite HMR query", () => {
    function PriceCard() {}
    const target: Record<string, unknown> = {};
    target["__reactFiber$test"] = {
      type: "div",
      return: { type: PriceCard, return: null, _debugSource: { fileName: "src/pages/Pricing.tsx", lineNumber: 88 } },
      _debugStack: { stack: "Error\nreact_stack_bottom_frame@http://localhost:5173/node_modules/.vite/deps/react-dom.js:1:2\nPriceCard@http://localhost:5173/src/cards/PriceCard.tsx?t=1697:42:7" },
    };
    installDom(target);
    expect(runProbe()?.component).toMatchObject({
      framework: "React", name: "PriceCard", file: "src/cards/PriceCard.tsx", line: 42,
    });
  });

  test("React 19 keeps a project file whose name says React", () => {
    function QueryProvider() {}
    const target: Record<string, unknown> = {};
    target["__reactFiber$test"] = {
      type: "div",
      return: { type: QueryProvider, return: null },
      _debugStack: { stack: "Error\n    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n    at QueryProvider (http://localhost:5173/src/providers/ReactQueryProvider.tsx?t=1:12:5)\n    at App (http://localhost:5173/src/App.tsx:30:7)" },
    };
    installDom(target);
    expect(runProbe()?.component).toMatchObject({
      framework: "React", name: "QueryProvider", file: "src/providers/ReactQueryProvider.tsx", line: 12,
    });
  });

  test("Vue 3 reports the nearest component and its owners", () => {
    const target: Record<string, unknown> = {};
    target.__vueParentComponent = {
      type: { __name: "ProductTile", __file: "src/ProductTile.vue" },
      parent: { type: { name: "Catalog" }, parent: null },
    };
    installDom(target);
    expect(runProbe()?.component).toEqual({
      framework: "Vue", name: "ProductTile", file: "src/ProductTile.vue", owners: ["Catalog"],
    });
  });

  test("Svelte infers its name from the source file when metadata has only loc", () => {
    const target: Record<string, unknown> = {};
    target.__svelte_meta = { loc: { file: "src/CartLine.svelte", line: 7 } };
    installDom(target);
    expect(runProbe()?.component).toEqual({
      framework: "Svelte", name: "CartLine", file: "src/CartLine.svelte", line: 7, owners: [],
    });
  });

  test("a page without framework metadata omits the field", () => {
    installDom({});
    expect(runProbe()?.component).toBeUndefined();
  });

  test("a hostile fiber chain stops at 200 visits without throwing", () => {
    function SelectedCard() {}
    let returnReads = 0;
    let fiber: Record<string, unknown> = { type: SelectedCard, return: null };
    for (let i = 0; i < 220; i++) {
      const next = fiber;
      fiber = { type: function Owner() {}, get return() { returnReads++; return next; } };
    }
    const target: Record<string, unknown> = {};
    target["__reactFiber$test"] = { type: "div", return: fiber };
    installDom(target);

    let result: ReturnType<typeof runProbe> | undefined;
    expect(() => { result = runProbe(); }).not.toThrow();
    expect(returnReads).toBeLessThanOrEqual(200);
    expect(result?.component?.owners).toHaveLength(5);
  });
});
