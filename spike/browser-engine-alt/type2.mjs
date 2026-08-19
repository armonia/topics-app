import { launch, CDP, newPage, sleep } from "./bench.mjs";
const engine = process.argv[2], port = +process.argv[3];
const b = await launch(engine, port); const br = await CDP.connect(b.wsUrl); const { sessionId: s } = await newPage(br);
const ev = async (e) => (await br.send("Runtime.evaluate", { expression: e, returnByValue: true }, s)).result?.value;
await br.send("Page.navigate", { url: "http://127.0.0.1:4599/" }, s); await sleep(2000);
await ev("document.getElementById('q').focus()");
for (const variant of ["char", "keyDown+text"]) {
  await ev("document.getElementById('q').value=''");
  for (const ch of "abc") {
    if (variant === "char") await br.send("Input.dispatchKeyEvent", { type: "char", text: ch }, s).catch(e=>console.log("err char",e.message));
    else { await br.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, code: "Key"+ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }, s).catch(e=>console.log("err kd",e.message));
           await br.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key"+ch.toUpperCase() }, s).catch(()=>{}); }
  }
  await sleep(300);
  console.log(engine, variant, JSON.stringify(await ev("document.getElementById('q').value")));
}
// Input.insertText fallback
try { await ev("document.getElementById('q').value=''"); await br.send("Input.insertText", { text: "xyz" }, s); await sleep(200); console.log(engine, "insertText", JSON.stringify(await ev("document.getElementById('q').value"))); }
catch(e){ console.log(engine, "insertText ERR", e.message); }
br.close(); b.dispose(); process.exit(0);
