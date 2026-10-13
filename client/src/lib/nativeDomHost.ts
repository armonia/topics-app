/**
 * The native pane as the source of the DOM mirror (client half of
 * server/lib/native-dom-host.ts, NATIVE-HOST-01..03).
 *
 * When another device watches this context, the Mac does not leave its
 * WKWebView any more: it records its own page with rrweb and sends the events
 * to the server, which relays them to the viewers' mirrors. Their input comes
 * back here and runs in the page.
 *
 * Pull, not push: the page cannot call the app (a remote page gets no IPC, on
 * purpose), so the recorder fills a queue in the page and this module drains it
 * with `browser_eval_js`, fast while the page moves and slower when it is
 * still. A new document has no queue: the drain notices and arms it again, so
 * navigation needs no hook of its own.
 *
 * Everything that touches the pane or the socket is injected, so the protocol is
 * tested without a WKWebView.
 */

export type HostNavAction = 'navigate' | 'back' | 'forward' | 'reload';

export interface HostPageState {
  url: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface NativeDomHostOptions {
  /** Evaluate one expression in the pane's page; `preserveFocus` keeps the Mac's key focus where it is. */
  evalInPage: (js: string, preserveFocus?: boolean) => Promise<string>;
  /** The rrweb record bundle, the same file the server injects into Chromium. */
  loadRecorder: () => Promise<string>;
  /** Raw text on the executor socket (a drained batch is sent without re-parsing it). */
  sendText: (text: string) => void;
  /** The pane's own toolbar path, so a viewer's navigation moves the Mac's address bar too. */
  navigate: (action: HostNavAction, url?: string) => void;
  /** Recording needs the page live: a hidden WKWebView throttles timers and skips layout. */
  onRecordingChange?: (recording: boolean) => void;
  /** The server accepted the declaration: it hosts mirrors from native panes. */
  onAccepted?: () => void;
  /**
   * Lay the page out at a size, the one of the device using it (TOPIC-BROWSER-05),
   * or at the pane's own slot again (null).
   */
  setViewport?: (size: { width: number; height: number } | null) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

export interface NativeDomHost {
  /** Ask the server to host: sent on every (re)opened executor socket. */
  declare(): void;
  /** A frame from the server. True when it was a host frame. */
  handle(frame: unknown): boolean;
  /** Where the pane is now; reaches the viewers' address bars. */
  notePage(page: HostPageState): void;
  /** The executor socket died: whatever the server asked for no longer holds. */
  reset(): void;
  /** The Mac's user used the page in its own pane: it takes the layout back. */
  noteLocalUse(): void;
  /** True once the server accepted the declaration on the current socket. */
  accepted(): boolean;
}

/** Drain cadence while the page is changing, and while it is still. */
export const DRAIN_FAST_MS = 50;
export const DRAIN_IDLE_MS = 200;
/** How long after an event or an input the drain stays fast. */
const BUSY_WINDOW_MS = 2_000;

const UNARMED = 'unarmed';

// The page-side half. Plain strings and not functions passed through
// `toString()`: what the bundler does to a function body is not what the page
// should run. They avoid template literals for the same reason.

/** Hand the queued events over, or say the document has no recorder yet. */
export const DRAIN_JS =
  "(function(){var h=window.__topicsDomHost;if(!h)return 'unarmed';if(!h.q.length)return '[]';" +
  'var q=h.q;h.q=[];return JSON.stringify(q);})()';

const STOP_JS =
  '(function(){var h=window.__topicsDomHost;if(h&&h.stop){try{h.stop()}catch(e){}}' +
  "window.__topicsDomHost=undefined;return 'ok'})()";

const SNAPSHOT_JS =
  "(function(){var h=window.__topicsDomHost;if(!h||!h.rrweb)return 'unarmed';" +
  "try{h.rrweb.record.takeFullSnapshot(true)}catch(e){return 'failed'}return 'ok'})()";

/**
 * Arm the recorder on the current document. Same options as the server's
 * Chromium recorder (browser-service.ts RRWEB_RECORD_START), so a mirror looks
 * the same whichever side records it: passwords masked, every keystroke echoed.
 * The bundle runs inside this function, so its `var rrweb` stays out of the
 * page's globals.
 */
export function armJs(bundle: string): string {
  return (
    "(function(){if(window.__topicsDomHost)return 'armed';" +
    'var h=window.__topicsDomHost={q:[],stop:null,rrweb:null};' +
    'try{\n' + bundle + '\n;h.rrweb=rrweb;}catch(e){h.error=String(e&&e.message||e);return \'failed\'}' +
    'function start(){if(h.stop||!h.rrweb)return;try{h.stop=h.rrweb.record({' +
    'emit:function(e){h.q.push(e)},' +
    'inlineStylesheet:true,inlineImages:false,collectFonts:false,recordCanvas:false,' +
    'maskInputOptions:{password:true},' +
    "sampling:{mousemove:50,scroll:100,media:400,input:'all'}" +
    '})}catch(e){h.error=String(e&&e.message||e)}}' +
    "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();" +
    "return 'armed'})()"
  );
}

/**
 * A viewer's input, run in the page at the page coordinates it sent. Synthetic
 * events, so what needs a trusted gesture (a native <select> popup, a drag)
 * is out of reach; clicks, focus, text, the usual keys and scrolling are not.
 */
const INPUT_FN =
  'function(action,p){var d=document;' +
  'function at(x,y){return d.elementFromPoint(x,y)||d.body}' +
  'function fire(el,type,x,y,b){var init={bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,button:b,' +
  "buttons:/down$/.test(type)?(b===2?2:1):0,detail:1};" +
  "var ev=/^pointer/.test(type)&&window.PointerEvent?new PointerEvent(type,Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},init)):new MouseEvent(type,init);" +
  'return el.dispatchEvent(ev)}' +
  'function focusable(el){for(var n=el;n&&n!==d.body;n=n.parentElement){' +
  "if(n.isContentEditable||/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName)||n.tabIndex>=0)return n}return null}" +
  "if(action==='click'){var x=+p.x||0,y=+p.y||0,b=p.button==='right'?2:p.button==='middle'?1:0,el=at(x,y);" +
  "fire(el,'pointerdown',x,y,b);var go=fire(el,'mousedown',x,y,b);" +
  'if(go){var f=focusable(el);if(f&&f.focus)f.focus({preventScroll:true});' +
  'else if(d.activeElement&&d.activeElement!==d.body&&d.activeElement.blur)d.activeElement.blur()}' +
  "fire(el,'pointerup',x,y,b);fire(el,'mouseup',x,y,b);fire(el,b===2?'contextmenu':'click',x,y,b);return 'ok'}" +
  "if(action==='type'){var t=String(p.text||'');if(!d.execCommand('insertText',false,t)){var a=d.activeElement;" +
  "if(a&&'value' in a){a.value+=t;a.dispatchEvent(new Event('input',{bubbles:true}))}}return 'ok'}" +
  "if(action==='keypress'){var k=String(p.key||''),a2=d.activeElement||d.body;" +
  "if(a2.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}))){" +
  "if(k==='Enter'){if(a2.tagName==='TEXTAREA'||a2.isContentEditable)d.execCommand('insertLineBreak');" +
  'else if(a2.form){if(a2.form.requestSubmit)a2.form.requestSubmit();else a2.form.submit()}}' +
  "else if(k==='Backspace')d.execCommand('delete');else if(k==='Delete')d.execCommand('forwardDelete')}" +
  "a2.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true}));return 'ok'}" +
  "if(action==='scroll'){var sx=+p.x||0,sy=+p.y||0,dx=+p.deltaX||0,dy=+p.deltaY||0,tg=at(sx,sy);" +
  "if(!tg.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:sx,clientY:sy,deltaX:dx,deltaY:dy})))return 'ok';" +
  'for(var n=tg;n&&n!==d.documentElement;n=n.parentElement){var cs=getComputedStyle(n);' +
  'if(/(auto|scroll|overlay)/.test(cs.overflowY+cs.overflowX)&&(n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth)){' +
  "var top=n.scrollTop,left=n.scrollLeft;n.scrollBy(dx,dy);if(n.scrollTop!==top||n.scrollLeft!==left)return 'ok'}}" +
  "window.scrollBy(dx,dy);return 'ok'}" +
  "return 'unknown'}";

export function inputJs(action: string, payload: unknown): string {
  return `(${INPUT_FN})(${JSON.stringify(action)},${JSON.stringify(payload ?? {})})`;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function createNativeDomHost(opts: NativeDomHostOptions): NativeDomHost {
  const schedule = opts.schedule ?? defaultSchedule;
  const now = opts.now ?? (() => Date.now());

  let accepted = false;
  let recording = false;
  let draining = false;
  let cancelTick: (() => void) | null = null;
  let lastBusyAt = -Infinity;
  let page: HostPageState | null = null;
  let recorder: Promise<string> | null = null;
  let inputs: Promise<void> = Promise.resolve();
  /** Laid out at another device's size, and which request of the server that is. */
  let driven = false;
  let viewportSeq = 0;

  const sendPage = (): void => {
    if (accepted && page) opts.sendText(JSON.stringify({ type: 'host_page', ...page }));
  };

  const setRecording = (on: boolean): void => {
    if (recording === on) return;
    recording = on;
    opts.onRecordingChange?.(on);
    if (!on && cancelTick) { cancelTick(); cancelTick = null; }
  };

  const arm = async (): Promise<void> => {
    // A failed download is retried on the next drain, not cached forever.
    recorder ??= opts.loadRecorder().catch((err: unknown) => { recorder = null; throw err; });
    await opts.evalInPage(armJs(await recorder));
  };

  const plan = (ms: number): void => {
    if (!recording) return;
    if (cancelTick) cancelTick();
    cancelTick = schedule(() => { cancelTick = null; void drain(); }, ms);
  };

  const drain = async (): Promise<void> => {
    if (!recording) return;
    let armed = false;
    if (!draining) {
      draining = true;
      try {
        const raw = await opts.evalInPage(DRAIN_JS);
        if (raw === UNARMED) {
          if (recording) { await arm(); armed = true; }
        } else if (recording && raw && raw !== '[]') {
          lastBusyAt = now();
          opts.sendText(`{"type":"host_dom_events","events":${raw}}`);
        }
      } catch {
        // The page is between documents, or the recorder failed to download:
        // the next drain tries again.
      } finally {
        draining = false;
      }
    }
    // A recorder armed on a loaded page has its Meta + FullSnapshot queued
    // already: the viewers are waiting for exactly those.
    plan(armed ? 0 : now() - lastBusyAt < BUSY_WINDOW_MS ? DRAIN_FAST_MS : DRAIN_IDLE_MS);
  };

  /** Back to the pane's own slot, superseding any size still in the queue. */
  const release = (): boolean => {
    if (!driven) return false;
    driven = false;
    viewportSeq++;
    opts.setViewport?.(null);
    return true;
  };

  const runInput = (action: string, payload: unknown): void => {
    inputs = inputs.then(async () => {
      try {
        await opts.evalInPage(inputJs(action, payload), true);
      } catch { /* a page that navigated away under the tap */ }
      lastBusyAt = now();
      // What the input changed is in the queue already, or about to be: drain now.
      plan(0);
    });
  };

  return {
    declare() {
      accepted = false;
      opts.sendText(JSON.stringify({ type: 'native_dom_host' }));
    },
    handle(frame) {
      if (!frame || typeof frame !== 'object') return false;
      const m = frame as { type?: string; action?: string; payload?: unknown; url?: string };
      switch (m.type) {
        case 'native_dom_host_ack':
          accepted = true;
          opts.onAccepted?.();
          sendPage();
          return true;
        case 'host_dom_start':
          setRecording(true);
          lastBusyAt = now();
          // Always a fresh recorder: one left running by a socket that died
          // would go on queueing increments of a snapshot nobody has, and never
          // send the Meta + FullSnapshot a new mirror needs.
          void opts.evalInPage(STOP_JS).catch(() => {}).finally(() => plan(0));
          return true;
        case 'host_dom_stop':
          setRecording(false);
          void opts.evalInPage(STOP_JS).catch(() => {});
          return true;
        case 'host_dom_snapshot':
          void opts.evalInPage(SNAPSHOT_JS).then((r) => (r === UNARMED ? arm() : undefined)).catch(() => {});
          plan(0);
          return true;
        case 'host_input':
          if (typeof m.action === 'string') runInput(m.action, m.payload);
          return true;
        case 'host_viewport': {
          const v = frame as { width?: unknown; height?: unknown };
          const size = typeof v.width === 'number' && typeof v.height === 'number' && v.width > 0 && v.height > 0
            ? { width: v.width, height: v.height }
            : null;
          driven = size !== null;
          const seq = ++viewportSeq;
          // After the inputs already queued: they were aimed at the layout the
          // viewer was looking at when it touched the page, not at its own.
          inputs = inputs.then(() => { if (seq === viewportSeq) opts.setViewport?.(size); });
          return true;
        }
        case 'host_nav':
          if (m.action === 'navigate' && typeof m.url === 'string') opts.navigate('navigate', m.url);
          else if (m.action === 'back' || m.action === 'forward' || m.action === 'reload') opts.navigate(m.action);
          return true;
        default:
          return false;
      }
    },
    notePage(next) {
      if (page && page.url === next.url && page.title === next.title
        && page.canGoBack === next.canGoBack && page.canGoForward === next.canGoForward) return;
      page = next;
      sendPage();
    },
    reset() {
      accepted = false;
      if (recording) void opts.evalInPage(STOP_JS).catch(() => {});
      setRecording(false);
      // Nobody can be told the Mac took it back, and the server that comes
      // back says again who is using the page (browser-host-viewport.ts).
      release();
    },
    noteLocalUse() {
      if (release() && accepted) opts.sendText(JSON.stringify({ type: 'host_local_use' }));
    },
    accepted: () => accepted,
  };
}
