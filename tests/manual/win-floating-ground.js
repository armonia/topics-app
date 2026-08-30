// DOES TURNING ON FLOATING SPLITS MOVE THE WINDOW'S GROUND?
//
// The gaps between the cards are the feature. The GROUND behind everything is
// not: `.floating-splits` used to take the shell's background away on every
// platform, which is right on macOS (per-region vibrancy paints behind the
// gaps) and wrong on Windows, where DWM backdrops are whole-window - with the
// background gone the entire window fell through to the desktop blur. Reported
// as "quando metto floating windows cambia lo sfondo finestre ma non dovrebbe".
//
// So: read the shell's computed background with the platform class Windows
// really carries, floating off and on, and compare. Then do the same with the
// macOS class, where the transparency is the point and MUST still happen.
//
//   bun run tests/manual/run-ui12-windows.ts tests/manual/win-floating-ground.js
(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const root = document.documentElement;
  const shell = document.createElement("div");
  shell.className = "flex bg-app-bg overflow-hidden max-w-[100vw]";
  shell.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;height:100px";
  document.body.appendChild(shell);

  const ground = () => getComputedStyle(shell).backgroundColor;
  const before = root.className;
  const read = (platformClass) => {
    root.className = platformClass;
    shell.classList.remove("floating-splits");
    const off = ground();
    shell.classList.add("floating-splits");
    const on = ground();
    return { off, on, cambia: off !== on };
  };

  const windows = read("windows-acrylic native-frost");
  const mac = read("tauri-mac native-frost");
  root.className = before;
  shell.remove();

  return JSON.stringify({ windows, mac }, null, 2);
})()
