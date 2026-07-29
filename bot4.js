#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// CLOUD-BOT 4 — Sweep-Reversal (aus der TJR-/ICT-Logik), 4h-Kerzen
//
// ⚠️  UNVALIDIERT. Walk-Forward gemischt bis negativ: ein Fenster +5,7 %,
//     das andere -17,2 % (3/10 Paare). Im Auswahlfenster war selbst das
//     beste Gitterergebnis negativ. Läuft nur mit Papiergeld als
//     Forward-Test. Details: BOT34-KRITERIEN.md
//
// Logik: Preis reißt ein N-Bar-Extrem ab (Stops werden abgeräumt) und
// schließt wieder innerhalb → Einstieg gegen den Ausbruch.
// Ohne Kerzenbestätigung war die Idee im Test in 9 von 9 Fällen negativ,
// deshalb ist sie fest eingebaut: die Kerze muss in Einstiegsrichtung schließen.
// Stop hinter dem Sweep-Docht, Ziel 3R, Timeout nach 20 Bars.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const FS=require('fs');

const P={ n:30, r:3, confirm:true, timeoutBars:20,
  risk:1.0, lev:3, maxPos:5, maxMarginPct:12,
  initBal:2000, fee:0.0005, slip:0.02, barMs:4*3600000,
  // ── Ausführungsfenster (korrigiert 29.07.2026) ──────────────────────
  // Der alte 1,5-h-Guard war der engste von allen und traf auf einen Cron,
  // der real im Median nur alle 1,54 h läuft: 28 von 84 Vier-Stunden-Schlüssen
  // fielen in eine Lücke, also ein Drittel. Bei 3 h sind es 4 von 84.
  // Zusätzlich Ausführung zum Live-Kurs statt zum alten Kerzenschluss.
  maxEntryAge:3*3600000,
  // Sweep-Setups leben vom Einstieg nahe am Umkehrpunkt. Ist der Kurs seit
  // dem Signal um mehr als die halbe Stopdistanz gelaufen, ist er weg.
  maxDriftFrac:0.5 };

// Exakt das getestete Universum.
const SYMS=['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'].map(s=>s+'USDT');

const OKX='https://www.okx.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// OKX kennt KEINE UTC-Variante für 4H — nur '4H'.
async function candles(sym,limit){
  const inst=sym.replace('USDT','-USDT-SWAP');
  const r=await fetch(OKX+'/api/v5/market/candles?instId='+inst+'&bar=4H&limit='+(limit||120),
    {headers:{'User-Agent':'cloud-bot4/1.0'}});
  const d=await r.json();
  if(d.code!=='0'||!d.data||!d.data.length) return null;
  const now=Date.now();
  const all=[...d.data].reverse().map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4]}));
  // OKX liefert die laufende Kerze mit — ihr Schluss IST der aktuelle Kurs.
  return { k: all.filter(b=>b.ts+P.barMs<=now), live: all[all.length-1].c };
}

function loadState(){
  try{ return JSON.parse(FS.readFileSync('state4.json','utf8')); }
  catch(e){ return {bal:P.initBal,peak:P.initBal,positions:[],trades:[],cd:{},
    started:new Date().toISOString(),runs:0}; }
}

async function main(){
  const st=loadState(); st.runs=(st.runs||0)+1;
  const log=[]; const cands=[]; const px={};

  for(const sym of SYMS){
    await sleep(150);
    let res; try{ res=await candles(sym,P.n+40); }catch(e){ res=null; }
    if(!res||!res.k||res.k.length<P.n+5) continue;
    const k=res.k, live=res.live;
    const last=k[k.length-1];
    px[sym]=live;                     // Mark-to-Market zum Live-Kurs, nicht zum Kerzenschluss

    // ── Exits ──
    const pos=st.positions.find(p=>p.sym===sym);
    if(pos){
      const newBars=k.filter(b=>b.ts>(pos.lastCheck||pos.ts));
      for(const bar of newBars){
        let exit=null,reason='';
        if(pos.side==='LONG'){ if(bar.l<=pos.sl){exit=pos.sl*(1-P.slip/100);reason='STOP';}
          else if(bar.h>=pos.tp){exit=pos.tp;reason='ZIEL';} }
        else { if(bar.h>=pos.sl){exit=pos.sl*(1+P.slip/100);reason='STOP';}
          else if(bar.l<=pos.tp){exit=pos.tp;reason='ZIEL';} }
        if(exit==null && (bar.ts-(pos.ts||0))>=P.timeoutBars*P.barMs){
          exit=pos.side==='LONG'?bar.c*(1-P.slip/100):bar.c*(1+P.slip/100); reason='ZEIT';
        }
        if(exit!=null){
          const diff=pos.side==='LONG'?exit-pos.price:pos.price-exit;
          const pnl=diff*pos.size-exit*pos.size*P.fee-pos.eFee;
          st.bal+=pos.margin+pnl+pos.eFee;
          st.trades.push({ts:bar.ts,sym,side:pos.side,entry:pos.price,exit:+exit.toPrecision(8),
            pnl:+pnl.toFixed(2),reason});
          st.cd[sym]=bar.ts;
          st.positions=st.positions.filter(p=>p.sym!==sym);
          log.push((pnl>=0?'✅ ':'❌ ')+pos.side+' '+sym.replace('USDT','')+' '+reason+' '+(pnl>=0?'+':'')+pnl.toFixed(2)+'$');
          break;
        }
        pos.lastCheck=bar.ts;
      }
    }

    // ── Einstiegssignal auf der zuletzt geschlossenen Kerze ──
    if(st.positions.find(p=>p.sym===sym)) continue;
    if(st.cd[sym] && Date.now()-st.cd[sym] < 2*P.barMs) continue;
    // Freshness: Signal nur von der zuletzt geschlossenen Kerze, siehe Kommentar bei P.
    if(Date.now()-(last.ts+P.barMs) > P.maxEntryAge){ st.skipStale=(st.skipStale||0)+1; continue; }
    const prev=k.slice(k.length-1-P.n, k.length-1);
    if(prev.length<P.n) continue;
    const hi=Math.max(...prev.map(x=>x.h)), lo=Math.min(...prev.map(x=>x.l));
    let side=null, extreme=0;
    if(last.h>hi && last.c<hi && (!P.confirm || last.c<last.o)){ side='SHORT'; extreme=last.h; }
    else if(last.l<lo && last.c>lo && (!P.confirm || last.c>last.o)){ side='LONG'; extreme=last.l; }
    if(!side) continue;
    cands.push({sym,side,price:last.c,live,extreme,ts:last.ts});
  }

  // ── Einstiege ──
  for(const c of cands){
    if(st.positions.length>=P.maxPos) break;
    // Ausführung zum Live-Kurs; ist er zu weit vom Signal weggelaufen, kein Einstieg.
    const base=c.live!=null?c.live:c.price;
    const refDist=Math.abs(c.price-c.extreme);
    if(refDist>0 && Math.abs(base-c.price) > P.maxDriftFrac*refDist){ st.skipDrift=(st.skipDrift||0)+1; continue; }
    const price=c.side==='LONG'?base*(1+P.slip/100):base*(1-P.slip/100);
    const sl=c.side==='LONG'?c.extreme*0.999:c.extreme*1.001;
    const slDist=Math.abs(price-sl);
    if(slDist<=0 || slDist/price>0.15) continue;   // absurd weite Stops überspringen
    const tp=c.side==='LONG'?price+P.r*slDist:price-P.r*slDist;
    const locked=st.positions.reduce((a,p)=>a+p.margin,0);
    const eq=st.bal+locked;
    let size=(st.bal*P.risk/100)/slDist, margin=size*price/P.lev;
    const cap=eq*P.maxMarginPct/100; if(margin>cap){size*=cap/margin;margin=cap;}
    const eFee=size*price*P.fee;
    if(margin+eFee>st.bal||margin<1) continue;
    st.bal-=margin+eFee;
    st.positions.push({sym:c.sym,side:c.side,price,sl,tp,size,margin,eFee,
      ts:Date.now(),lastCheck:c.ts});
    log.push('⚡ OPEN '+c.side+' '+c.sym.replace('USDT','')+' @'+price.toPrecision(6)+' SL '+sl.toPrecision(6)+' Ziel '+tp.toPrecision(6));
  }

  // ── Report ──
  const locked=st.positions.reduce((a,p)=>a+p.margin,0);
  const unreal=st.positions.reduce((a,p)=>{const lp=px[p.sym];if(lp==null)return a;
    return a+(p.side==='LONG'?lp-p.price:p.price-lp)*p.size;},0);
  const equity=st.bal+locked+unreal;
  if(equity>st.peak) st.peak=equity;
  const w=st.trades.filter(t=>t.pnl>0);
  const wr=st.trades.length?w.length/st.trades.length*100:0;
  FS.writeFileSync('state4.json',JSON.stringify(st,null,1));

  const L=[];
  L.push('# Cloud-Bot 4 — Sweep-Reversal (Paper, UNVALIDIERT)');
  L.push('');
  L.push('> ⚠️ Walk-Forward gemischt bis negativ — läuft als Forward-Test. Siehe BOT34-KRITERIEN.md');
  L.push('');
  L.push('> Aktualisiert: '+new Date().toISOString().replace('T',' ').slice(0,16)+' UTC · Lauf #'+st.runs+' · 4h · N'+P.n+' · Ziel '+P.r+'R');
  L.push('>');
  L.push('> Verworfen seit Start: '+(st.skipStale||0)+'× Fenster zu alt (>'+(P.maxEntryAge/3600000)+' h) · '+(st.skipDrift||0)+'× Kurs zu weit gelaufen');
  L.push('');
  L.push('| Equity | PnL | Winrate | Trades | Offen |');
  L.push('|---|---|---|---|---|');
  L.push('| $'+equity.toFixed(2)+' | '+(equity-P.initBal>=0?'+':'')+(equity-P.initBal).toFixed(2)+'$ ('+((equity-P.initBal)/P.initBal*100).toFixed(1)+'%) | '+wr.toFixed(0)+'% | '+st.trades.length+' | '+st.positions.length+' |');
  L.push('');
  if(st.positions.length){
    L.push('## Offene Positionen'); L.push('');
    L.push('| Pair | Seite | Entry | Stop | Ziel |'); L.push('|---|---|---|---|---|');
    st.positions.forEach(p=>L.push('| '+p.sym.replace('USDT','')+' | '+p.side+' | '+p.price.toPrecision(6)+' | '+p.sl.toPrecision(6)+' | '+p.tp.toPrecision(6)+' |'));
    L.push('');
  }
  const recent=[...st.trades].slice(-12).reverse();
  if(recent.length){
    L.push('## Letzte Trades'); L.push('');
    L.push('| Zeit (UTC) | Pair | Seite | PnL | Grund |'); L.push('|---|---|---|---|---|');
    recent.forEach(t=>L.push('| '+new Date(t.ts).toISOString().slice(5,16).replace('T',' ')+' | '+t.sym.replace('USDT','')+' | '+t.side+' | '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'$ | '+t.reason+' |'));
    L.push('');
  }
  if(log.length){ L.push('## Dieser Lauf'); L.push(''); log.forEach(m=>L.push('- '+m)); }
  FS.writeFileSync('REPORT4.md',L.join('\n'));
  console.log(log.join('\n')||'(keine Aktionen)');
  console.log('Equity $'+equity.toFixed(2)+' · '+st.trades.length+' Trades · WR '+wr.toFixed(0)+'%');
}

function selftest(){
  // Synthetische Kerzen mit einem eingebauten Sweep über das N-Bar-Hoch
  const k=[]; let p=100;
  for(let i=0;i<P.n+2;i++){ const o=p; p=p*(1+(Math.sin(i/7)/300));
    k.push({ts:i*P.barMs,o,h:Math.max(o,p)*1.002,l:Math.min(o,p)*0.998,c:p}); }
  const prev=k.slice(k.length-1-P.n,k.length-1);
  const hi=Math.max(...prev.map(x=>x.h));
  const last=k[k.length-1];
  last.h=hi*1.01; last.o=hi*0.999; last.c=hi*0.995;   // Docht drüber, Schluss zurück darunter, rote Kerze
  const isShort = last.h>hi && last.c<hi && (!P.confirm || last.c<last.o);
  const sl=last.h*1.001, price=last.c*(1-P.slip/100);
  const slDist=Math.abs(price-sl), tp=price-P.r*slDist;
  console.log('SELFTEST OK — Sweep erkannt: '+isShort+' · Stop '+sl.toFixed(3)+' · Ziel '+tp.toFixed(3)+
    ' · Risiko/Trade $'+(P.initBal*P.risk/100).toFixed(2));
  if(!isShort) throw new Error('Sweep-Erkennung defekt');
}

if(process.argv.includes('--selftest')) selftest();
else main().catch(e=>{console.error('FEHLER:',e.message);process.exit(1);});
