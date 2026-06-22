/**
 * Live verification (throwaway): the native WebContentsView must SURVIVE a
 * renderer reload (same CDP targetId) when its pane is re-claimed, and an
 * unclaimed view must be swept after the grace window.
 *
 * Drives the real renderer IPC (window.electronAPI.browserNative.*) over CDP
 * 19333 — the exact path useNativeBrowser uses — so it exercises create()-reuse
 * + the deferred reclaim sweep end to end.
 */
const CDP = "http://127.0.0.1:19333";

async function mainTargetWs(): Promise<string> {
  const list = (await (await fetch(`${CDP}/json/list`)).json()) as Array<{
    id: string; type: string; url: string; webSocketDebuggerUrl?: string;
  }>;
  const app = list.find((t) => t.type === "page" && t.url.startsWith("https://127.0.0.1:3333"));
  if (!app?.webSocketDebuggerUrl) throw new Error("main app target not found");
  return app.webSocketDebuggerUrl;
}

function rendererEvaluator(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
    if (typeof m.id === "number" && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const send = (method: string, params: any = {}) =>
    new Promise<any>((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails || r.error) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error));
    return r.result?.result?.value;
  };
  return { ready, evaluate, close: () => ws.close() };
}

function liveTargets(): Promise<Set<string>> {
  return fetch(`${CDP}/json/list`).then((r) => r.json()).then((ts: any[]) =>
    new Set(ts.filter((t) => t.type === "page").map((t) => t.id as string)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const TOPIC = "verify-survives-" + Math.random().toString(36).slice(2, 8);
  const ORPHAN = "verify-orphan-" + Math.random().toString(36).slice(2, 8);
  let r = rendererEvaluator(await mainTargetWs());
  await r.ready;

  const create = (topic: string, url: string) => r.evaluate(`
    (async () => {
      const api = window.electronAPI.browserNative;
      const res = await api.create({ topicId: ${JSON.stringify(topic)}, partitionId: ${JSON.stringify("persist:topic-" + topic)}, initialUrl: ${JSON.stringify(url)} });
      // give the page a beat to load so the targetId resolves by URL
      await new Promise(r => setTimeout(r, 1200));
      const tid = await api.getCdpTargetId(res.viewId).catch(() => '');
      return { viewId: res.viewId, cdpTargetId: tid };
    })()
  `);

  console.log("1) create claimed pane + an orphan pane");
  const claimed = await create(TOPIC, "https://example.com/");
  const orphan = await create(ORPHAN, "https://example.org/");
  console.log("   claimed:", claimed.cdpTargetId?.slice(0, 16), " orphan:", orphan.cdpTargetId?.slice(0, 16));
  if (!claimed.cdpTargetId) throw new Error("FAIL: claimed pane got no targetId");

  const before = await liveTargets();
  const claimedAlive0 = before.has(claimed.cdpTargetId);
  console.log("   both targets live before reload:", before.has(claimed.cdpTargetId), before.has(orphan.cdpTargetId));

  console.log("2) reload the renderer (Cmd+R equivalent)");
  await r.evaluate("location.reload()").catch(() => {}); // ws dies with the reload
  r.close();
  await sleep(2500); // renderer boots back up

  // Reconnect to the fresh renderer.
  r = rendererEvaluator(await mainTargetWs());
  await r.ready;

  console.log("3) re-claim ONLY the claimed pane (simulates the pane remounting)");
  const reclaimed = await create(TOPIC, "https://example.com/");
  console.log("   reclaimed targetId:", reclaimed.cdpTargetId?.slice(0, 16), "(was", claimed.cdpTargetId.slice(0, 16) + ")");

  const sameTarget = reclaimed.cdpTargetId === claimed.cdpTargetId;
  console.log("   >>> SAME targetId across refresh:", sameTarget ? "✅ YES" : "❌ NO");

  console.log("4) wait out the reclaim grace (6s) — unclaimed orphan should be swept");
  await sleep(7000);
  const after = await liveTargets();
  const claimedSurvived = after.has(claimed.cdpTargetId);
  const orphanSwept = !after.has(orphan.cdpTargetId);
  console.log("   >>> claimed pane still alive after grace:", claimedSurvived ? "✅ YES" : "❌ NO");
  console.log("   >>> unclaimed orphan swept:", orphanSwept ? "✅ YES" : "❌ NO (leak)");

  // Cleanup: destroy the claimed test view.
  await r.evaluate(`
    (async () => {
      const api = window.electronAPI.browserNative;
      // best-effort: find by re-creating returns the same id; destroy it
      const res = await api.create({ topicId: ${JSON.stringify(TOPIC)}, partitionId: ${JSON.stringify("persist:topic-" + TOPIC)} });
      await api.destroy(res.viewId);
      return true;
    })()
  `).catch(() => {});
  r.close();

  const pass = claimedAlive0 && sameTarget && claimedSurvived && orphanSwept;
  console.log(pass ? "\nALL CHECKS PASSED ✅" : "\nSOME CHECKS FAILED ❌");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("verify error:", e); process.exit(2); });
