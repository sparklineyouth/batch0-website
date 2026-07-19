import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
for (const [width,height] of [[1440,900],[1920,1080],[2560,1440]]) {
  for (const mode of ["phosphor","paper"]) {
    const ctx = await b.newContext({ viewport:{width,height}, deviceScaleFactor: width>1920?1:2, colorScheme: mode==="paper"?"light":"dark" });
    const p = await ctx.newPage();
    await p.addInitScript((m)=>{ try{sessionStorage.setItem("b0-hero-assembled","1");localStorage.setItem("b0-theme",m)}catch{} }, mode);
    await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
    await p.waitForTimeout(900);
    const r = await p.evaluate(()=>{
      const out = { zones: [], touch: 0 };
      document.querySelectorAll('section [aria-hidden="true"].pointer-events-none').forEach(host=>{
        const hr = host.getBoundingClientRect();
        if (!hr.width || !hr.height) return;
        const texts=[...host.parentElement.querySelectorAll("h1 > span,h2,h3,p,a,button,dl")].filter(e=>!host.contains(e)&&e.getBoundingClientRect().width);
        const rects = texts.map(e=>{const t=e.getBoundingClientRect();const pad=e.matches("a,button")?40:24;
          return {l:t.left-pad,t:t.top-pad,r:t.right+pad,b:t.bottom+pad,raw:t};});
        const els=[...host.children].filter(e=>{const w=e.getBoundingClientRect().width;return w&&w<=200;});
        els.forEach(el=>{const r2=el.getBoundingClientRect();
          if(rects.some(t=>!(r2.right<t.raw.left||r2.left>t.raw.right||r2.bottom<t.raw.top||r2.top>t.raw.bottom)))out.touch++;});
        const vis = els.filter(e=>e.childElementCount>=2);
        // 5x5 coverage (visible tier) + perimeter band occupancy
        const empty=[]; let exempt=0;
        for (let ry=0;ry<5;ry++) for (let rx=0;rx<5;rx++){
          const R={l:hr.left+rx*hr.width/5,t:hr.top+ry*hr.height/5,w:hr.width/5,h:hr.height/5};
          let inEx=0;
          for(let i=0;i<5;i++)for(let j=0;j<5;j++){
            const sx=R.l+(i+.5)*R.w/5, sy=R.t+(j+.5)*R.h/5;
            if(rects.some(t=>sx>t.l&&sx<t.r&&sy>t.t&&sy<t.b))inEx++;
          }
          if(inEx/25>0.7){exempt++;continue;}
          if(!vis.some(el=>{const r2=el.getBoundingClientRect();
            return r2.left>=R.l&&r2.left<R.l+R.w&&r2.top>=R.t&&r2.top<R.t+R.h;}))empty.push(`${rx},${ry}`);
        }
        // perimeter: fraction of 16 outer-band segments carrying an element
        let per=0, perTot=0;
        const segs=[];
        for(let i=0;i<5;i++){segs.push([i*20,0,i*20+20,10]);segs.push([i*20,90,i*20+20,100]);}
        for(let i=0;i<3;i++){const h=80/3;segs.push([0,10+i*h,10,10+(i+1)*h]);segs.push([90,10+i*h,100,10+(i+1)*h]);}
        segs.forEach(([x0,y0,x1,y1])=>{
          // skip segments mostly text
          let inEx=0;
          for(let i=0;i<3;i++)for(let j=0;j<3;j++){
            const sx=hr.left+(x0+(i+.5)*(x1-x0)/3)/100*hr.width, sy=hr.top+(y0+(j+.5)*(y1-y0)/3)/100*hr.height;
            if(rects.some(t=>sx>t.l&&sx<t.r&&sy>t.t&&sy<t.b))inEx++;
          }
          if(inEx/9>0.7)return;
          perTot++;
          if(els.some(el=>{const r2=el.getBoundingClientRect();
            const px=(r2.left-hr.left)/hr.width*100, py=(r2.top-hr.top)/hr.height*100;
            return px>=x0&&px<x1&&py>=y0&&py<y1;}))per++;
        });
        out.zones.push({ n: els.length, vis: vis.length, empty, exempt, per: `${per}/${perTot}`, zone: `${Math.round(hr.width)}x${Math.round(hr.height)}` });
      });
      return out;
    });
    const zs = r.zones.map(z=>`[${z.zone}] n=${z.n} vis=${z.vis} empty=[${z.empty}] ex=${z.exempt} perim=${z.per}`).join(" | ");
    const ok = r.zones.every(z=>z.empty.length===0 && z.per.split("/")[0]===z.per.split("/")[1]) && r.touch===0;
    console.log(`${ok?"PASS":"FAIL"} ${mode}@${width}x${height}: ${zs} · touch=${r.touch}`);
    if (mode==="phosphor" || width===1440 || width===2560)
      await p.screenshot({ path:`docs/design-audit/shots/density-${mode}-${width}.png`, clip:{x:0,y:0,width,height} });
    await ctx.close();
  }
}
await b.close();
