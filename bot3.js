#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// CLOUD-BOT 3 — Cross-Sectional Momentum (relative Stärke), Tageskerzen
//
// ⚠️  UNVALIDIERT. Dieser Bot hat den Walk-Forward-Test NICHT bestanden:
//     derselbe Parametersatz machte in-sample +128 %/+187 % und
//     out-of-sample -28,8 % (2/10 Paare, 36,8 % Drawdown) bzw. +1,1 %.
//     Er läuft ausschließlich mit Papiergeld als Forward-Test — der
//     einzige Out-of-Sample-Test, der noch aussteht. Details:
//     BOT34-KRITERIEN.md.
//     Exposure 60 % = die Original-Spec, auf der auch getestet wurde
//     (28.07.2026 von 30 auf 60 zurückgesetzt, Williams Entscheidung:
//     der Forward-Test soll die Strategie so prüfen, wie sie gemeint ist).
//     Greift beim nächsten Rebalancing — offene Positionen bleiben unberührt.
//
// Logik: alle Paare nach Rendite der letzten LB Tage sortieren,
// die K stärksten long, die K schwächsten short, alle REB Tage neu.
// Kein Stop-Loss — Ausstieg ausschließlich beim Umschichten (klassische Form).
// ═══════════════════════════════════════════════════════════════════
'use strict';
const FS=require('fs');

const P={ lb:20, topK:2, rebDays:14, lev:2, expoPct:60,
  initBal:2000, fee:0.0005, slip:0.02, barMs:86400000 };

// Exakt das Universum, auf dem getestet wurde — nicht erweitern ohne neuen Test.
const SYMS=['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'].map(s=>s+'USDT');

const OKX='https://www.okx.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function candles(sym,limit){
  const inst=sym.replace('USDT','-USDT-SWAP');
  const r=await fetch(OKX+'/api/v5/market/candles?instId='+inst+'&bar=1Dutc&limit='+(limit||100),
    {headers:{'User-Agent':'cloud-bot3/1.0'}});
  const d=await r.json();
  if(d.code!=='0'||!d.data||!d.data.length) return null;
  const now=Date.now();
  const all=[...d.data].reverse().map(c=>({ts:+c[0],c:+c[4]}));
  // Die Rangliste braucht abgeschlossene Tageskerzen, die AUSFÜHRUNG dagegen den
  // aktuellen Kurs — sonst wird zu einem bis zu 24 h alten Schlusskurs gebucht.
  // (Bug gefunden und behoben 29.07.2026.)
  return { k: all.filter(b=>b.ts+P.barMs<=now), live: all[all.length-1].c };
}

function loadState(){
  try{ return JSON.parse(FS.readFileSync('state3.json','utf8')); }
  catch(e){ return {bal:P.initBal,peak:P.initBal,positions:[],trades:[],lastReb:0,
    started:new Date().toISOString(),runs:0}; }
}

async function main(){
  const st=loadState(); st.runs=(st.runs||0)+1;
  const log=[];

  // Kurse holen
  const data={}; const px={};
  for(const s of SYMS){
    await sleep(150);
    let res=null; try{ res=await candles(s,P.lb+5); }catch(e){ res=null; }
    data[s]=res&&res.k&&res.k.length?res.k:null;
    if(res&&res.live!=null) px[s]=res.live;   // Live-Kurs für Ausführung und Bewertung
  }

  const unreal=()=>st.positions.reduce((a,p)=>{
    const lp=px[p.sym]; if(lp==null) return a;
    return a+(p.side==='LONG'?lp/p.entry-1:1-lp/p.entry)*p.notional; },0);

  const due = !st.lastReb || (Date.now()-st.lastReb) >= P.rebDays*P.barMs;

  if(due){
    // ── alte Positionen glattstellen ──
    for(const p of [...st.positions]){
      const lp=px[p.sym]; if(lp==null){ log.push('⚠ kein Kurs für '+p.sym+' — Position bleibt'); continue; }
      const gross=(p.side==='LONG'?lp/p.entry-1:1-lp/p.entry)*p.notional;
      const pnl=gross - p.notional*P.fee*2 - p.notional*P.slip/100*2;
      st.bal+=pnl;
      st.trades.push({ts:Date.now(),sym:p.sym,side:p.side,entry:p.entry,exit:lp,
        pnl:+pnl.toFixed(2),reason:'REBAL'});
      st.positions=st.positions.filter(x=>x!==p);
      log.push((pnl>=0?'✅ ':'❌ ')+'CLOSE '+p.side+' '+p.sym.replace('USDT','')+' '+(pnl>=0?'+':'')+pnl.toFixed(2)+'$');
    }
    // ── neue Rangliste ──
    const rets=[];
    for(const s of SYMS){
      const k=data[s]; if(!k||k.length<P.lb+1) continue;
      const now=k[k.length-1].c, then=k[k.length-1-P.lb].c;
      if(!now||!then) continue;
      rets.push({s, r:now/then-1});
    }
    // Nur umschichten, wenn wirklich alles glattgestellt werden konnte — sonst
    // stünden alte und neue Positionen nebeneinander und die Größenrechnung
    // (eq = st.bal) wäre falsch. (Korrigiert 29.07.2026.)
    if(st.positions.length){
      log.push('⚠ '+st.positions.length+' Position(en) ohne Kurs — Rebalancing verschoben');
    } else if(rets.length>=2*P.topK){
      rets.sort((a,b)=>b.r-a.r);
      const eq=st.bal; // nach dem Schließen ist alles Cash
      const notionalEach=eq*P.lev*(P.expoPct/100)/(2*P.topK);
      for(const x of rets.slice(0,P.topK)){
        st.positions.push({sym:x.s,side:'LONG',entry:px[x.s],notional:notionalEach,ts:Date.now(),ret:+(x.r*100).toFixed(1)});
        log.push('⚡ LONG  '+x.s.replace('USDT','')+' ('+(x.r*100).toFixed(1)+'% in '+P.lb+'d)');
      }
      for(const x of rets.slice(-P.topK)){
        st.positions.push({sym:x.s,side:'SHORT',entry:px[x.s],notional:notionalEach,ts:Date.now(),ret:+(x.r*100).toFixed(1)});
        log.push('⚡ SHORT '+x.s.replace('USDT','')+' ('+(x.r*100).toFixed(1)+'% in '+P.lb+'d)');
      }
      st.lastReb=Date.now();
    } else log.push('⚠ zu wenige Kurse für ein Rebalancing');
  }

  // ── Report ──
  const equity=st.bal+unreal();
  if(equity>st.peak) st.peak=equity;
  const w=st.trades.filter(t=>t.pnl>0);
  const wr=st.trades.length?w.length/st.trades.length*100:0;
  FS.writeFileSync('state3.json',JSON.stringify(st,null,1));

  const nextReb=st.lastReb?new Date(st.lastReb+P.rebDays*P.barMs).toISOString().slice(0,10):'sofort';
  const L=[];
  L.push('# Cloud-Bot 3 — Momentum (Paper, UNVALIDIERT)');
  L.push('');
  L.push('> ⚠️ Hat den Walk-Forward nicht bestanden — läuft als Forward-Test. Siehe BOT34-KRITERIEN.md');
  L.push('');
  L.push('> Aktualisiert: '+new Date().toISOString().replace('T',' ').slice(0,16)+' UTC · Lauf #'+st.runs+' · nächstes Rebalancing: '+nextReb);
  L.push('');
  L.push('| Equity | PnL | Winrate | Umschichtungen | Offen |');
  L.push('|---|---|---|---|---|');
  L.push('| $'+equity.toFixed(2)+' | '+(equity-P.initBal>=0?'+':'')+(equity-P.initBal).toFixed(2)+'$ ('+((equity-P.initBal)/P.initBal*100).toFixed(1)+'%) | '+wr.toFixed(0)+'% | '+st.trades.length+' | '+st.positions.length+' |');
  L.push('');
  if(st.positions.length){
    L.push('## Offene Positionen'); L.push('');
    L.push('| Pair | Seite | Entry | Notional | '+P.lb+'d-Rendite |'); L.push('|---|---|---|---|---|');
    st.positions.forEach(p=>L.push('| '+p.sym.replace('USDT','')+' | '+p.side+' | '+p.entry.toPrecision(6)+' | $'+p.notional.toFixed(0)+' | '+(p.ret>=0?'+':'')+p.ret+'% |'));
    L.push('');
  }
  const recent=[...st.trades].slice(-12).reverse();
  if(recent.length){
    L.push('## Letzte Umschichtungen'); L.push('');
    L.push('| Zeit (UTC) | Pair | Seite | PnL |'); L.push('|---|---|---|---|');
    recent.forEach(t=>L.push('| '+new Date(t.ts).toISOString().slice(5,16).replace('T',' ')+' | '+t.sym.replace('USDT','')+' | '+t.side+' | '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'$ |'));
    L.push('');
  }
  if(log.length){ L.push('## Dieser Lauf'); L.push(''); log.forEach(m=>L.push('- '+m)); }
  FS.writeFileSync('REPORT3.md',L.join('\n'));
  console.log(log.join('\n')||'(kein Rebalancing fällig)');
  console.log('Equity $'+equity.toFixed(2)+' · '+st.positions.length+' offen · nächstes Rebalancing '+nextReb);
}

function selftest(){
  const fake={}; let seed=1;
  const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  for(const s of SYMS){ let p=100+rnd()*50; const k=[];
    for(let i=0;i<30;i++){ p*=1+(rnd()-0.48)/50; k.push({ts:i*P.barMs,c:p}); }
    fake[s]=k; }
  const rets=SYMS.map(s=>({s,r:fake[s][29].c/fake[s][29-P.lb].c-1})).sort((a,b)=>b.r-a.r);
  console.log('SELFTEST OK — '+rets.length+' Paare gerankt · stärkstes '+rets[0].s.replace('USDT','')+
    ' '+(rets[0].r*100).toFixed(1)+'% · schwächstes '+rets[rets.length-1].s.replace('USDT','')+
    ' '+(rets[rets.length-1].r*100).toFixed(1)+'% · Notional/Bein $'+
    (P.initBal*P.lev*(P.expoPct/100)/(2*P.topK)).toFixed(0));
}

if(process.argv.includes('--selftest')) selftest();
else main().catch(e=>{console.error('FEHLER:',e.message);process.exit(1);});
