// Estrae la classe canvas patchata dal bootstrap e la prova senza compilare Rust.
import { readFileSync } from "node:fs";
const src = readFileSync(process.env.JCODE_SCRATCH_DIR + "/obscura-src/crates/obscura-js/js/bootstrap.js","utf8");
// prendo i metodi che mi servono e li incollo in una classe minima
const grab = (name, endMarker) => {
  const i = src.indexOf(name);
  if (i < 0) throw new Error("non trovo "+name);
  const j = src.indexOf(endMarker, i);
  return src.slice(i, j);
};
const body = grab("  _parseColor(css) {", "  getImageData(x, y, w, h) {")
           + grab("  beginPath() { this._path = []; }", "  clip() {}")
           + grab("  createLinearGradient(x0,y0,x1,y1) {", "  createPattern()");
const cls = `class C {
  constructor(w,h){this._w=w;this._h=h;this._buf=new Uint8ClampedArray(w*h*4);this.fillStyle='#000';this.strokeStyle='#000';this.lineWidth=1;this.globalAlpha=1;this.globalCompositeOperation='source-over';this.font='10px sans';this._stateStack=[];this._path=[];}
  _markPaintDamage(){}
${body}
  at(x,y){const i=(y*this._w+x)*4;return '#'+[this._buf[i],this._buf[i+1],this._buf[i+2]].map(v=>v.toString(16).padStart(2,'0')).join('');}
}
globalThis.__C = C;`;
const _fpRand = () => 0.5;
eval(cls);
const C = globalThis.__C;

let pass=0, fail=0;
const check=(name,got,exp)=>{ const ok=got===exp; console.log(`${ok?'PASS':'FAIL'}  ${name.padEnd(38)} got=${got} exp=${exp}`); ok?pass++:fail++; };

// 1. stroke di una linea orizzontale
{ const c=new C(200,60); c.fillStyle='#ffffff'; c.fillRect(0,0,200,60);
  c.strokeStyle='#0000ff'; c.lineWidth=10; c.beginPath(); c.moveTo(10,30); c.lineTo(190,30); c.stroke();
  check("stroke: linea orizzontale", c.at(100,30), "#0000ff");
  check("stroke: spessore lineWidth", c.at(100,26), "#0000ff");
  check("stroke: fuori dalla linea", c.at(100,50), "#ffffff"); }

// 2. stroke diagonale (il caso sparkline)
{ const c=new C(120,120); c.fillStyle='#ffffff'; c.fillRect(0,0,120,120);
  c.strokeStyle='#ff0000'; c.lineWidth=1; c.beginPath(); c.moveTo(0,0); c.lineTo(119,119); c.stroke();
  check("stroke: diagonale a meta'", c.at(60,60), "#ff0000"); }

// 3. gradiente lineare
{ const c=new C(100,20);
  const g=c.createLinearGradient(0,0,100,0); g.addColorStop(0,'#ff0000'); g.addColorStop(1,'#0000ff');
  c.fillStyle=g; c.fillRect(0,0,100,20);
  check("gradient: inizio rosso", c.at(0,10), "#ff0000");
  check("gradient: fine blu", c.at(99,10), "#0300fc");
  const mid=c.at(50,10);
  check("gradient: meta interpolata", mid, "#800080"); }

// 4. fill di un poligono (area chart)
{ const c=new C(100,100); c.fillStyle='#ffffff'; c.fillRect(0,0,100,100);
  c.fillStyle='#00ff00'; c.beginPath(); c.moveTo(10,10); c.lineTo(90,10); c.lineTo(90,90); c.lineTo(10,90); c.fill();
  check("fill: poligono dentro", c.at(50,50), "#00ff00");
  check("fill: poligono fuori", c.at(5,5), "#ffffff"); }

// 5. non regressione: fillRect con colore semplice
{ const c=new C(50,50); c.fillStyle='#123456'; c.fillRect(0,0,50,50);
  check("regressione: fillRect colore", c.at(25,25), "#123456"); }

// 6. non regressione: arc + fill
{ const c=new C(80,80); c.fillStyle='#ffffff'; c.fillRect(0,0,80,80);
  c.fillStyle='#ff00ff'; c.beginPath(); c.arc(40,40,20,0,Math.PI*2); c.fill();
  check("regressione: arc riempito", c.at(40,40), "#ff00ff");
  check("regressione: fuori dall'arc", c.at(5,5), "#ffffff"); }

// 7. stroke di un arco (cerchio vuoto)
{ const c=new C(80,80); c.fillStyle='#ffffff'; c.fillRect(0,0,80,80);
  c.strokeStyle='#000000'; c.lineWidth=3; c.beginPath(); c.arc(40,40,20,0,Math.PI*2); c.stroke();
  check("stroke: bordo del cerchio", c.at(60,40), "#000000");
  check("stroke: centro resta vuoto", c.at(40,40), "#ffffff"); }

console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail?1:0);
