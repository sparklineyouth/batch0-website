import { chromium } from "playwright";
import { mkdirSync } from "fs"; import { join } from "path";
const out=process.argv[2], base="http://localhost:3100";
mkdirSync(out,{recursive:true});
const b=await chromium.launch(); const errs=[];
const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};
  return .2126*f(r)+.7152*f(g)+.0722*f(b)};
const ratio=(a,c)=>{const L1=lum(a),L2=lum(c);return (Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05)};

async function shot(name,w,h,scheme){
  const ctx=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:2,colorScheme:scheme,
    userAgent:w<500?"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1":undefined});
  const p=await ctx.newPage();
  p.on("console",m=>{if(m.type()==="error")errs.push(`[${name}] ${m.text()}`)});
  p.on("pageerror",e=>errs.push(`[${name}] ${e.message}`));
  await p.goto(base,{waitUntil:"networkidle"});
  await p.waitForTimeout(1900);
  await p.screenshot({path:join(out,`${name}.png`)});
  const g=await p.evaluate(()=>{
    const r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}};
    const cap=document.querySelector('.hero-caption'), nm=document.querySelector('h1');
    const sh=[...document.querySelectorAll('section h1, section .hero-caption')]
      .map(e=>getComputedStyle(e).textShadow).filter(v=>v&&v!=='none');
    return {cap:r(cap), nm:r(nm),
            capColor:getComputedStyle(cap).color, nmColor:getComputedStyle(nm.firstElementChild).color,
            shadows:sh};
  });
  await p.evaluate(()=>{document.querySelectorAll('section h1, .hero-caption').forEach(e=>e.style.visibility='hidden')});
  await p.waitForTimeout(250);
  const plate=(await p.screenshot({type:'png'})).toString('base64');
  const s=await p.evaluate(async ({plate,g,dpr})=>{
    const img=new Image(); img.src='data:image/png;base64,'+plate; await img.decode();
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const x=c.getContext('2d'); x.drawImage(img,0,0);
    const samp=(bx)=>{const d=x.getImageData(Math.max(0,bx.x*dpr),Math.max(0,bx.y*dpr),
        Math.max(1,bx.w*dpr),Math.max(1,bx.h*dpr)).data;
      let r=0,gg=0,bb=0,n=0,mn=[255,255,255],mnL=999,mx=[0,0,0],mxL=-1;
      for(let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];bb+=d[i+2];n++;
        const L=(d[i]+d[i+1]+d[i+2])/3;
        if(L<mnL){mnL=L;mn=[d[i],d[i+1],d[i+2]]}
        if(L>mxL){mxL=L;mx=[d[i],d[i+1],d[i+2]]}}
      return {mean:[Math.round(r/n),Math.round(gg/n),Math.round(bb/n)],min:mn,max:mx}};
    return {cap:samp(g.cap), nm:samp(g.nm)};
  },{plate,g,dpr:2});
  const P=v=>v.match(/\d+/g).slice(0,3).map(Number);
  const cc=P(g.capColor), nc=P(g.nmColor);
  const capWorst=Math.min(ratio(cc,s.cap.min),ratio(cc,s.cap.max));
  const nmWorst=Math.min(ratio(nc,s.nm.min),ratio(nc,s.nm.max));
  console.log(`${name.padEnd(11)} tagline ${g.capColor.padEnd(18)} mean ${ratio(cc,s.cap.mean).toFixed(2).padStart(5)}:1  WORST ${capWorst.toFixed(2).padStart(5)}:1  ${capWorst>=4.5?'PASS AA':'FAIL'}`);
  console.log(`${''.padEnd(11)} batch0  ${g.nmColor.padEnd(18)} mean ${ratio(nc,s.nm.mean).toFixed(2).padStart(5)}:1  WORST ${nmWorst.toFixed(2).padStart(5)}:1  ${nmWorst>=4.5?'PASS AA':'FAIL'}   shadows:${g.shadows.length?JSON.stringify(g.shadows):'NONE'}`);
  await ctx.close();
}
await shot("1440-dark",1440,900,"dark");
await shot("1440-light",1440,900,"light");
await shot("390-dark",390,844,"dark");
await shot("390-light",390,844,"light");
await b.close();
console.log("console errors:",errs.length); errs.slice(0,8).forEach(e=>console.log(" ",e));
