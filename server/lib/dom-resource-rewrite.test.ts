import { describe, test, expect } from "bun:test";
import { isViewerUnreachableHost, routedResourceUrl, rewriteDomEventResources } from "./dom-resource-rewrite";

/** @covers BROWSER-DOM-RES-01 */

const CTX = "ae217a6b";
const IMG = "http://localhost:3535/p/profilo/photo/1.jpg";
const ROUTED = `/api/browser/resource?ctx=${CTX}&u=${encodeURIComponent(IMG)}`;

describe("isViewerUnreachableHost", () => {
  test("loopback, private ranges and mDNS are the Mac's alone", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "10.0.0.4", "192.168.1.9", "172.20.1.1", "macbook.local"]) {
      expect(`${h}:${isViewerUnreachableHost(h)}`).toBe(`${h}:true`);
    }
  });

  test("public hosts are left to the viewer", () => {
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "images.unsplash.com"]) {
      expect(`${h}:${isViewerUnreachableHost(h)}`).toBe(`${h}:false`);
    }
  });
});

describe("rewriteDomEventResources", () => {
  test("a full snapshot's <img>, srcset and inline style go through the proxy", () => {
    const ev = {
      type: 2,
      data: { node: { type: 0, childNodes: [{
        type: 2, tagName: "img",
        attributes: { src: IMG, srcset: `${IMG} 1x, https://cdn.example.com/a.jpg 2x`, style: `background:url("${IMG}")` },
        childNodes: [],
      }] } },
    };
    rewriteDomEventResources(CTX, ev);
    const a = ev.data.node.childNodes[0].attributes;
    expect(a.src).toBe(ROUTED);
    expect(a.srcset).toBe(`${ROUTED} 1x, https://cdn.example.com/a.jpg 2x`);
    expect(a.style).toBe(`background:url("${ROUTED}")`);
  });

  test("an image added later by a mutation is rewritten too", () => {
    const ev = { type: 3, data: { source: 0, adds: [{ node: { type: 2, tagName: "img", attributes: { src: IMG }, childNodes: [] } }], attributes: [{ id: 9, attributes: { src: IMG } }] } };
    rewriteDomEventResources(CTX, ev);
    expect(ev.data.adds[0].node.attributes.src).toBe(ROUTED);
    expect(ev.data.attributes[0].attributes.src).toBe(ROUTED);
  });

  test("public images and navigation links stay as they are", () => {
    const ev = { type: 2, data: { node: { type: 2, tagName: "div", attributes: {}, childNodes: [
      { type: 2, tagName: "img", attributes: { src: "https://cdn.example.com/a.jpg" }, childNodes: [] },
      { type: 2, tagName: "a", attributes: { href: "http://localhost:3535/p/2" }, childNodes: [] },
    ] } } };
    rewriteDomEventResources(CTX, ev);
    expect(ev.data.node.childNodes[0].attributes.src).toBe("https://cdn.example.com/a.jpg");
    expect(ev.data.node.childNodes[1].attributes.href).toBe("http://localhost:3535/p/2");
  });

  test("scripts and module preloads are not routed: the mirror never runs them", () => {
    const js = "http://localhost:3535/assets/index-DdLnhU6r.js";
    const ev = { type: 2, data: { node: { type: 2, tagName: "head", attributes: {}, childNodes: [
      { type: 2, tagName: "script", attributes: { src: js }, childNodes: [] },
      { type: 2, tagName: "link", attributes: { rel: "modulepreload", href: js }, childNodes: [] },
      { type: 2, tagName: "link", attributes: { rel: "icon", href: IMG }, childNodes: [] },
    ] } } };
    rewriteDomEventResources(CTX, ev);
    const [script, preload, icon] = ev.data.node.childNodes;
    expect(script.attributes.src).toBe(js);
    expect(preload.attributes.href).toBe(js);
    expect(icon.attributes.href).toBe(ROUTED);
  });

  test("only http(s) is proxied", () => {
    expect(routedResourceUrl(CTX, "data:image/png;base64,AAAA")).toBeNull();
    expect(routedResourceUrl(CTX, "file:///etc/passwd")).toBeNull();
  });
});
