import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2, colorScheme:"dark" });
const p = await ctx.newPage();
await p.addInitScript(()=>{ try{sessionStorage.setItem("b0-hero-assembled","1")}catch{} });

const theme = () => p.evaluate(()=>document.documentElement.classList.contains("paper")?"paper":"phosphor");
const audit = async (label) => {
  const r = await p.evaluate(()=>{
    const cur = document.documentElement.classList.contains("paper")?"paper":"phosphor";
    const tagged = [...document.querySelectorAll("[data-sky-theme]")];
    const wrong = tagged.filter(d=>d.dataset.skyTheme!==cur).length;
    const rgb = [...document.querySelectorAll("[data-sky-theme] span")].filter(s=>/rgb\(255, 0, 0\)|rgb\(0, 255, 0\)|rgb\(0, 0, 255\)/.test(s.style.background)).length;
    const fx = document.querySelectorAll("[data-fx]").length;
    return { cur, total: tagged.length, wrong, rgb, fx };
  });
  const ok = r.wrong===0 && r.rgb===0;
  console.log(`${ok?"PASS":"FAIL"} ${label}: theme=${r.cur} elements=${r.total} wrong-theme=${r.wrong} rgb=${r.rgb} fx=${r.fx}`);
  return r;
};
const flip = () => p.click('button[aria-label^="switch to"]');
const hide = () => p.evaluate(()=>{Object.defineProperty(document,"hidden",{value:true,configurable:true});document.dispatchEvent(new Event("visibilitychange"));});
const show = () => p.evaluate(()=>{Object.defineProperty(document,"hidden",{value:false,configurable:true});document.dispatchEvent(new Event("visibilitychange"));});
const W = (ms) => p.waitForTimeout(ms);
const SETTLE = 8800; // 4s delay + 1.8s stagger + .45s conv + watchdog margin

await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
await W(1000);
await audit("baseline resting (phosphor)");

// R1 · switch DURING RGB convergence (rapid toggle)
await flip(); await W(4300);
const mid = await p.evaluate(()=>[...document.querySelectorAll("[data-sky-theme] span")].filter(s=>/rgb\(255, 0, 0\)|rgb\(0, 255, 0\)|rgb\(0, 0, 255\)/.test(s.style.background)).length);
console.log(`  (R1 convergence confirmed in flight: ${mid} RGB spans)`);
await flip(); await W(1200);
await audit("R1 switch mid-convergence +1.2s");
await W(SETTLE); await audit("R1 after settle");

// R2 · switch DURING the empty window
await flip(); await W(1000); await flip(); await W(1200);
await audit("R2 switch mid-empty-window +1.2s");
await W(SETTLE); await audit("R2 after settle");

// R3 · rapid TRIPLE toggle
await flip(); await W(250); await flip(); await W(250); await flip();
await W(SETTLE); await audit("R3 triple-toggle after settle");

// R4 · switch DURING a bird crossing (now paper, ambient running)
await p.waitForSelector('[data-fx="bird"]',{timeout:30000});
console.log("  (R4 bird in flight)");
await flip(); await W(1200);
await audit("R4 switch mid-bird +1.2s");
await W(SETTLE); await audit("R4 after settle");

// R5 · switch DURING a meteor streak (phosphor)
let meteorCaught = true;
try {
  await p.waitForSelector('[data-fx="meteor"]',{timeout:45000,state:"attached"});
  console.log("  (R5 meteor in flight)");
} catch { meteorCaught = false; console.log("  (R5 no meteor within 45s — switching anyway)"); }
await flip(); await W(1200);
await audit("R5 switch mid-meteor +1.2s");
await W(SETTLE); await audit("R5 after settle");

// R6 · tab-hide DURING convergence, then return (paper→phosphor)
await flip(); await W(4300); await hide(); await W(1500); await show();
await W(SETTLE + 1000); await audit("R6 hide mid-convergence, return, settle");

// R7 · tab-hide DURING the empty window, then return
await flip(); await W(900); await hide(); await W(1500); await show();
await W(SETTLE + 1000); await audit("R7 hide mid-empty-window, return, settle");

// R8 · tab-hide DURING a bird crossing, then return (paper)
await p.waitForSelector('[data-fx="bird"]',{timeout:30000});
console.log("  (R8 bird in flight)");
await hide(); await W(1500); await show(); await W(1500);
await audit("R8 hide mid-bird, return");

// R9 · tab-hide DURING a meteor, then return (flip to phosphor first)
await flip(); await W(SETTLE);
try {
  await p.waitForSelector('[data-fx="meteor"]',{timeout:45000,state:"attached"});
  console.log("  (R9 meteor in flight)");
  await hide(); await W(1000); await show(); await W(1500);
} catch { console.log("  (R9 no meteor within 45s — hide/show anyway)"); await hide(); await W(1000); await show(); await W(1500); }
await audit("R9 hide mid-meteor, return");

// R10 · tab-hide during a triple-toggle settle, then return
await flip(); await W(250); await flip(); await W(250); await flip();
await W(2000); await hide(); await W(1500); await show();
await W(SETTLE + 1000); await audit("R10 hide mid-triple-toggle, return, settle");

console.log("final theme:", await theme(), "| meteorCaught:", meteorCaught);
await b.close();
