import { chromium } from "playwright";
const b = await chromium.launch();
const exCheck = p => p.evaluate(()=>{
  const paper = document.documentElement.classList.contains("paper");
  let hits=0;
  document.querySelectorAll('section [aria-hidden="true"].pointer-events-none').forEach(host=>{
    const texts=[...host.parentElement.querySelectorAll("h1 > span,h2,h3,p,a,button,dl")].filter(e=>!host.contains(e)&&e.getBoundingClientRect().width);
    [...host.children].forEach(el=>{const r=el.getBoundingClientRect();
      if(paper){
        // clouds: bounding box must never touch a RAW text rect
        if(texts.some(e=>{const t=e.getBoundingClientRect();return !(r.right<t.left||r.left>t.right||r.bottom<t.top||r.top>t.bottom)}))hits++;
      } else {
        if(r.width>60)return; // nebula uses its own footprint clearance
        const cx=r.left+r.width/2, cy=r.top+r.height/2;
        if(texts.some(e=>{const t=e.getBoundingClientRect();return cx>t.left-58&&cx<t.right+58&&cy>t.top-58&&cy<t.bottom+58}))hits++;
      }
    });
  });
  return hits;
});
for (const [mode, width] of [["phosphor",1440],["paper",1440],["phosphor",390],["paper",390]]) {
  const ctx = await b.newContext({ viewport:{width,height:width===390?844:900}, deviceScaleFactor:2, colorScheme: mode==="paper"?"light":"dark", isMobile: width===390 });
  const p = await ctx.newPage();
  await p.addInitScript((m)=>{ try{sessionStorage.setItem("b0-hero-assembled","1");localStorage.setItem("b0-theme",m)}catch{} }, mode);
  await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
  await p.waitForTimeout(900);
  console.log(`${mode}@${width}: exclusion hits=${await exCheck(p)}`);
  await p.screenshot({ path:`docs/design-audit/shots/overhaul-${mode}-${width}.png`, clip:{x:0,y:0,width,height:width===390?844:860} });
  await ctx.close();
}
await b.close();
