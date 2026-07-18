import { chromium } from "playwright";
const b = await chromium.launch();
for (const mode of ["phosphor","paper"]) {
  const ctx = await b.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2, colorScheme: mode==="paper"?"light":"dark" });
  const p = await ctx.newPage();
  await p.addInitScript((m)=>{ try{sessionStorage.setItem("b0-hero-assembled","1");localStorage.setItem("b0-theme",m)}catch{} }, mode);
  await p.goto("http://localhost:3100/",{waitUntil:"networkidle"});
  await p.waitForTimeout(900);

  // fallback pennant: renders + correct copy + link
  const pen = await p.evaluate(()=>{
    const a=document.querySelector('a[href="/challenges"]');
    return a ? { text: a.textContent.trim(), label: a.getAttribute("aria-label") } : null;
  });
  // wave: sample a field column's transform twice, 500ms apart
  const t1 = await p.evaluate(()=>document.querySelector('a[href="/challenges"] div[aria-hidden] > div')?.style.transform ?? "");
  await p.waitForTimeout(500);
  const t2 = await p.evaluate(()=>document.querySelector('a[href="/challenges"] div[aria-hidden] > div')?.style.transform ?? "");
  console.log(`${mode}: pennant=${JSON.stringify(pen)} wave=${t1!==t2?`YES (${t1||"''"} -> ${t2})`:"NO"}`);

  // exclusion (stars: center vs 58px pad; clouds: box vs raw text)
  const hits = await p.evaluate(()=>{
    const paper = document.documentElement.classList.contains("paper");
    let n=0;
    document.querySelectorAll('section [aria-hidden="true"].pointer-events-none').forEach(host=>{
      const texts=[...host.parentElement.querySelectorAll("h1 > span,h2,h3,p,a,button,dl")].filter(e=>!host.contains(e)&&e.getBoundingClientRect().width);
      [...host.children].forEach(el=>{const r=el.getBoundingClientRect();
        if(paper){ if(texts.some(e=>{const t=e.getBoundingClientRect();return !(r.right<t.left||r.left>t.right||r.bottom<t.top||r.top>t.bottom)}))n++; }
        else { if(r.width>60)return; const cx=r.left+r.width/2,cy=r.top+r.height/2;
          if(texts.some(e=>{const t=e.getBoundingClientRect();return cx>t.left-58&&cx<t.right+58&&cy>t.top-58&&cy<t.bottom+58}))n++; }
      });
    });
    return n;
  });
  console.log(`${mode}: exclusion hits=${hits}`);
  await p.screenshot({ path:`docs/design-audit/shots/natural-${mode}-hero.png`, clip:{x:0,y:0,width:1440,height:900} });
  if (mode==="phosphor") {
    await p.evaluate(()=>document.getElementById("apply-cta").scrollIntoView());
    await p.waitForTimeout(400);
    await p.screenshot({ path:"docs/design-audit/shots/natural-phosphor-close.png", clip:{x:0,y:200,width:1440,height:700} });
  }
  await ctx.close();
}
await b.close();
