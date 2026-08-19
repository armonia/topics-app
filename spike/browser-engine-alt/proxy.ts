// Proxy HTTP -> il server TLS di Topics, per far entrare engine che non
// accettano certificati self-signed. Stessa origine logica, zero TLS.
const TARGET = "https://127.0.0.1:3333";
Bun.serve({
  port: 4900, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const r = await fetch(TARGET + u.pathname + u.search, {
      method: req.method, headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      tls: { rejectUnauthorized: false },
    });
    return new Response(r.body, { status: r.status, headers: r.headers });
  },
});
console.log("proxy http://127.0.0.1:4900 -> " + TARGET);
