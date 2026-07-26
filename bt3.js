// ═══════════════════════════════════════════════════════════════════
// BT3 — Bot-3-Kandidat: Donchian-Trendfolge auf 1D vs 12h
// Gleiche Mechanik wie bot2.js (Entry N-Bar-Breakout + EMA-Trendfilter,
// Exit N2-Bar-Gegenkanal + ATR-Stop + Timeout), nur anderer Zeitrahmen.
// Prüft die vorab festgelegte Hürde aus BOT3-KRITERIEN.md.
// Ergebnis landet im DOM (#out) — Seite im Vordergrund lassen.
// ═══════════════════════════════════════════════════════════════════
const $st=document.getElementById('st'),$out=document.getElementById('out');
const say=s=>{$st.textContent=s;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const PAIRS=['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'];
const TFS={ '1D':{bar:'1Dutc',ms:86400000,ema:100,timeout:60},
            '12H':{bar:'12Hutc',ms:43200000,ema:200,timeout:50} };
// Parametergitter (Entry-Kanal × Exit-Kanal × ATR-Stop)
const GRID=[];
for(const n of [10,15,20,25,30]) for(const n2 of [5,8,10]) for(const sl of [2.0,2.5]) GRID.push({n,n2,sl});

const FEE=0.0005, SLIP=0.02, RISK=1.0, LEV=3, INIT=2000;
const MAXPOS=8, MAXSAME=3, MAXHEAT=40, MAXMARGIN=12, COOLDOWN=2;

// ── Indikatoren (identisch zu bot2.js) ──
function ema(d,n){const k=2/(n+1);let e=d[0];return d.map(v=>(e=v*k+e*(1-k)));}
function atrArr(c,n=14){
 const tr=c.slice(1).map((x,i)=>Math.max(x.h-x.l,Math.abs(x.h-c[i].c),Math.abs(x.l-c[i].c)));
 if(tr.length<n)return null;
 let a=tr.slice(0,n).reduce((x,y)=>x+y)/n;const o=new Array(n).fill(a);o.push(a);
 for(let i=n;i<tr.length;i++){a=(a*(n-1)+tr[i])/n;o.push(a);}
 return o; // o[i] ≈ ATR bei Bar i
}

// ── OKX-Daten (paginiert, nur abgeschlossene Bars) ──
async function fetchTF(sym,bar,ms,need){
 const inst=sym+'-USDT-SWAP';
 let all=[];
 const r0=await (await fetch('https://www.okx.com/api/v5/market/candles?instId='+inst+'&bar='+bar+'&limit=300')).json();
 if(r0.code!=='0'||!r0.data) throw new Error(sym+' '+bar+' fail '+r0.code);
 all=r0.data.map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}));
 let guard=0;
 while(all.length<need&&guard++<40){
  const oldest=all[all.length-1].ts;
  await sleep(110);
  const r=await (await fetch('https://www.okx.com/api/v5/market/history-candles?instId='+inst+'&bar='+bar+'&after='+oldest+'&limit=100')).json();
  if(r.code!=='0'||!r.data||!r.data.length)break;
  all=all.concat(r.data.map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]})));
 }
 all.sort((a,b)=>a.ts-b.ts);
 const now=Date.now();
 return all.filter(b=>b.ts+ms<=now);
}

// ── Engine: exakt die bot2.js-Logik, über alle Paare gleichzeitig ──
function run(data,tf,P,collectTs){
 const {ms,ema:emaLen,timeout}=TFS[tf];
 const pre={};
 for(const s of PAIRS){
  const k=data[s]; if(!k) continue;
  const closes=k.map(x=>x.c);
  pre[s]={k, e:ema(closes,emaLen), a:atrArr(k,14), idx:new Map(k.map((b,i)=>[b.ts,i]))};
 }
 // gemeinsame Zeitachse
 const allTs=[...new Set(PAIRS.flatMap(s=>pre[s]?pre[s].k.map(b=>b.ts):[]))].sort((a,b)=>a-b);
 const warm=Math.max(emaLen+5,P.n+5,20);
 const st={bal:INIT,positions:[],trades:[],cd:{}};
 let peak=INIT,maxdd=0;
 const entryTs=[];

 for(const ts of allTs){
  // ── Exits ──
  for(const pos of [...st.positions]){
   const p=pre[pos.sym]; const i=p.idx.get(ts); if(i==null)continue;
   const bar=p.k[i]; if(bar.ts<=pos.ts)continue;
   // Turtle-Trailing auf N2-Bar-Gegenkanal (Bars vor der aktuellen)
   const prev=p.k.slice(Math.max(0,i-P.n2),i);
   if(prev.length){
    const tstop=pos.side==='LONG'?Math.min(...prev.map(x=>x.l)):Math.max(...prev.map(x=>x.h));
    pos.sl=pos.side==='LONG'?Math.max(pos.sl,tstop):Math.min(pos.sl,tstop);
   }
   let exit=null,reason='';
   if(pos.side==='LONG'){ if(bar.l<=pos.sl){exit=pos.sl*(1-SLIP/100);reason='STOP';} }
   else                 { if(bar.h>=pos.sl){exit=pos.sl*(1+SLIP/100);reason='STOP';} }
   if(exit==null&&(bar.ts-pos.ts)>=timeout*ms){
    exit=pos.side==='LONG'?bar.c*(1-SLIP/100):bar.c*(1+SLIP/100);reason='TIME';
   }
   if(exit!=null){
    const diff=pos.side==='LONG'?exit-pos.price:pos.price-exit;
    const pnl=diff*pos.size-exit*pos.size*FEE-pos.eFee;
    st.bal+=pos.margin+pnl+pos.eFee;
    st.trades.push({sym:pos.sym,side:pos.side,pnl,reason,ts:bar.ts});
    st.cd[pos.sym]=bar.ts;
    st.positions=st.positions.filter(x=>x!==pos);
   }
  }
  // ── Kandidaten ──
  const cands=[];
  for(const s of PAIRS){
   const p=pre[s]; if(!p)continue;
   const i=p.idx.get(ts); if(i==null||i<warm)continue;
   if(st.positions.find(x=>x.sym===s))continue;
   if(st.cd[s]&&(ts-st.cd[s])<COOLDOWN*ms)continue;
   const bar=p.k[i], e=p.e[i], a=p.a?p.a[i]:0;
   if(!a||a<=0)continue;
   const prev=p.k.slice(i-P.n,i);
   if(prev.length<P.n)continue;
   const hh=Math.max(...prev.map(x=>x.h)), ll=Math.min(...prev.map(x=>x.l));
   let sig=null;
   if(bar.c>hh&&bar.c>e)sig='LONG';
   else if(bar.c<ll&&bar.c<e)sig='SHORT';
   if(!sig)continue;
   cands.push({sym:s,sig,price:bar.c,atr:a});
  }
  // ── Entries ──
  for(const c of cands){
   if(st.positions.length>=MAXPOS)break;
   if(st.positions.filter(x=>x.side===c.sig).length>=MAXSAME)continue;
   const locked=st.positions.reduce((a,p)=>a+p.margin,0);
   const eq=st.bal+locked;
   if(eq<=0||locked/eq*100>=MAXHEAT)break;
   const price=c.sig==='LONG'?c.price*(1+SLIP/100):c.price*(1-SLIP/100);
   const slDist=P.sl*c.atr; if(slDist<=0)continue;
   const sl=c.sig==='LONG'?price-slDist:price+slDist;
   let size=(st.bal*RISK/100)/slDist, margin=size*price/LEV;
   const cap=eq*MAXMARGIN/100; if(margin>cap){size*=cap/margin;margin=cap;}
   const eFee=size*price*FEE;
   if(margin+eFee>st.bal||margin<1)continue;
   st.bal-=margin+eFee;
   st.positions.push({sym:c.sym,side:c.sig,price,sl,size,margin,eFee,ts});
   if(collectTs)entryTs.push(ts);
  }
  // Equity/DD auf Close-Basis
  let locked=0,unreal=0;
  for(const pos of st.positions){locked+=pos.margin;
   const p=pre[pos.sym],i=p.idx.get(ts);if(i==null)continue;
   const lp=p.k[i].c;unreal+=(pos.side==='LONG'?lp-pos.price:pos.price-lp)*pos.size;}
  const eq=st.bal+locked+unreal;
  if(eq>peak)peak=eq;
  maxdd=Math.max(maxdd,(peak-eq)/peak*100);
 }
 // offene Positionen zum letzten Kurs bewerten
 let lockedE=0,unrealE=0;
 for(const pos of st.positions){lockedE+=pos.margin;
  const k=pre[pos.sym].k,lp=k[k.length-1].c;
  unrealE+=(pos.side==='LONG'?lp-pos.price:pos.price-lp)*pos.size;}
 const eqF=st.bal+lockedE+unrealE;
 const t=st.trades,w=t.filter(x=>x.pnl>0);
 const gw=w.reduce((a,x)=>a+x.pnl,0),gl=Math.abs(t.filter(x=>x.pnl<=0).reduce((a,x)=>a+x.pnl,0));
 // PnL pro Paar
 const bySym={};t.forEach(x=>{bySym[x.sym]=(bySym[x.sym]||0)+x.pnl;});
 return {pnlPct:+((eqF-INIT)/INIT*100).toFixed(1), n:t.length,
  wr:t.length?+(w.length/t.length*100).toFixed(0):0,
  pf:gl>0?+(gw/gl).toFixed(2):(gw>0?99:0), maxdd:+maxdd.toFixed(1),
  bySym, entryTs};
}

(async()=>{
 try{
  const data={'1D':{},'12H':{}};
  for(const tf of ['1D','12H']){
   const {bar,ms}=TFS[tf];
   const need=tf==='1D'?800:1200;
   for(const s of PAIRS){
    say('Lade '+s+' '+tf+'…');
    try{ data[tf][s]=await fetchTF(s,bar,ms,need); }catch(e){ data[tf][s]=null; }
    await sleep(120);
   }
  }
  const meta={};
  for(const tf of ['1D','12H']){
   const ok=PAIRS.filter(s=>data[tf][s]&&data[tf][s].length>50);
   const b=data[tf][ok[0]];
   meta[tf]={paare:ok.length, bars:b?b.length:0,
    von:b?new Date(b[0].ts).toISOString().slice(0,10):'-',
    bis:b?new Date(b[b.length-1].ts).toISOString().slice(0,10):'-'};
  }
  const res={};
  for(const tf of ['1D','12H']){
   say('Backtest '+tf+' — '+GRID.length+' Parameterkombis…');
   await sleep(20);
   const runs=[];
   for(const P of GRID){
    const r=run(data[tf],tf,P,false);
    runs.push({p:'N'+P.n+'/E'+P.n2+'/SL'+P.sl, ...r, bySym:undefined,entryTs:undefined,
      symPos:Object.values(r.bySym).filter(v=>v>0).length,
      symAll:Object.keys(r.bySym).length});
   }
   const pos=runs.filter(r=>r.pnlPct>0);
   const sorted=[...runs].sort((a,b)=>b.pnlPct-a.pnlPct);
   // Median-Parameter aus dem Plateau (mittlere Werte) als Default-Kandidat
   const mid=run(data[tf],tf,{n:20,n2:8,sl:2.0},true);
   res[tf]={
    kombis:runs.length,
    positivAnteil:+(pos.length/runs.length*100).toFixed(0)+'%',
    median_pnl:+(sorted[Math.floor(sorted.length/2)].pnlPct).toFixed(1),
    beste:sorted.slice(0,3).map(r=>r.p+': '+r.pnlPct+'% PF'+r.pf+' DD'+r.maxdd+'% n'+r.n+' Paare+'+r.symPos+'/'+r.symAll),
    schlechteste:sorted.slice(-3).map(r=>r.p+': '+r.pnlPct+'% PF'+r.pf),
    default_N20_E8_SL2:{pnl:mid.pnlPct+'%',pf:mid.pf,dd:mid.maxdd+'%',n:mid.n,wr:mid.wr+'%',
      paare_positiv:Object.values(mid.bySym).filter(v=>v>0).length+'/'+Object.keys(mid.bySym).length,
      proPaar:Object.fromEntries(Object.entries(mid.bySym).map(([k,v])=>[k.replace('USDT',''),Math.round(v)]))},
    _entryTs:mid.entryTs
   };
  }
  // ── Korrelation/Überlappung 1D vs 12H (Proxy für Bot-2-Overlap) ──
  const a=res['1D']._entryTs||[], b=res['12H']._entryTs||[];
  const near=(x,arr,tol)=>arr.some(y=>Math.abs(y-x)<=tol);
  const tol=12*3600000; // 12h Toleranz
  const ov=a.length?a.filter(x=>near(x,b,tol)).length/a.length*100:0;
  delete res['1D']._entryTs; delete res['12H']._entryTs;
  const out={
   hinweis:'Hürde: >=60% Paare positiv · >=70% Parameterkombis positiv · MaxDD <30% · Overlap <50%',
   daten:meta,
   ergebnis:res,
   overlap_1D_vs_12H:ov.toFixed(0)+'% (Einstiege innerhalb 12h beieinander)'
  };
  $out.textContent=JSON.stringify(out,null,1);
  say('FERTIG ✅');
 }catch(e){ say('FEHLER: '+e); $out.textContent=String(e&&e.stack||e); }
})();
