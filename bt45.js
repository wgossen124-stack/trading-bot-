// ═══════════════════════════════════════════════════════════════════
// BT45 — zwei Bot-Kandidaten gegen die Hürde aus BOT34-KRITERIEN.md
//   Kandidat A (Bot 3): Cross-Sectional Momentum auf 1D
//   Kandidat B (Bot 4): Sweep-Reversal auf 4h
// Ergebnis im DOM (#out). Seite im Vordergrund lassen.
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
 while(all.length<need&&g++<40){
  const oldest=all[all.length-1].ts;
  await sleep(110);
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
const stat=(eqF,trades,maxdd,bySym,entryTs)=>{
 const w=trades.filter(x=>x.pnl>0);
 const gw=w.reduce((a,x)=>a+x.pnl,0), gl=Math.abs(trades.filter(x=>x.pnl<=0).reduce((a,x)=>a+x.pnl,0));
 return {pnlPct:+((eqF-INIT)/INIT*100).toFixed(1), n:trades.length,
  wr:trades.length?+(w.length/trades.length*100).toFixed(0):0,
  pf:gl>0?+(gw/gl).toFixed(2):(gw>0?99:0), maxdd:+maxdd.toFixed(1),
  symPos:Object.values(bySym).filter(v=>v>0).length, symAll:Object.keys(bySym).length,
  bySym, entryTs};
};

// ── Kandidat A: Cross-Sectional Momentum (1D) ──────────────────────
// Rangliste aller Paare nach Rendite über LB Tage; Long Top-K, Short Bottom-K,
// Neugewichtung alle REB Tage. Exit ausschließlich durch Rebalancing.
function runMom(d,P){
 const LEV=2, EXPO=0.6;
 const axis=[...new Set(PAIRS.flatMap(s=>d[s]?d[s].map(b=>b.ts):[]))].sort((a,b)=>a-b);
 const idx={},arr={};
 PAIRS.forEach(s=>{ if(!d[s])return; arr[s]=d[s]; idx[s]=new Map(d[s].map((b,i)=>[b.ts,i])); });
 let eq=INIT, peak=INIT, maxdd=0, open=[], trades=[], bySym={}, entryTs=[], step=0;
 const priceAt=(s,ts)=>{const i=idx[s]?idx[s].get(ts):null; return i==null?null:arr[s][i].c;};
 for(const ts of axis){
  // Mark-to-Market
  let float=0;
  for(const p of open){ const px=priceAt(p.sym,ts); if(px==null)continue;
   float+=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional; }
  const cur=eq+float;
  if(cur>peak)peak=cur;
  maxdd=Math.max(maxdd,(peak-cur)/peak*100);
  // Rebalancing?
  if(step++ % P.reb !== 0) continue;
  // alte Positionen schließen
  for(const p of open){ const px=priceAt(p.sym,ts); if(px==null)continue;
   const gross=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional;
   const pnl=gross - p.notional*FEE*2 - p.notional*SLIP/100*2;
   eq+=pnl; trades.push({pnl}); bySym[p.sym]=(bySym[p.sym]||0)+pnl; }
  open=[];
  // neue Rangliste
  const rets=[];
  for(const s of PAIRS){
   const i=idx[s]?idx[s].get(ts):null;
   if(i==null||i<P.lb)continue;
   rets.push({s, r:arr[s][i].c/arr[s][i-P.lb].c-1});
  }
  if(rets.length<2*P.topK) continue;
  rets.sort((a,b)=>b.r-a.r);
  const longs=rets.slice(0,P.topK), shorts=rets.slice(-P.topK);
  const notionalEach=eq*LEV*EXPO/(2*P.topK);
  for(const x of longs){ open.push({sym:x.s,dir:1,entry:priceAt(x.s,ts),notional:notionalEach}); entryTs.push(ts); }
  for(const x of shorts){ open.push({sym:x.s,dir:-1,entry:priceAt(x.s,ts),notional:notionalEach}); entryTs.push(ts); }
 }
 // Schluss: offene bewerten
 const last=axis[axis.length-1];
 let float=0;
 for(const p of open){ const px=priceAt(p.sym,last); if(px==null)continue;
  const g=(p.dir>0?px/p.entry-1:1-px/p.entry)*p.notional;
  float+=g; bySym[p.sym]=(bySym[p.sym]||0)+g; }
 return stat(eq+float,trades,maxdd,bySym,entryTs);
}

// ── Kandidat B: Sweep-Reversal (4h) ────────────────────────────────
// N-Bar-Extrem wird überschritten, Kerze schließt zurück ins Innere → Gegeneinstieg.
function runSweep(d,P){
 const RISK=1.0, LEV=3, MAXPOS=5, TIMEOUT=20;
 const pre={};
 PAIRS.forEach(s=>{ if(!d[s])return; pre[s]={k:d[s], a:atrArr(d[s],14), idx:new Map(d[s].map((b,i)=>[b.ts,i]))}; });
 const axis=[...new Set(PAIRS.flatMap(s=>pre[s]?pre[s].k.map(b=>b.ts):[]))].sort((a,b)=>a-b);
 let bal=INIT, peak=INIT, maxdd=0;
 let open=[], trades=[], bySym={}, entryTs=[];
 for(const ts of axis){
  // Exits
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
  // Entries
  for(const s of PAIRS){
   if(open.length>=MAXPOS)break;
   const p=pre[s]; if(!p)continue;
   const i=p.idx.get(ts); if(i==null||i<P.n+20)continue;
   if(open.find(x=>x.sym===s))continue;
   const bar=p.k[i], a=p.a?p.a[i]:0; if(!a||a<=0)continue;
   const prev=p.k.slice(i-P.n,i);
   const hi=Math.max(...prev.map(x=>x.h)), lo=Math.min(...prev.map(x=>x.l));
   let dir=0, extreme=0;
   // Short: Docht über das Hoch, Schluss zurück darunter
   if(bar.h>hi && bar.c<hi && (!P.confirm || bar.c<bar.o)){ dir=-1; extreme=bar.h; }
   // Long: Docht unter das Tief, Schluss zurück darüber
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
   entryTs.push(ts);
  }
  // Equity
  let locked=0,float=0;
  for(const pos of open){ locked+=pos.margin;
   const p=pre[pos.sym], i=p.idx.get(ts); if(i==null)continue;
   const px=p.k[i].c; float+=(pos.dir>0?px-pos.price:pos.price-px)*pos.size; }
  const cur=bal+locked+float;
  if(cur>peak)peak=cur;
  maxdd=Math.max(maxdd,(peak-cur)/peak*100);
 }
 let lockedE=0,floatE=0;
 for(const pos of open){ lockedE+=pos.margin;
  const k=pre[pos.sym].k, px=k[k.length-1].c;
  const g=(pos.dir>0?px-pos.price:pos.price-px)*pos.size;
  floatE+=g; bySym[pos.sym]=(bySym[pos.sym]||0)+g; }
 return stat(bal+lockedE+floatE,trades,maxdd,bySym,entryTs);
}

function summarize(runs,best){
 const pos=runs.filter(r=>r.pnlPct>0);
 const sorted=[...runs].sort((a,b)=>b.pnlPct-a.pnlPct);
 return {
  kombis:runs.length,
  positivAnteil:+(pos.length/runs.length*100).toFixed(0)+'%',
  median_pnl:+sorted[Math.floor(sorted.length/2)].pnlPct.toFixed(1),
  beste:sorted.slice(0,3).map(r=>r.tag+': '+r.pnlPct+'% PF'+r.pf+' DD'+r.maxdd+'% n'+r.n+' Paare+'+r.symPos+'/'+r.symAll),
  schlechteste:sorted.slice(-2).map(r=>r.tag+': '+r.pnlPct+'% PF'+r.pf),
  alle:runs.map(r=>r.tag+':'+r.pnlPct+'%/'+r.symPos+'P'),
  default:best
 };
}

(async()=>{
 try{
  const D={},H4={};
  for(const s of PAIRS){ say('Lade '+s+' 1D…'); try{D[s]=await fetchTF(s,'1Dutc',86400000,800);}catch(e){D[s]=null;} await sleep(120); }
  // OKX kennt KEINE UTC-Variante für 4H (nur ab 6H) → schlicht '4H'
  for(const s of PAIRS){ say('Lade '+s+' 4H…'); try{H4[s]=await fetchTF(s,'4H',14400000,1500);}catch(e){H4[s]=null;} await sleep(120); }

  // Kandidat A
  say('Backtest Bot 3 (Momentum)…'); await sleep(20);
  const runsA=[];
  for(const lb of [20,30,60,90]) for(const topK of [2,3]) for(const reb of [5,7,14]){
   const r=runMom(D,{lb,topK,reb});
   runsA.push({tag:'LB'+lb+'/K'+topK+'/R'+reb, ...r, bySym:undefined, entryTs:undefined});
  }
  const bestA=runMom(D,{lb:60,topK:3,reb:7});

  // Kandidat B
  say('Backtest Bot 4 (Sweep)…'); await sleep(20);
  const runsB=[];
  for(const n of [10,20,30]) for(const r of [1.5,2,3]) for(const confirm of [0,1]){
   const x=runSweep(H4,{n,r,confirm});
   runsB.push({tag:'N'+n+'/R'+r+(confirm?'/conf':''), ...x, bySym:undefined, entryTs:undefined});
  }
  const bestB=runSweep(H4,{n:20,r:2,confirm:1});

  const fmtBest=b=>({pnl:b.pnlPct+'%',pf:b.pf,dd:b.maxdd+'%',n:b.n,wr:b.wr+'%',
    paare_positiv:b.symPos+'/'+b.symAll,
    proPaar:Object.fromEntries(Object.entries(b.bySym).map(([k,v])=>[k,Math.round(v)]))});

  const meta={};
  for(const [name,set,ms] of [['1D',D,86400000],['4H',H4,14400000]]){
   const ok=PAIRS.filter(s=>set[s]&&set[s].length>50), b=set[ok[0]];
   meta[name]={paare:ok.length,bars:b?b.length:0,
    von:b?new Date(b[0].ts).toISOString().slice(0,10):'-',
    bis:b?new Date(b[b.length-1].ts).toISOString().slice(0,10):'-'};
  }
  $out.textContent=JSON.stringify({
   huerde:'>=6/10 Paare positiv · >=70% Kombis positiv · MaxDD <30%',
   daten:meta,
   bot3_momentum_1D:{...summarize(runsA,fmtBest(bestA))},
   bot4_sweep_4H:{...summarize(runsB,fmtBest(bestB))}
  },null,1);
  say('FERTIG ✅');
 }catch(e){ say('FEHLER: '+e); $out.textContent=String(e&&e.stack||e); }
})();
