/* Build-time constants of the demo boot script, injected by the esbuild
 * `define` in client/vite.landing.config.ts (inlineBootShim). */

/** The Browser pane's bootstrap JPEG, base64 (src/demo/browser-frame.b64.txt). */
declare const __DEMO_BROWSER_FRAME__: string;
/** rrweb Meta + FullSnapshot of src/demo/browser-page.html (src/demo/browser-dom-snapshot.json). */
declare const __DEMO_DOM_SNAPSHOT__: unknown[];
