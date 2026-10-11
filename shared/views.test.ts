/**
 * The view contract (GENUI-01): what an agent may send, what it becomes, and
 * who wins on a metric. The fixture is the real comparison of topic:64095902.
 *
 * @covers GENUI-01, GENUI-03
 */
import { describe, expect, test } from "bun:test";
import { normalizeViewSpec, parseViewSpec, rankMetrics, viewIdFromResult, type CompareViewSpec } from "./views";
import { staysCompare } from "../tests/e2e/fixtures/sitges-compare";

const ok = (input: unknown): CompareViewSpec => {
  const r = normalizeViewSpec(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec as CompareViewSpec;
};

describe("normalizeViewSpec", () => {
  test("the real comparison passes whole: three options, one recommended, photos and metrics kept", () => {
    const spec = ok(staysCompare("/Users/x/.topics/media/sitges-alloggi/img"));
    expect(spec.options.map((o) => o.title)).toEqual(["Beach Haven", "Nautilus", "Hotel El Cid"]);
    expect(spec.options.filter((o) => o.recommended).map((o) => o.title)).toEqual(["Nautilus"]);
    expect(spec.options[2].price).toEqual({ amount: 180, currency: "EUR", note: "colazione inclusa, 2 notti" });
    expect(spec.options[0].images?.length).toBe(6);
    expect(spec.options[1].metrics?.[0]).toEqual({ label: "centro", value: 3, unit: "min", better: "lower" });
    // What normalization returns is what a stored row and a WS frame parse back to.
    expect(parseViewSpec(spec)).toEqual(spec);
  });

  test("a price written as text becomes a number, a currency sign a code", () => {
    const spec = ok({ title: "T", options: [{ title: "A", price: "184,50 €" }, { title: "B", price: { amount: "99", currency: "$" } }] });
    expect(spec.options[0].price).toEqual({ amount: 184.5, currency: "EUR" });
    expect(spec.options[1].price).toEqual({ amount: 99, currency: "USD" });
  });

  test("what a page must not load is dropped: script URLs as links or images, relative paths", () => {
    const spec = ok({
      title: "T",
      options: [
        { title: "A", link: "javascript:alert(1)", images: ["javascript:alert(1)", "img.png", "https://x/a.jpg", "file:///Users/x/b.jpg"] },
        { title: "B", link: { url: "https://x/b" } },
      ],
    });
    expect(spec.options[0].link).toBeUndefined();
    expect(spec.options[0].images).toEqual([{ src: "https://x/a.jpg" }, { src: "/Users/x/b.jpg" }]);
    expect(spec.options[1].link).toEqual({ url: "https://x/b" });
  });

  test("the errors are written for the agent: which field, what was expected", () => {
    const r = normalizeViewSpec({ options: [{ title: "A", recommended: true }, { recommended: true }, { title: "C", recommended: true }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain("'title' (string) is required");
    expect(r.errors).toContain("options[1].title (string) is required");
    expect(r.errors).toContain("at most one option may be 'recommended' (got 2)");
    const one = normalizeViewSpec({ title: "T", options: [{ title: "A" }] });
    expect(one.ok ? [] : one.errors).toEqual(["'options' must have 2-4 items (got 1)"]);
    const kind = normalizeViewSpec({ view: "map", title: "T" });
    expect(kind.ok ? [] : kind.errors).toEqual(["unknown view 'map' (known: compare, table, timeline)"]);
  });
});

describe("rankMetrics", () => {
  test("lower wins: best and worst per metric, ties share the rank, equal values rank nobody", () => {
    const spec = ok(staysCompare("/i"));
    const ranks = rankMetrics(spec.options);
    // centre 12 / 3 / 6, station 17 / 6 / 6 (tie), bus 9 / 7 / 4
    expect(ranks.map((r) => r.centro)).toEqual(["worst", "best", undefined]);
    expect(ranks.map((r) => r.stazione)).toEqual(["worst", "best", "best"]);
    expect(ranks.map((r) => r["bus aeroporto"])).toEqual(["worst", undefined, "best"]);
    const flat = rankMetrics([
      { title: "A", metrics: [{ label: "x", value: 1, better: "lower" }] },
      { title: "B", metrics: [{ label: "x", value: 1, better: "lower" }] },
    ]);
    expect(flat).toEqual([{}, {}]);
  });

  test("higher wins when asked, text values and metrics without a direction are not ranked", () => {
    const ranks = rankMetrics([
      { title: "A", metrics: [{ label: "rating", value: 9.1, better: "higher" }, { label: "wifi", value: "yes" }] },
      { title: "B", metrics: [{ label: "rating", value: 8.6, better: "higher" }, { label: "wifi", value: "no" }] },
    ]);
    expect(ranks).toEqual([{ rating: "best" }, { rating: "worst" }]);
  });
});

test("the view id is read back from the tool result", () => {
  expect(viewIdFromResult("shown in chat · compare · 3 options · page https://127.0.0.1:3333/v/0123456789abcdef")).toBe("0123456789abcdef");
  expect(viewIdFromResult("page /v/NOTANID")).toBeUndefined();
  expect(viewIdFromResult(undefined)).toBeUndefined();
});
