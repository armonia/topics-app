/**
 * One HTML escape for every page and SVG the server writes (views, media error
 * page, public profile, profile banner, delivery sheet). Pins the five
 * characters, `&` first, and the apostrophe as `&#39;`, valid in HTML and XML.
 *
 * @covers MEDIAERR-01
 */
import { expect, test } from "bun:test";
import { escapeHtml } from "./escape-html";
import { mediaErrorHtml } from "../media-error-page";

test("escapes the five characters, `&` first", () => {
  expect(escapeHtml(`a & <b> "c" 'd' &amp;`)).toBe("a &amp; &lt;b&gt; &quot;c&quot; &#39;d&#39; &amp;amp;");
});

test("the media error page escapes the apostrophe too", () => {
  const html = mediaErrorHtml({ path: "/x/it's<here>.png", title: "t", detail: "d" });
  expect(html).toContain("it&#39;s&lt;here&gt;.png");
  expect(html).not.toContain("it's");
});
