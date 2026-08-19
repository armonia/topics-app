// Verifica la logica del nuovo innerText estraendola dal bootstrap patchato,
// su un DOM finto con la stessa forma di quello di Obscura. Nessuna build.
import { readFileSync } from "node:fs";
const src = readFileSync(process.env.JCODE_SCRATCH_DIR + "/obscura-src/crates/obscura-js/js/bootstrap.js","utf8");
const i = src.indexOf("  get innerText() {");
const j = src.indexOf("  set innerText(v)", i);
const body = src.slice(i, j);

// DOM finto: nodeType/tagName/childNodes/data/hasAttribute, come il vero
class T { constructor(d){this.nodeType=3;this.data=d;} }
class E {
  constructor(tag, kids=[], style={}, attrs={}) {
    this.nodeType=1; this.tagName=tag; this.childNodes=kids; this._style=style; this._attrs=attrs;
  }
  hasAttribute(n){ return n in this._attrs; }
}
globalThis.getComputedStyle = (el) => el._style || {};
const proto = {};
eval(`proto.__defineGetter__("innerText", function(){ ${body.slice(body.indexOf("{")+1, body.lastIndexOf("}"))} });`);
const it = (node) => { const o = Object.create(proto); Object.assign(o, node); 
  // i getter usano this.nodeType/childNodes: copio anche i metodi
  o.hasAttribute = node.hasAttribute?.bind(node); return o.innerText; };

let pass=0, fail=0;
const check=(name,got,exp)=>{ const ok=JSON.stringify(got)===JSON.stringify(exp);
  console.log(`${ok?'PASS':'FAIL'}  ${name.padEnd(42)} ${ok?'':`\n        got=${JSON.stringify(got)}\n        exp=${JSON.stringify(exp)}`}`);
  ok?pass++:fail++; };

// 1. IL BUG: script e style non devono comparire
check("script escluso",
  it(new E("BODY",[ new E("P",[new T("visibile")]), new E("SCRIPT",[new T("var x=1;alert('no')")]) ])),
  "visibile");
check("style escluso",
  it(new E("BODY",[ new E("STYLE",[new T("body{color:red}")]), new E("P",[new T("testo")]) ])),
  "testo");

// 2. display:none e visibility:hidden
check("display:none escluso",
  it(new E("BODY",[ new E("P",[new T("si")]), new E("P",[new T("no")],{display:"none"}) ])),
  "si");
check("visibility:hidden escluso",
  it(new E("BODY",[ new E("P",[new T("si")]), new E("P",[new T("no")],{visibility:"hidden"}) ])),
  "si");
check("attributo hidden escluso",
  it(new E("BODY",[ new E("P",[new T("si")]), new E("P",[new T("no")],{},{hidden:""}) ])),
  "si");

// 3. i blocchi vanno a capo, gli inline no
check("blocchi separati da newline",
  it(new E("BODY",[ new E("P",[new T("uno")]), new E("P",[new T("due")]) ])),
  "uno\ndue");
check("span inline NON va a capo",
  it(new E("P",[ new T("ciao "), new E("SPAN",[new T("mondo")]) ])),
  "ciao mondo");
check("br va a capo",
  it(new E("P",[ new T("a"), new E("BR"), new T("b") ])),
  "a\nb");

// 4. whitespace collassato come fa un browser
check("spazi collassati",
  it(new E("P",[new T("   troppi     spazi   ")])),
  "troppi spazi");

// 5. non-regressione: testo normale intatto
check("testo semplice invariato",
  it(new E("DIV",[new T("Hello World")])),
  "Hello World");
check("nesting profondo",
  it(new E("DIV",[ new E("DIV",[ new E("P",[new T("dentro")]) ]) ])),
  "dentro");

// 6. commenti ignorati
check("commento ignorato",
  it(new E("P",[ {nodeType:8, data:"un commento"}, new T("testo") ])),
  "testo");

console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail?1:0);
