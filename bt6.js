// ═══════════════════════════════════════════════════════════════════
// BT6 — Walk-Forward für Bot 3 (Momentum 1D) und Bot 4 (Sweep 4h)
// Regel steht in BOT34-KRITERIEN.md und wurde VOR diesem Lauf festgelegt:
// Parameter im ersten Datenteil wählen, im zweiten unverändert testen.
// Bestehen = OOS-Rendite > 0, >=6/10 Paare positiv, MaxDD < 30 % — in BEIDEN Schnitten.
// ═══════════════════════════════════════════════════════════════════
const $st=document.getElementById('st'),$out=document.getElementById('out');
const say=s=>{$st.textContent=s;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PAIRS=['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'];
const INIT=2000, FEE=0.0005, SLIP=0.02;

async function fetchTF(sym,bar,ms,need){
 const inst=sym+'-USDT-SWAP';
 let all=[];
 const r0=await (await fetch('https://www.okx.com/api/v5/market/candles?instId='+inst+'&bar='+bar+'&limit=300')).json();
 if(r0.code!=='0'||!r0.data) throw new Error(sym+' '+bar);
 all=r0.data.map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4]}));
 let g=0;
 while(all.length<need&&g++<60){
  const oldest=all[all.length-1].ts;
  await sleep(100);
  const r=await (await fetch('https://www.okx.com/api/v5/market/history-candles?instId='+inst+'&bar='+bar+'&after='+oldest+'&limit=100')).json();
  if(r.code!=='0'||!r.data||!r.data.length)break;
  all=all.concat(r.data.map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4]})));
 }
 all.sort((a,b)=>a.ts-b.ts);
 const now=Date.now();
 return all.filter(b=>b.ts+ms<=now);
}
function atrArr(c,n=14){
 const tr=c.slice(1).map((x,i)=>Math.max(x.h-x.l,Math.abs(x.h-c[i].c),Math.abs(x.l-c[i].c)));
 if(tr.length<n)return null;
 let a=tr.slice(0,n).reduce((x,y)=>x+y)/n;const o=new Array(n).fill(a);o.push(a);
 for(let i=n;i<tr.length;i++){a=(a*(n-1)+tr[i])/n;o.push(a);}
 return o;
}
const stat=(eqF,trades,maxdd,bySym)=>{
 const w=trades.filter(x=>x.pnl>0);
 const gw=w.reduce((a,x)=>a+x.pnl,0), gl=Math.abs(trades.filter(x=>x.pnl<=0).reduce((a,x)=>a+x.pnl,0));
 return {pnl:+((eqF-INIT)/INIT*100).toFixed(1), n:trades.length,
  wr:trades.length?+(w.length/trades.length*100).toFixed(0):0,
  pf:gl>0?+(gw/gl).toFixed(2):(gw>0?99:0), dd:+maxdd.toFixed(1),
  symPos:Object.values(bySym).filter(v=>v>0).length, symAll:Object.keys(bySym).length};
};
const slice=(d,from,to)=>{const o={};for(const s of PAIRS){o[s]=d[s]?d[s].filter(b=>b.ts>=from&&b.ts<to):null;}return o;};

function runMom(d,P){
 const LEV=2, EXPO=0.6;
 const axis=[...new Set(PAIRS.flatMap(s=>d[s]?d[s].map(b=>b.ts):[]))].sort((a,b)=>a-b);
 const idx={},arr={};
 PAIRS.forEach(s=>{ if(!d[s]||!d[s].length)return; arr[s]=d[s]; idx[s]=new Map(d[s].map((b,i)=>[b.ts,i])); });
 let eq=INIT, peak=INIT, maxdd=0, open=[], trades=[], bySym={}, step=0;
 const priceAt=(s,ts)=>{const i=idx[s]?idx[s].get(ts):null; return i==null?null:arr[s][i].c;};
 for(const ts of axis){
  let float=0;
  for(const p of open){ const px=priceAt(p.sym,ts); if(px==null)continue;
   float+=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional; }
  const cur=eq+float; if(cur>peak)peak=cur; maxdd=Math.max(maxdd,(peak-cur)/peak*100);
  if(step++ % P.reb !== 0) continue;
  for(const p of open){ const px=priceAt(p.sym,ts); if(px==null)continue;
   const gross=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional;
   const pnl=gross - p.notional*FEE*2 - p.notional*SLIP/100*2;
   eq+=pnl; trades.push({pnl}); bySym[p.sym]=(bySym[p.sym]||0)+pnl; }
  open=[];
  const rets=[];
  for(const s of PAIRS){ const i=idx[s]?idx[s].get(ts):null; if(i==null||i<P.lb)continue;
   rets.push({s,r:arr[s][i].c/arr[s][i-P.lb].c-1}); }
  if(rets.length<2*P.topK) continue;
  rets.sort((a,b)=>b.r-a.r);
  const notionalEach=eq*LEV*EXPO/(2*P.topK);
  for(const x of rets.slice(0,P.topK)) open.push({sym:x.s,dir:1,entry:priceAt(x.s,ts),notional:notionalEach});
  for(const x of rets.slice(-P.topK)) open.push({sym:x.s,dir:-1,entry:priceAt(x.s,ts),notional:notionalEach});
 }
 const last=axis[axis.length-1]; let float=0;
 for(const p of open){ const px=priceAt(p.sym,last); if(px==null)continue;
  const g=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional; float+=g; bySym[p.sym]=(bySym[p.sym]||0)+g; }
 return stat(eq+float,trades,maxdd,bySym);
}

function runSweep(d,P){
 const RISK=1.0, LEV=3, MAXPOS=5, TIMEOUT=20;
 const pre={};
 PAIRS.forEach(s=>{ if(!d[s]||d[s].length<60)return; pre[s]={k:d[s],a:atrArr(d[s],14),idx:new Map(d[s].map((b,i)=>[b.ts,i]))}; });
 const axis=[...new Set(Object.keys(pre).flatMap(s=>pre[s].k.map(b=>b.ts)))].sort((a,b)=>a-b);
 let bal=INIT, peak=INIT, maxdd=0, open=[], trades=[], bySym={};
 for(const ts of axis){
  for(const pos of [...open]){
   const p=pre[pos.sym], i=p.idx.get(ts); if(i==null)continue;
   const bar=p.k[i]; if(bar.ts<=pos.ts)continue;
   let exit=null;
   if(pos.dir>0){ if(bar.l<=pos.sl)exit=pos.sl*(1-SLIP/100); else if(bar.h>=pos.tp)exit=pos.tp; }
   else         { if(bar.h>=pos.sl)exit=pos.sl*(1+SLIP/100); else if(bar.l<=pos.tp)exit=pos.tp; }
   if(exit==null && (i-pos.i)>=TIMEOUT) exit=bar.c;
   if(exit!=null){
    const diff=pos.dir>0?exit-pos.price:pos.price-exit;
    const pnl=diff*pos.size - exit*pos.size*FEE - pos.eFee;
    bal+=pos.margin+pnl+pos.eFee;
    trades.push({pnl}); bySym[pos.sym]=(bySym[pos.sym]||0)+pnl;
    open=open.filter(x=>x!==pos);
   }
  }
  for(const s of Object.keys(pre)){
   if(open.length>=MAXPOS)break;
   const p=pre[s], i=p.idx.get(ts); if(i==null||i<P.n+20)continue;
   if(open.find(x=>x.sym===s))continue;
   const bar=p.k[i], a=p.a?p.a[i]:0; if(!a||a<=0)continue;
   const prev=p.k.slice(i-P.n,i);
   const hi=Math.max(...prev.map(x=>x.h)), lo=Math.min(...prev.map(x=>x.l));
   let dir=0, extreme=0;
   if(bar.h>hi && bar.c<hi && (!P.confirm || bar.c<bar.o)){ dir=-1; extreme=bar.h; }
   else if(bar.l<lo && bar.c>lo && (!P.confirm || bar.c>bar.o)){ dir=1; extreme=bar.l; }
   if(!dir)continue;
   const price=dir>0?bar.c*(1+SLIP/100):bar.c*(1-SLIP/100);
   const sl=dir>0?extreme*0.999:extreme*1.001;
   const slDist=Math.abs(price-sl); if(slDist<=0)continue;
   const tp=dir>0?price+P.r*slDist:price-P.r*slDist;
   let size=(bal*RISK/100)/slDist, margin=size*price/LEV;
   const cap=bal*12/100; if(margin>cap){size*=cap/margin;margin=cap;}
   const eFee=size*price*FEE;
   if(margin+eFee>bal||margin<1)continue;
   bal-=margin+eFee;
   open.push({sym:s,dir,price,sl,tp,size,margin,eFee,ts,i});
  }
  let locked=0,float=0;
  for(const pos of open){ locked+=pos.margin;
   const p=pre[pos.sym], i=p.idx.get(ts); if(i==null)continue;
   const px=p.k[i].c; float+=(pos.dir>0?px-pos.price:pos.price-px)*pos.size; }
  const cur=bal+locked+float; if(cur>peak)peak=cur; maxdd=Math.max(maxdd,(peak-cur)/peak*100);
 }
 let lockedE=0,floatE=0;
 for(const pos of open){ lockedE+=pos.margin;
  const k=pre[pos.sym].k, px=k[k.length-1].c;
  const g=(pos.dir>0?px-pos.price:pos.price-px)*pos.size; floatE+=g; bySym[pos.sym]=(bySym[pos.sym]||0)+g; }
 return stat(bal+lockedE+floatE,trades,maxdd,bySym);
}

const MOM_GRID=[]; for(const lb of [20,30,60,90]) for(const topK of [2,3]) for(const reb of [5,7,14]) MOM_GRID.push({lb,topK,reb});
const SWP_GRID=[]; for(const n of [10,20,30]) for(const r of [1.5,2,3]) for(const confirm of [0,1]) SWP_GRID.push({n,r,confirm});
const tagM=p=>'LB'+p.lb+'/K'+p.topK+'/R'+p.reb;
const tagS=p=>'N'+p.n+'/R'+p.r+(p.confirm?'/conf':'');

function walkForward(data,grid,runner,tagFn,frac){
 const all=[...new Set(PAIRS.flatMap(s=>data[s]?data[s].map(b=>b.ts):[]))].sort((a,b)=>a-b);
 const cut=all[Math.floor(all.length*frac)];
 const IS=slice(data,all[0],cut), OOS=slice(data,cut,all[all.length-1]+1);
 let best=null;
 for(const P of grid){ const r=runner(IS,P); if(!best||r.pnl>best.r.pnl) best={P,r}; }
 const oos=runner(OOS,best.P);
 return {schnitt:Math.round(frac*100)+'/'+Math.round((1-frac)*100),
  cut:new Date(cut).toISOString().slice(0,10),
  gewaehlt:tagFn(best.P), IS:{pnl:best.r.pnl+'%',dd:best.r.dd+'%'},
  OOS:{pnl:oos.pnl+'%',pf:oos.pf,dd:oos.dd+'%',n:oos.n,wr:oos.wr+'%',paare:oos.symPos+'/'+oos.symAll},
  bestanden: oos.pnl>0 && oos.symPos>=6 && oos.dd<30};
}
function fixedOOS(data,runner,P,frac){
 const all=[...new Set(PAIRS.flatMap(s=>data[s]?data[s].map(b=>b.ts):[]))].sort((a,b)=>a-b);
 const cut=all[Math.floor(all.length*frac)];
 const r=runner(slice(data,cut,all[all.length-1]+1),P);
 return {pnl:r.pnl+'%',pf:r.pf,dd:r.dd+'%',n:r.n,paare:r.symPos+'/'+r.symAll};
}

(async()=>{
 try{
  const D={},H4={};
  for(const s of PAIRS){ say('Lade '+s+' 1D…'); try{D[s]=await fetchTF(s,'1Dutc',86400000,800);}catch(e){D[s]=null;} await sleep(110); }
  for(const s of PAIRS){ say('Lade '+s+' 4H…'); try{H4[s]=await fetchTF(s,'4H',14400000,3000);}catch(e){H4[s]=null;} await sleep(110); }
  const meta={};
  for(const [name,set] of [['1D',D],['4H',H4]]){
   const ok=PAIRS.filter(s=>set[s]&&set[s].length>50), b=set[ok[0]];
   meta[name]={paare:ok.length,bars:b?b.length:0,
    von:b?new Date(b[0].ts).toISOString().slice(0,10):'-',
    bis:b?new Date(b[b.length-1].ts).toISOString().slice(0,10):'-'};
  }
  say('Walk-Forward Bot 3 (Momentum)…'); await sleep(20);
  const m50=walkForward(D,MOM_GRID,runMom,tagM,0.5);
  const m70=walkForward(D,MOM_GRID,runMom,tagM,0.7);
  say('Walk-Forward Bot 4 (Sweep)…'); await sleep(20);
  const s50=walkForward(H4,SWP_GRID,runSweep,tagS,0.5);
  const s70=walkForward(H4,SWP_GRID,runSweep,tagS,0.7);

  $out.textContent=JSON.stringify({
   regel:'OOS-Rendite>0 UND >=6/10 Paare UND DD<30% — in BEIDEN Schnitten',
   daten:meta,
   bot3_momentum:{schnitte:[m50,m70], BESTANDEN:(m50.bestanden&&m70.bestanden),
     vorab_LB20_K2_R14_oos:{s50:fixedOOS(D,runMom,{lb:20,topK:2,reb:14},0.5),s70:fixedOOS(D,runMom,{lb:20,topK:2,reb:14},0.7)}},
   bot4_sweep:{schnitte:[s50,s70], BESTANDEN:(s50.bestanden&&s70.bestanden),
     vorab_N30_R3_conf_oos:{s50:fixedOOS(H4,runSweep,{n:30,r:3,confirm:1},0.5),s70:fixedOOS(H4,runSweep,{n:30,r:3,confirm:1},0.7)}}
  },null,1);
  say('FERTIG ✅');
 }catch(e){ say('FEHLER: '+e); $out.textContent=String(e&&e.stack||e); }
})();
