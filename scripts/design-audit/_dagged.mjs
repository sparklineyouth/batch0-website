import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
const CASES = [];
for (const width of [1440, 1456, 390])
  for (const dpr of [1, 2])
    for (const mode of ["phosphor", "paper"]) CASES.push({ width, dpr, mode });

for (const { width, dpr, mode } of CASES) {
  const height = width === 390 ? 844 : 900;
  const ctx = await b.newContext({ viewport:{width,height}, deviceScaleFactor:dpr, colorScheme: mode==="paper"?"light":"dark", isMobile: width===390 });
  const p = await ctx.newPage();
  await p.addInitScript((m)=>{ try{sessionStorage.setItem("b0-hero-assembled","1");localStorage.setItem("b0-theme",m)}catch{} }, mode);
  await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
  await p.waitForTimeout(900);

  const r = await p.evaluate(()=>{
    const out = { zones: [], touch: 0, fold: null, dags: 0 };
    document.querySelectorAll('section [aria-hidden="true"].pointer-events-none').forEach(host=>{
      const hr = host.getBoundingClientRect();
      if (!hr.width || !hr.height) return;
      const texts=[...host.parentElement.querySelectorAll("h1 > span,h2,h3,p,a,button,dl")].filter(e=>!host.contains(e)&&e.getBoundingClientRect().width);
      const rects = texts.map(e=>{const t=e.getBoundingClientRect();const pad=e.matches("a,button")?40:24;
        return {l:t.left-pad,t:t.top-pad,r:t.right+pad,b:t.bottom+pad,raw:t};});
      const els=[...host.children].filter(e=>{const w=e.getBoundingClientRect().width;return w&&w<=200;});
      els.forEach(el=>{const r2=el.getBoundingClientRect();
        if(rects.some(t=>!(r2.right<t.raw.left||r2.left>t.raw.right||r2.bottom<t.raw.top||r2.top>t.raw.bottom)))out.touch++;});
      // 4x4 coverage: VISIBLE elements only (>=2 blocks)
      const vis = els.filter(e=>e.childElementCount>=2);
      const zone = { total: els.length, visible: vis.length, empty: [], exempt: 0 };
      for (let ry=0;ry<4;ry++) for (let rx=0;rx<4;rx++){
        const R={l:hr.left+rx*hr.width/4,t:hr.top+ry*hr.height/4,w:hr.width/4,h:hr.height/4};
        let inEx=0;
        for(let i=0;i<5;i++)for(let j=0;j<5;j++){
          const sx=R.l+(i+.5)*R.w/5, sy=R.t+(j+.5)*R.h/5;
          if(rects.some(t=>sx>t.l&&sx<t.r&&sy>t.t&&sy<t.b))inEx++;
        }
        const has = vis.some(el=>{const r2=el.getBoundingClientRect();
          return r2.left>=R.l&&r2.left<R.l+R.w&&r2.top>=R.t&&r2.top<R.t+R.h;});
        if(inEx/25>0.7)zone.exempt++;
        else if(!has)zone.empty.push(`${rx},${ry}`);
      }
      out.zones.push(zone);
    });
    const pen = document.querySelector('a[href="/challenges"]');
    out.dags = pen ? pen.querySelectorAll("div[aria-hidden] > div").length : 0;
    const cta = document.querySelector('section a[href="/apply"], section button');
    if (cta) out.fold = Math.round(cta.getBoundingClientRect().bottom);
    return out;
  });
  // ripple: watch a dag column's transform for up to 8s
  const moved = await p.evaluate(async ()=>{
    const cols=[...document.querySelectorAll('a[href="/challenges"] div[aria-hidden] > div')];
    const seen=new Set();
    for(let t=0;t<16;t++){
      cols.forEach((c,i)=>{if(c.style.transform)seen.add(i)});
      await new Promise(r=>setTimeout(r,500));
    }
    return seen.size;
  });
  const zoneStr = r.zones.map(z=>`vis=${z.visible}/${z.total} empty=[${z.empty}] ex=${z.exempt}`).join(" | ");
  const ok = r.zones.every(z=>z.empty.length===0) && r.touch===0 && r.fold<=height && r.dags===40 && moved>5;
  console.log(`${ok?"PASS":"FAIL"} ${mode}@${width} dpr${dpr}: ${zoneStr} · touch=${r.touch} · cta=${r.fold}/${height} · dags=${r.dags} · rippled=${moved}`);

  if (dpr===2 && width===1440) {
    await p.screenshot({ path:`docs/design-audit/shots/dag-${mode}-hero.png`, clip:{x:0,y:0,width:1440,height:900} });
    if (mode==="phosphor") {
      await p.screenshot({ path:"docs/design-audit/shots/dag-closeup.png", clip:{x:0,y:110,width:760,height:110} });
      await p.waitForTimeout(700);
      await p.screenshot({ path:"docs/design-audit/shots/dag-midripple.png", clip:{x:0,y:110,width:1440,height:110} });
    }
  }
  if (dpr===2 && width===390) await p.screenshot({ path:`docs/design-audit/shots/dag-${mode}-390.png`, clip:{x:0,y:0,width:390,height:844} });
  await ctx.close();
}
await b.close();
