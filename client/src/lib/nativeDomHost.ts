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
  /** Text frames on the executor socket. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INVALID_JSON = Symbol('invalid-json');

function copyJsonValue(value: unknown): unknown | typeof INVALID_JSON {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON;
  if (!Array.isArray(value) && !isRecord(value)) return INVALID_JSON;

  const root: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  const pending: Array<{ source: unknown[] | Record<string, unknown>; target: unknown[] | Record<string, unknown> }> = [
    { source: value, target: root },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = Array.isArray(current.source)
      ? current.source.map((item, index) => [String(index), item] as const)
      : Object.entries(current.source);
    for (const [key, item] of entries) {
      if (!Array.isArray(current.source) && (key === '__proto__' || key === 'constructor' || key === 'prototype')) return INVALID_JSON;
      let copied: unknown;
      if (item === null || typeof item === 'string' || typeof item === 'boolean') copied = item;
      else if (typeof item === 'number') {
        if (!Number.isFinite(item)) return INVALID_JSON;
        copied = item;
      } else if (Array.isArray(item) || isRecord(item)) {
        copied = Array.isArray(item) ? [] : {};
        pending.push({ source: item, target: copied as unknown[] | Record<string, unknown> });
      } else return INVALID_JSON;

      if (Array.isArray(current.target)) current.target[Number(key)] = copied;
      else current.target[key] = copied;
    }
  }
  return root;
}

function sanitizeRrwebEvent(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) || !isRecord(value.data)) return null;
  if (Object.keys(value).some((key) => !['type', 'timestamp', 'data'].includes(key))) return null;
  const type = value.type;
  if (typeof type !== 'number' || !Number.isInteger(type) || ![0, 1, 2, 3, 4].includes(type)) return null;
  if (type === 2 && !isRecord(value.data.node)) return null;
  if (type === 3 && (typeof value.data.source !== 'number' || !Number.isInteger(value.data.source) || value.data.source < 0 || value.data.source > 16)) return null;
  if (type === 4 && (typeof value.data.href !== 'string' || typeof value.data.width !== 'number' || !Number.isFinite(value.data.width) || typeof value.data.height !== 'number' || !Number.isFinite(value.data.height))) return null;
  const data = copyJsonValue(value.data);
  if (data === INVALID_JSON || !isRecord(data)) return null;
  return { type, timestamp: value.timestamp, data };
}

function parseHostEvents(raw: string): Record<string, unknown>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(sanitizeRrwebEvent).filter((event): event is Record<string, unknown> => event !== null);
}

const STOP_JS =
  '(function(){var h=window.__topicsDomHost;if(h&&h.stop){try{h.stop()}catch(e){}}' +
  "window.__topicsDomHost=undefined;return 'ok'})()";

const SNAPSHOT_JS =
  "(function(){var h=window.__topicsDomHost;if(!h||!h.rrweb)return 'unarmed';" +
  "try{h.rrweb.record.takeFullSnapshot(true)}catch(e){return 'failed'}return 'ok'})()";

/**
 * Where a viewer laid out at its own size keeps its place, read on this side
 * (BROWSER-DOM-LAYOUT-03; the viewer's half is lib/mirrorLayout.ts, the same
 * reading). Pixels mean nothing across two layouts, content does: the element
 * at the reading line of what scrolled, a quarter down past fixed and sticky
 * headers, and the point of it there; at the start, the start. Installed on `h` with the recorder:
 * `anchor` names this page's place (and whether what scrolled is the page's
 * main column, the box under the middle of the window), `place` finds where a
 * viewer's place lands here: in what scrolled there, when it scrolls along the
 * reading axis here too; else, for the page or its main column only and by
 * content alone, in the nearest box that scrolls that content along the
 * reading axis here; else nowhere, so a strip or a side panel the viewer
 * scrolled, or an element pinned in place, never moves this page. `echo` gives a viewer its own place back while the page
 * is still where that place put it, so the mirror recognises its own scroll in
 * the echo instead of a neighbour's element measured in another layout. Once
 * the page moves away from it, that place is forgotten.
 */
const LAYOUT_JS =
  'function rt(p,m){return!(m>0)||p<=0?0:p>=m-1?1:p/m}' +
  'function sc(n){var d=n.nodeType===9?n:n.ownerDocument,se=d.scrollingElement||d.documentElement;' +
  'return{el:n.nodeType===9?se:n,top:n.nodeType===9||n===se,d:d}}' +
  "function po(d,y){var w=d.defaultView,f=function(e){if(!e)return undefined;var st=w.getComputedStyle(e);return y?st.overflowY:st.overflowX}," +
  "r=f(d.documentElement);return r&&r!=='visible'?r:f(d.body)}" +
  "function can(s,ax,clip){var el=s.el,y=ax==='y',room=y?el.scrollHeight-el.clientHeight:el.scrollWidth-el.clientWidth,o;" +
  "if(!(room>0))return false;if(s.top){o=po(s.d,y);return o!=='clip'&&(clip||o!=='hidden')}" +
  "var st=s.d.defaultView.getComputedStyle(el);o=y?st.overflowY:st.overflowX;return o==='auto'||o==='scroll'||o==='overlay'||(clip&&o==='hidden')}" +
  "function pin(m,stop,w){for(var e=m;e&&e!==stop&&e.nodeType===1;e=e.parentElement){var p=w.getComputedStyle(e).position;if(p==='fixed'||p==='sticky')return true}return false}" +
  'function box(s){var el=s.el;if(s.top){var de=s.d.documentElement,w=s.d.defaultView;' +
  'return{l:0,t:0,w:de.clientWidth||w.innerWidth,h:de.clientHeight||w.innerHeight}}' +
  'var r=el.getBoundingClientRect();return{l:r.left+el.clientLeft,t:r.top+el.clientTop,w:el.clientWidth,h:el.clientHeight}}' +
  'function main(s){var de=s.d.documentElement,w=de.clientWidth||s.d.defaultView.innerWidth,' +
  'v=de.clientHeight||s.d.defaultView.innerHeight,hit=w>0&&v>0?s.d.elementFromPoint(w/2,v/2):null;return!!hit&&s.el.contains(hit)}' +
  'function cont(s,ax,m,a){var r=m.getBoundingClientRect();if(!(r.width>0&&r.height>0)||!(s.top||s.el.contains(m)))return null;' +
  "var b=box(s),el=s.el,q={el:el};if(ax.indexOf('y')>=0)q.t=el.scrollTop+r.top+(+a.fy||0)*r.height-(b.t+a.ly*b.h);" +
  "if(ax.indexOf('x')>=0)q.l=el.scrollLeft+r.left+(+a.fx||0)*r.width-(b.l+a.lx*b.w);return q}" +
  'h.anchor=function(n){var s=sc(n),el=s.el,d=s.d,b=box(s),mx=el.scrollWidth-el.clientWidth,my=el.scrollHeight-el.clientHeight,' +
  'a={lx:mx>0?.25:.5,ly:my>0?.25:.5,rx:rt(el.scrollLeft,mx),ry:rt(el.scrollTop,my)},' +
  'px=b.l+a.lx*b.w,py=b.t+a.ly*b.h,ids=h.rrweb.record.mirror,win=d.defaultView,seen=new Map(),' +
  'list=d.elementsFromPoint?d.elementsFromPoint(px,py):[];if(!s.top&&main(s))a.main=true;' +
  'function pinned(e){var path=[],res=false;for(var m=e;m&&m!==el&&m.nodeType===1;m=m.parentElement){' +
  "if(seen.has(m)){res=seen.get(m);break}path.push(m);var p=win.getComputedStyle(m).position;if(p==='fixed'||p==='sticky'){res=true;break}}" +
  'for(var j=0;j<path.length;j++)seen.set(path[j],res);return res}' +
  'for(var i=0;i<list.length;i++){var e=list[i];' +
  'if(e===el||e===d.body||e===d.documentElement||(!s.top&&!el.contains(e))||pinned(e))continue;' +
  'var m=e;while(m&&m!==el&&ids.getId(m)<0)m=m.parentElement;' +
  'if(!m||m===el||m===d.body)continue;var r=m.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;' +
  'a.id=ids.getId(m);a.fx=(px-r.left)/r.width;a.fy=(py-r.top)/r.height;return a}return a};' +
  "h.place=function(n,a){var s0=sc(n),m=typeof a.id==='number'?h.rrweb.record.mirror.getNode(a.id):null;" +
  'm=m&&m.nodeType===1&&m.isConnected&&m.ownerDocument===s0.d?m:null;' +
  "var axes=[];if(a.ly<.5)axes.push('y');if(a.lx<.5)axes.push('x');var ld=axes[0];if(!ld)return null;" +
  'if(can(s0,ld,true)){var here=axes.filter(function(x){return can(s0,x,true)}),el=s0.el,c=m?cont(s0,here,m,a):null,' +
  'q={el:el},ry=+a.ry||0,rx=+a.rx||0;' +
  "if(here.indexOf('y')>=0)q.t=ry>0&&c&&c.t!==undefined?c.t:ry*Math.max(0,el.scrollHeight-el.clientHeight);" +
  "if(here.indexOf('x')>=0)q.l=rx>0&&c&&c.l!==undefined?c.l:rx*Math.max(0,el.scrollWidth-el.clientWidth);return q}" +
  'if(!m||!(s0.top||a.main))return null;var se=s0.d.scrollingElement||s0.d.documentElement,s={el:se,top:true,d:s0.d};' +
  'for(var e=m.parentElement;e&&e!==se;e=e.parentElement){var o={el:e,top:false,d:s0.d};if(can(o,ld,false)){s=o;break}}' +
  'if(!can(s,ld,false)||pin(m,s.el,s0.d.defaultView))return null;' +
  'return cont(s,axes.filter(function(x){return can(s,x,false)}),m,a)};' +
  'h.echo=function(id){var n=h.rrweb.record.mirror.getNode(id);if(!n)return undefined;var el=sc(n).el,p=h.placed;' +
  'if(p&&p.node===id){if(el.scrollTop===p.t&&el.scrollLeft===p.l)return p.a;h.placed=null}return h.anchor(n)};';

/**
 * Arm the recorder on the current document. Same options as the server's
 * Chromium recorder (browser-service.ts RRWEB_RECORD_START), so a mirror looks
 * the same whichever side records it: passwords masked, every keystroke echoed.
 * The bundle runs inside this function, so its `var rrweb` stays out of the
 * page's globals. Scroll events and snapshots leave with the place they show
 * (LAYOUT_JS); a new snapshot renumbers the nodes, so the place a viewer sent
 * before it is forgotten.
 */
export function armJs(bundle: string): string {
  return (
    "(function(){var previous=window.__topicsDomHost;try{if(previous){previous.rrweb=null;if(previous.stop)previous.stop()}}catch(e){}" +
    'var h=window.__topicsDomHost={q:[],stop:null,rrweb:null,placed:null};' +
    'try{\n' + bundle + '\n;h.rrweb=rrweb;}catch(e){h.error=String(e&&e.message||e);return \'failed\'}' +
    LAYOUT_JS +
    "function privateInput(n){if(!n)return false;var v;try{v=n.getAttribute?n.getAttribute('autocomplete'):n.attributes&&n.attributes.autocomplete}catch(e){}return typeof v==='string'&&['cc-number','cc-csc','cc-exp','cc-exp-month','cc-exp-year','one-time-code'].indexOf(v.toLowerCase())>=0}" +
    "function maskInput(v){return typeof v==='string'?'*'.repeat(v.length):v}" +
    'function maskSnapshot(n){if(!n||typeof n!==\'object\')return;if(n.type===2&&String(n.tagName).toLowerCase()===\'input\'&&privateInput(n))n.attributes.value=maskInput(n.attributes.value);' +
    'if(Array.isArray(n.childNodes))for(var i=0;i<n.childNodes.length;i++)maskSnapshot(n.childNodes[i])}' +
    'function start(){if(h.stop||!h.rrweb)return;try{h.stop=h.rrweb.record({' +
    'emit:function(e){try{var v=e.data;if(e.type===3&&v&&v.source===3)v.anchor=h.echo(v.id);' +
    'else if(e.type===2&&v&&v.node){maskSnapshot(v.node);h.placed=null;v.anchor=h.anchor(h.rrweb.record.mirror.getNode(v.node.id))}' +
    'else if(e.type===3&&v&&v.source===5&&privateInput(h.rrweb.record.mirror.getNode(v.id)))v.text=maskInput(v.text);' +
    // A field mounted after the snapshot, or a value set as an attribute, travels as a mutation.
    'else if(e.type===3&&v&&v.source===0){var a=v.adds||[],t=v.attributes||[],k;for(k=0;k<a.length;k++)maskSnapshot(a[k]&&a[k].node);' +
    "for(k=0;k<t.length;k++)if(t[k]&&t[k].attributes&&typeof t[k].attributes.value==='string'&&privateInput(h.rrweb.record.mirror.getNode(t[k].id)))t[k].attributes.value=maskInput(t[k].attributes.value)}" +
    '}catch(x){}h.q.push(e)},' +
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
 *
 * A scroll the viewer's mirror already made comes with what it scrolled (the
 * recorder's id) and where it put it, and the page goes to that same pixel
 * (BROWSER-DOM-SCROLL-02). Replaying the distance instead lost ground on both
 * sides: WebKit keeps whole pixels, so 2.7 px a frame moved the mirror 2 and
 * the page, summing a batch, 10 of 10.8, and the mirror jumped to the page
 * when the gesture ended. Instant, because a page with `scroll-behavior:
 * smooth` restarted its animation on every batch and fell short. A page that
 * stays put (it took the wheel, it is shorter) still answers with a scroll
 * event, so the mirror learns where it really is.
 *
 * A mirror laid out at its own size (BROWSER-DOM-LAYOUT-01) has the page's
 * elements elsewhere, so its input names them. A tap comes with the element it
 * landed on and the point inside its box, and lands on that element, at that
 * point of it: never on what this layout draws there instead (a link inside
 * the paragraph that was tapped), and also when it has no box here at all (a
 * menu only the narrow layout shows: its handler still runs). An element the
 * page no longer has is not traded for whatever sits at the mirror's pixel. A
 * wheel goes to what was under it. A scroll comes with the mirror's place
 * (LAYOUT_JS) and the page goes there; what the page was told is remembered,
 * so its echo can say the same.
 */
const INPUT_FN =
  'function(action,p){var d=document,h=window.__topicsDomHost,ids=h&&h.rrweb&&h.rrweb.record&&h.rrweb.record.mirror;' +
  'function at(x,y){return d.elementFromPoint(x,y)||d.body}' +
  "function node(id){var n=typeof id==='number'&&ids?ids.getNode(id):null;return n&&n.nodeType===1&&n.isConnected?n:null}" +
  "function aim(p){var n=node(p.node),x=+p.x||0,y=+p.y||0;if(!n)return typeof p.fx==='number'?null:{el:at(x,y),x:x,y:y};" +
  'var r=n.getBoundingClientRect();if(r.width>0||r.height>0){x=r.left+(+p.fx||0)*r.width;y=r.top+(+p.fy||0)*r.height}' +
  'return{el:n,x:x,y:y}}' +
  "function to(el,t,l){try{el.scrollTo({top:t,left:l,behavior:'instant'})}catch(e){el.scrollTop=t;el.scrollLeft=l}}" +
  "function by(el,x,y){try{el.scrollBy({left:x,top:y,behavior:'instant'})}catch(e){el.scrollLeft+=x;el.scrollTop+=y}}" +
  'function fire(el,type,x,y,b){var init={bubbles:true,cancelable:true,composed:true,view:window,clientX:x,clientY:y,button:b,' +
  "buttons:/down$/.test(type)?(b===2?2:1):0,detail:1};" +
  "var ev=/^pointer/.test(type)&&window.PointerEvent?new PointerEvent(type,Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},init)):new MouseEvent(type,init);" +
  'return el.dispatchEvent(ev)}' +
  'function focusable(el){for(var n=el;n&&n!==d.body;n=n.parentElement){' +
  "if(n.isContentEditable||/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName)||n.tabIndex>=0)return n}return null}" +
  "if(action==='click'){var b=p.button==='right'?2:p.button==='middle'?1:0,g=aim(p);if(!g)return 'gone';var el=g.el,x=g.x,y=g.y;" +
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
  "if(action==='scroll'){var dx=+p.deltaX||0,dy=+p.deltaY||0,tg=null,go=true," +
  'ws=p.wheels||[{x:p.x,y:p.y,deltaX:dx,deltaY:dy,target:p.target}];' +
  'for(var i=0;i<ws.length;i++){var w=ws[i],wx=+w.x||0,wy=+w.y||0,we=node(w.target);' +
  'if(we){var wr=we.getBoundingClientRect();wx=wr.left+wr.width/2;wy=wr.top+wr.height/2}else we=at(wx,wy);tg=we;' +
  "if(!we.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:wx,clientY:wy,deltaX:+w.deltaX||0,deltaY:+w.deltaY||0})))go=false}" +
  "var sn=typeof p.node==='number'&&(p.anchor||typeof p.scrollTop==='number')&&ids?ids.getNode(p.node):null;" +
  'if(sn){var doc=sn.nodeType===9?sn:sn===sn.ownerDocument.scrollingElement?sn.ownerDocument:null,' +
  'el=doc?doc.scrollingElement||doc.documentElement:sn,bt=el.scrollTop,bl=el.scrollLeft;' +
  'if(go&&p.anchor&&h.place){var q=h.place(sn,p.anchor);if(q){if(q.el!==el){el=q.el;doc=el===d.scrollingElement?d:null;bt=el.scrollTop;bl=el.scrollLeft}' +
  'to(el,q.t===undefined?el.scrollTop:q.t,q.l===undefined?el.scrollLeft:q.l);h.placed={node:ids.getId(doc||el),a:p.anchor,t:el.scrollTop,l:el.scrollLeft}}}' +
  'else if(go&&!p.anchor)to(el,p.scrollTop,+p.scrollLeft||0);' +
  "if(el.scrollTop===bt&&el.scrollLeft===bl)(doc||el).dispatchEvent(new Event('scroll'));return 'ok'}" +
  "if(!go)return 'ok';" +
  'for(var n=tg;n&&n!==d.documentElement;n=n.parentElement){var cs=getComputedStyle(n);' +
  'if(/(auto|scroll|overlay)/.test(cs.overflowY+cs.overflowX)&&(n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth)){' +
  "var top=n.scrollTop,left=n.scrollLeft;by(n,dx,dy);if(n.scrollTop!==top||n.scrollLeft!==left)return 'ok'}}" +
  "by(d.scrollingElement||d.documentElement,dx,dy);return 'ok'}" +
  "return 'unknown'}";

export function inputJs(action: string, payload: unknown): string {
  return `(${INPUT_FN})(${JSON.stringify(action)},${JSON.stringify(payload ?? {})})`;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const wheelOf = (p: Record<string, unknown>) => ({
  x: num(p.x),
  y: num(p.y),
  deltaX: num(p.deltaX),
  deltaY: num(p.deltaY),
  ...(typeof p.target === 'number' ? { target: p.target } : {}),
});

/**
 * Fold a newer scroll into one still queued. Two distances add up; two places
 * for the same node leave the newer one, a pixel or an anchor. A place and a
 * distance do not mix: the distance would be applied from where the page is,
 * not from that place. Each wheel still reaches the page as its own event, in
 * the one call: a carousel that steps once per event must not lose steps to a
 * busy Mac.
 */
function mergeScroll(into: Record<string, unknown>, next: unknown): boolean {
  const n = (next ?? {}) as Record<string, unknown>;
  const placed = typeof n.node === 'number';
  if (placed !== (typeof into.node === 'number') || (placed && n.node !== into.node)) return false;
  into.wheels = [...((into.wheels as unknown[] | undefined) ?? [wheelOf(into)]), wheelOf(n)];
  into.deltaX = num(into.deltaX) + num(n.deltaX);
  into.deltaY = num(into.deltaY) + num(n.deltaY);
  into.x = n.x;
  into.y = n.y;
  into.target = n.target;
  if (placed) {
    into.scrollTop = n.scrollTop;
    into.scrollLeft = n.scrollLeft;
    into.anchor = n.anchor;
  }
  return true;
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
  /** The last input queued, while it has not run yet. */
  let waiting: { action: string; payload: Record<string, unknown> } | null = null;
  /** Laid out at another device's size, and which request of the server that is. */
  let driven = false;
  let viewportSeq = 0;
  /** The Mac's user used the page while no server could be told. */
  let usedAway = false;

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
          const events = parseHostEvents(raw);
          if (events.length) {
            lastBusyAt = now();
            opts.sendText(JSON.stringify({ type: 'host_dom_events', events }));
          }
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
    // A scroll still waiting for its turn takes in the next one: one call to
    // the page, every wheel event still in it. A page slower than the viewer's
    // relay (a busy Mac) otherwise replayed a swipe batch by batch long after
    // it ended, and the mirror went back to follow it.
    if (action === 'scroll' && waiting?.action === 'scroll' && mergeScroll(waiting.payload, payload)) return;
    const job = { action, payload: { ...(payload as Record<string, unknown>) } };
    waiting = job;
    inputs = inputs.then(async () => {
      if (waiting === job) waiting = null;
      try {
        await opts.evalInPage(inputJs(job.action, job.payload), true);
      } catch { /* a page that navigated away under the tap */ }
      lastBusyAt = now();
      // What the input changed is in the queue already, or about to be: drain now.
      plan(0);
    });
  };

  return {
    declare() {
      accepted = false;
      // A use while the socket was down: the server must not lay the page out
      // again for the device that was using it before. Taken before sending,
      // so the answer finds it said.
      const used = usedAway;
      usedAway = false;
      opts.sendText(JSON.stringify(used ? { type: 'native_dom_host', used: true } : { type: 'native_dom_host' }));
    },
    handle(frame) {
      if (!frame || typeof frame !== 'object') return false;
      const m = frame as { type?: string; action?: string; payload?: unknown; url?: string };
      switch (m.type) {
        case 'native_dom_host_ack':
          accepted = true;
          opts.onAccepted?.();
          sendPage();
          // Used between the declaration and its answer.
          if (usedAway) {
            usedAway = false;
            opts.sendText(JSON.stringify({ type: 'host_local_use' }));
          }
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
          // A scroll after this is aimed at the new layout: it must not merge into one before it.
          waiting = null;
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
      release();
      // Said every time, laid out for another device or not: the server may
      // already count a device as using the page while its size is on the way,
      // and a use it never hears of would let that size land after it.
      if (accepted) opts.sendText(JSON.stringify({ type: 'host_local_use' }));
      else usedAway = true;
    },
    accepted: () => accepted,
  };
}
