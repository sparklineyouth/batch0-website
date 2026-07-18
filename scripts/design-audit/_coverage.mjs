import { chromium } from "playwright";
const b = await chromium.launch();
for (const [mode, width, height] of [["phosphor",1440,900],["paper",1440,900],["phosphor",390,844],["paper",390,844]]) {
  const ctx = await b.newContext({ viewport:{width,height}, deviceScaleFactor:2, colorScheme: mode==="paper"?"light":"dark", isMobile: width===390 });
  const p = await ctx.newPage();
  await p.addInitScript((m)=>{ try{sessionStorage.setItem("b0-hero-assembled","1");localStorage.setItem("b0-theme",m)}catch{} }, mode);
  await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
  await p.waitForTimeout(900);

  const r = await p.evaluate(()=>{
    const paper = document.documentElement.classList.contains("paper");
    const out = { zones: [], touch: 0, fold: null, fringe: 0, sway: null };
    document.querySelectorAll('section [aria-hidden="true"].pointer-events-none').forEach(host=>{
      const hr = host.getBoundingClientRect();
      if (!hr.width || !hr.height) return;
      const texts=[...host.parentElement.querySelectorAll("h1 > span,h2,h3,p,a,button,dl")].filter(e=>!host.contains(e)&&e.getBoundingClientRect().width);
      const rects = texts.map(e=>{const t=e.getBoundingClientRect();const pad=e.matches("a,button")?40:24;
        return {l:t.left-pad,t:t.top-pad,r:t.right+pad,b:t.bottom+pad,raw:t};});
      // touching check: element box vs RAW text boxes
      const els=[...host.children].filter(e=>{const w=e.getBoundingClientRect().width;return w&&w<=200;});
      els.forEach(el=>{const r2=el.getBoundingClientRect();
        if(rects.some(t=>!(r2.right<t.raw.left||r2.left>t.raw.right||r2.bottom<t.raw.top||r2.top>t.raw.bottom)))out.touch++;});
      // 3x3 coverage: region empty AND not >70% excluded => fail
      const zone = { total: els.length, empty: [], exempt: [] };
      for (let ry=0;ry<3;ry++) for (let rx=0;rx<3;rx++){
        const R={l:hr.left+rx*hr.width/3,t:hr.top+ry*hr.height/3,w:hr.width/3,h:hr.height/3};
        let inEx=0;
        for(let i=0;i<5;i++)for(let j=0;j<5;j++){
          const sx=R.l+(i+.5)*R.w/5, sy=R.t+(j+.5)*R.h/5;
          if(rects.some(t=>sx>t.l&&sx<t.r&&sy>t.t&&sy<t.b))inEx++;
        }
        const has = els.some(el=>{const r2=el.getBoundingClientRect();const cx=r2.left,cy=r2.top;
          return cx>=R.l&&cx<R.l+R.w&&cy>=R.t&&cy<R.t+R.h;});
        if(inEx/25>0.7){zone.exempt.push(`${rx},${ry}`);}
        else if(!has)zone.empty.push(`${rx},${ry}`);
      }
      out.zones.push(zone);
    });
    // pennant fringe + fold
    const pen = document.querySelector('a[href="/challenges"]');
    out.fringe = pen ? pen.querySelectorAll("div[aria-hidden] > div").length : 0;
    const cta = document.querySelector('section a[href="/apply"], section button');
    if (cta) out.fold = Math.round(cta.getBoundingClientRect().bottom);
    return out;
  });
  const sway1 = await p.evaluate(()=>document.querySelector('a[href="/challenges"] div[aria-hidden] > div:nth-child(3)')?.style.transform ?? "");
  await p.waitForTimeout(600);
  const sway2 = await p.evaluate(()=>document.querySelector('a[href="/challenges"] div[aria-hidden] > div:nth-child(3)')?.style.transform ?? "");
  const zoneStr = r.zones.map(z=>`n=${z.total} empty=[${z.empty}] exempt=${z.exempt.length}`).join(" | ");
  console.log(`${mode}@${width}: ${zoneStr} · touch=${r.touch} · fringe=${r.fringe} · ctaBottom=${r.fold}/${height} ${r.fold<=height?"IN-FOLD":"BELOW"} · sway=${sway1!==sway2?"YES":"NO"}`);

  await p.screenshot({ path:`docs/design-audit/shots/bunting-${mode}-${width}.png`, clip:{x:0,y:0,width,height:width===390?844:900} });
  if (mode==="phosphor" && width===1440) {
    await p.waitForTimeout(255);
    await p.screenshot({ path:"docs/design-audit/shots/bunting-midsway.png", clip:{x:0,y:100,width:1440,height:120} });
  }
  await ctx.close();
}
await b.close();
