/**
 * What survives the trip from a web page to a model's context.
 *
 * The cases here are the ones that cost tokens or lose meaning when they go
 * wrong: markup that must vanish entirely, structure that must NOT (a list read
 * as one paragraph says something different from a list), and code, whose
 * indentation is the content.
 *
 * @covers CHAT-NTOOL-02
 */
import { describe, it, expect } from "bun:test";
import { htmlToMarkdown, decodeEntities } from "./html-to-markdown";

describe("htmlToMarkdown", () => {
  it("script, style and comments do not reach the text", () => {
    const { markdown } = htmlToMarkdown(
      `<html><head><title>T</title><style>.a{color:red}</style></head>
       <body><script>var hidden = "non leggermi";</script><!-- nota --><p>Visibile</p></body></html>`,
    );
    expect(markdown).toContain("Visibile");
    expect(markdown).not.toContain("hidden");
    expect(markdown).not.toContain("color:red");
    expect(markdown).not.toContain("nota");
  });

  it("the title comes back apart from the body", () => {
    const page = htmlToMarkdown("<html><head><title>  Guida &amp; API </title></head><body><p>x</p></body></html>");
    expect(page.title).toBe("Guida & API");
  });

  it("headings keep their level: it is the map of the document", () => {
    const { markdown } = htmlToMarkdown("<h1>Uno</h1><p>a</p><h3>Tre</h3><p>b</p>");
    expect(markdown).toContain("# Uno");
    expect(markdown).toContain("### Tre");
  });

  it("a list stays a list, one item per line", () => {
    const { markdown } = htmlToMarkdown("<ul><li>primo</li><li>secondo</li></ul>");
    const bullets = markdown.split("\n").filter((r) => r.startsWith("- "));
    expect(bullets).toEqual(["- primo", "- secondo"]);
  });

  it("a link carries its address, resolved against the page", () => {
    const { markdown } = htmlToMarkdown('<p>vedi <a href="/docs/api">la guida</a></p>', "https://esempio.dev/x/y");
    expect(markdown).toContain("[la guida](https://esempio.dev/docs/api)");
  });

  it("a link that runs code is not offered as a destination", () => {
    const { markdown } = htmlToMarkdown('<a href="javascript:alert(1)">clicca</a>');
    expect(markdown).toContain("clicca");
    expect(markdown).not.toContain("javascript:");
  });

  it("code keeps its indentation and gets a fence", () => {
    const { markdown } = htmlToMarkdown("<pre><code>if (x) {\n    return 1;\n}</code></pre>");
    expect(markdown).toContain("```");
    expect(markdown).toContain("\n    return 1;");
  });

  it("entities become characters, unknown ones stay as they are", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42; &sconosciuta;"))
      .toBe("a & b <c> A B &sconosciuta;");
  });

  it("a page painted by JavaScript comes back empty, not invented", () => {
    const { markdown } = htmlToMarkdown('<html><body><div id="root"></div><script>render()</script></body></html>');
    expect(markdown).toBe("");
  });

  it("blank runs collapse: whitespace is not information here", () => {
    const { markdown } = htmlToMarkdown("<p>a</p><div></div><div></div><p>b</p>");
    expect(markdown).toBe("a\n\nb");
  });
});
