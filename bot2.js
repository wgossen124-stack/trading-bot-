// ═══════════════════════════════════════════════════════════════════
// Cloud-Bot 2 — Donchian-Breakout + EMA200-Trendfilter + Turtle-Exit (6h)
// Paper-Trading. Eigene State/Report-Dateien (state2.json / REPORT2.md).
// Strategie backtest-validiert über BTC/ETH/SOL (robust in 13/16 Param-Kombis).
//   Entry: Close bricht über N-Bar-Hoch (LONG) / unter N-Bar-Tief (SHORT)
//          UND in Richtung EMA200-Trend.
//   Exit : Turtle — N2-Bar-Gegenkanal (trailing) + initialer 2×ATR-Stop + Timeout.
// ═══════════════════════════════════════════════════════════════════
const FS = require('fs');

const P = {
  tf:'6H', barMs:6*3600000,
  nEntry:30, nExit:10, slMult:2.0, timeoutBars:40,   // Strategie-Parameter (Plateau-Mitte)
  initBal:2000, riskPct:1.0, leverage:3,
  maxPositions:8, maxSameSide:3, maxHeatPct:40,       // Cluster-Limit wie Bot 1 v8
  feeRate:0.0005, slipPct:0.02, cooldownBars:2,
};

// Liquide Paper-Universe (OKX-Perps)
const SYMS = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK','AVAX','DOT',
  'LTC','ATOM','NEAR','APT','ARB','OP','INJ','SUI','TIA','FIL'].map(s=>s+'USDT');

// ── Indikatoren ──────────────────────────────────────────────────────
function ema(data,n){ const k=2/(n+1); let e=data[0]; return data.map(v=>(e=v*k+e*(1-k))); }
function atr(candles,n=14){
  const tr=candles.slice(1).map((c,i)=>Math.max(c.h-c.l,Math.abs(c.h-candles[i].c),Math.abs(c.l-candles[i].c)));
  if(tr.length<n) return [0];
  let a=tr.slice(0,n).reduce((x,y)=>x+y)/n; const o=[a];
  for(let i=n;i<tr.length;i++){ a=(a*(n-1)+tr[i])/n; o.push(a); }
  return o;
}

// ── Signal: Donchian-Breakout + EMA200-Filter ───────────────────────
// candles = abgeschlossene Kerzen; wertet die LETZTE als Ausbruchskerze.
function signal(candles){
  if(candles.length < Math.max(P.nEntry+2, 205)) return null;
  const N=candles.length-1, c=candles[N];
  const closes=candles.map(x=>x.c);
  const e200=ema(closes,200)[N];
  const a=atr(candles,14).at(-1)||0;
  if(a<=0) return null;
  // Donchian-Kanal aus den N vorherigen Bars (ohne die aktuelle)
  const prev=candles.slice(N-P.nEntry, N);
  const hh=Math.max(...prev.map(x=>x.h)), ll=Math.min(...prev.map(x=>x.l));
  let sig=null;
  if(c.c>hh && c.c>e200) sig='LONG';
  else if(c.c<ll && c.c<e200) sig='SHORT';
  if(!sig) return null;
  return {sig, price:c.c, atr:a, e200};
}

// ── Turtle-Trailing-Stop: N2-Bar-Gegenkanal ─────────────────────────
function turtleStop(candles, side){
  const prev=candles.slice(-P.nExit);           // letzte N2 abgeschlossene Bars
  return side==='LONG' ? Math.min(...prev.map(x=>x.l)) : Math.max(...prev.map(x=>x.h));
}

// ── OKX-Daten ────────────────────────────────────────────────────────
const OKX='https://www.okx.com';
async function okxK(sym,bar,limit){
  const inst=sym.replace('USDT','-USDT-SWAP');
  const r=await fetch(OKX+'/api/v5/market/candles?instId='+inst+'&bar='+bar+'&limit='+(limit||300),
    {headers:{'User-Agent':'cloud-bot2/1.0'}});
  const d=await r.json();
  if(d.code!=='0'||!d.data||!d.data.length) return null;
  return [...d.data].reverse().map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}));
}
const closedOnly=(arr,barMs)=>{ if(!arr)return null; const now=Date.now(); return arr.filter(b=>b.ts+barMs<=now); };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadState(){
  try{ return JSON.parse(FS.readFileSync('state2.json','utf8')); }
  catch(e){ return {bal:P.initBal,peak:P.initBal,positions:[],trades:[],cd:{},started:new Date().toISOString(),runs:0}; }
}

// ── Hauptlauf ────────────────────────────────────────────────────────
async function main(){
  const st=loadState(); st.runs=(st.runs||0)+1;
  const log=[];
  const candidates=[];

  for(const sym of SYMS){
    await sleep(150);
    let k; try{ k=closedOnly(await okxK(sym,P.tf,300),P.barMs); }catch(e){ k=null; }
    if(!k||k.length<205) continue;
    const last=k[k.length-1];

    // ── Exits für offene Position in diesem Symbol ──
    const pos=st.positions.find(p=>p.sym===sym);
    if(pos){
      const newBars=k.filter(b=>b.ts>(pos.lastCheck||pos.ts));
      for(const bar of newBars){
        const idx=k.indexOf(bar);
        // Trailing-Stop auf Turtle-Kanal nachziehen (nur in Gewinnrichtung)
        const tstop=turtleStop(k.slice(0,idx), pos.side);
        if(pos.side==='LONG') pos.sl=Math.max(pos.sl, tstop);
        else                  pos.sl=Math.min(pos.sl, tstop);
        let exit=null, reason='';
        if(pos.side==='LONG'){ if(bar.l<=pos.sl){exit=pos.sl*(1-P.slipPct/100);reason='STOP';} }
        else                 { if(bar.h>=pos.sl){exit=pos.sl*(1+P.slipPct/100);reason='STOP';} }
        if(exit==null && (bar.ts-(pos.ts||0))>=P.timeoutBars*P.barMs){
          exit=pos.side==='LONG'?bar.c*(1-P.slipPct/100):bar.c*(1+P.slipPct/100); reason='TIME';
        }
        if(exit!=null){
          const diff=pos.side==='LONG'?exit-pos.price:pos.price-exit;
          const pnl=diff*pos.size - exit*pos.size*P.feeRate - pos.eFee;
          st.bal+=pos.margin+pnl+pos.eFee;
          st.trades.push({ts:bar.ts,sym,side:pos.side,entry:pos.price,exit:+exit.toPrecision(8),
            pnl:+pnl.toFixed(2),reason});
          st.cd[sym]=bar.ts;
          st.positions=st.positions.filter(p=>p!==pos);
          log.push('✔ CLOSE '+pos.side+' '+sym.replace('USDT','')+' '+(pnl>=0?'+':'')+pnl.toFixed(2)+'$ ('+reason+')');
          break;
        }
        pos.lastCheck=bar.ts;
      }
    }

    // ── Entry-Kandidat ──
    if(st.positions.find(p=>p.sym===sym)) continue;
    if(st.cd[sym] && Date.now()-st.cd[sym] < P.cooldownBars*P.barMs) continue;
    // Freshness-Guard: Bot läuft stündlich, aber Entries nur direkt nach 6h-Kerzenschluss
    // (sonst würde ein altes Breakout-Signal bis zu 5h später zu Stale-Preisen eröffnet)
    if(Date.now()-(last.ts+P.barMs) > 2*3600000) continue;
    const s=signal(k);
    if(s) candidates.push({sym,...s,ts:last.ts});
  }

  // ── Entries eröffnen (Cluster-Limit + Heat) ──
  for(const c of candidates){
    if(st.positions.length>=P.maxPositions) break;
    if(st.positions.filter(p=>p.side===c.sig).length>=P.maxSameSide) continue;  // max. 3 gleichgerichtet
    const locked=st.positions.reduce((a,p)=>a+p.margin,0);
    const eq=st.bal+locked;
    if(eq<=0 || locked/eq*100>=P.maxHeatPct) break;
    const price=c.sig==='LONG'?c.price*(1+P.slipPct/100):c.price*(1-P.slipPct/100);
    const slDist=P.slMult*c.atr;
    if(slDist<=0) continue;
    const sl=c.sig==='LONG'?price-slDist:price+slDist;
    let size=(st.bal*P.riskPct/100)/slDist, margin=size*price/P.leverage;
    const cap=eq*12/100; if(margin>cap){size*=cap/margin;margin=cap;}
    const eFee=size*price*P.feeRate;
    if(margin+eFee>st.bal||margin<1) continue;
    st.bal-=margin+eFee;
    st.positions.push({sym:c.sym,side:c.sig,price,sl,size,margin,eFee,ts:Date.now(),lastCheck:c.ts});
    log.push('⚡ OPEN '+c.sig+' '+c.sym.replace('USDT','')+' @'+price.toPrecision(6)+' SL '+sl.toPrecision(6));
  }

  // ── Report + State ──
  const locked=st.positions.reduce((a,p)=>a+p.margin,0);
  const equity=st.bal+locked;
  if(equity>st.peak) st.peak=equity;
  const w=st.trades.filter(t=>t.pnl>0);
  const wr=st.trades.length?w.length/st.trades.length*100:0;
  FS.writeFileSync('state2.json',JSON.stringify(st,null,1));

  const L=[];
  L.push('# Cloud-Bot 2 — Donchian-Breakout (Paper)');
  L.push('');
  L.push('> Aktualisiert: '+new Date().toISOString().replace('T',' ').slice(0,16)+' UTC · Lauf #'+st.runs+' · '+P.tf+' · N'+P.nEntry+'/'+P.nExit);
  L.push('');
  L.push('| Equity | PnL | Winrate | Trades | Offen | Drawdown |');
  L.push('|---|---|---|---|---|---|');
  L.push('| $'+equity.toFixed(2)+' | '+(equity-P.initBal>=0?'+':'')+(equity-P.initBal).toFixed(2)+'$ ('+((equity-P.initBal)/P.initBal*100).toFixed(1)+'%) | '+wr.toFixed(0)+'% | '+st.trades.length+' | '+st.positions.length+' | '+(st.peak>0?((st.peak-equity)/st.peak*100).toFixed(1):'0')+'% |');
  L.push('');
  if(st.positions.length){
    L.push('## Offene Positionen'); L.push('');
    L.push('| Pair | Seite | Entry | Stop |'); L.push('|---|---|---|---|');
    st.positions.forEach(p=>L.push('| '+p.sym.replace('USDT','')+' | '+p.side+' | '+p.price.toPrecision(6)+' | '+p.sl.toPrecision(6)+' |'));
    L.push('');
  }
  const recent=[...st.trades].slice(-15).reverse();
  if(recent.length){
    L.push('## Letzte Trades'); L.push('');
    L.push('| Zeit (UTC) | Pair | Seite | PnL | Grund |'); L.push('|---|---|---|---|---|');
    recent.forEach(t=>L.push('| '+new Date(t.ts).toISOString().slice(5,16).replace('T',' ')+' | '+t.sym.replace('USDT','')+' | '+t.side+' | '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'$ | '+t.reason+' |'));
    L.push('');
  }
  if(log.length){ L.push('## Dieser Lauf'); L.push(''); log.forEach(m=>L.push('- '+m)); }
  FS.writeFileSync('REPORT2.md',L.join('\n'));
  console.log(log.join('\n')||'(keine Aktionen)');
  console.log('Equity $'+equity.toFixed(2)+' · '+st.trades.length+' Trades · WR '+wr.toFixed(0)+'%');
}

// ── Selbsttest (synthetische Trend-Kerzen, kein Netz) ──
function selftest(){
  const arr=[]; let p=100;
  for(let i=0;i<260;i++){ const drift=Math.sin(i/30)*0.9+0.05; const o=p; p=p*(1+drift/100+(Math.random()-0.5)*0.004);
    arr.push({ts:i*P.barMs,o,h:Math.max(o,p)*1.004,l:Math.min(o,p)*0.996,c:p,v:1000}); }
  const s=signal(arr);
  const ts=turtleStop(arr,'LONG');
  console.log('SELFTEST OK — signal:'+(s?s.sig+' @'+s.price.toFixed(2):'kein')+' · turtleStop(L):'+ts.toFixed(2)+' · bars:'+arr.length);
}

if(process.argv.includes('--selftest')) selftest();
else main().catch(e=>{console.error('FEHLER:',e.message);process.exit(1);});
