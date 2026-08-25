#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// CLOUD-BOT 5 — SMA150-Trendfilter, long/flat (Anzeige: „BOT 3")
//
// Ersetzt den Sweep-Reversal-Bot (bot4.js), der am 05.08.2026 endgültig
// durchgefallen ist: -48,6 % über zwei Jahre, 1.204 Trades, PF 0,85,
// 0 von 21 Gitterkombis in-sample positiv.
//
// ⚠️  UNVALIDIERT — und zwar wissentlich.
//     Im Test vom 05.08.2026 (BOT3-ERSATZ-KRITERIEN.md) ist diese Strategie
//     an der Projekt-Hürde GESCHEITERT:
//       · Walk-Forward 50/50: L150 in-sample +35,5 % → out-of-sample -2,2 %
//       · Walk-Forward 70/30: L150 in-sample +36,0 % → out-of-sample -3,6 %
//       · Gitter out-of-sample positiv: 0 von 5 in beiden Aufteilungen
//       · Der in-sample BESTE Parameter war out-of-sample der schlechteste
//     Gegen Kaufen-und-Halten (-44 %) sieht das gut aus, gegen schlicht
//     NICHTS TUN (0 %) verliert es. Letzteres ist der ehrliche Vergleich.
//     William hat den Bau nach dieser Auskunft ausdrücklich gewünscht.
//     Läuft als reiner Papiergeld-Forward-Test.
//
// ── Die gesamte Strategie in einem Satz ────────────────────────────
// Long in einem Paar, solange der letzte Tagesschluss über seiner
// SMA150 liegt. Sonst flach. Zehn Paare, je ein Zehntel des Kapitals.
//
// Kein Hebel. Keine Shorts. Kein Stop, kein Ziel, kein Timeout.
// Ein Indikator, ein Parameter. Das ist der Punkt.
//
// ── Warum das robuster gegen Ausfälle ist als BOT 1/BOT 3 ──────────
// Diese Strategie ist ZUSTANDSbasiert, nicht EREIGNISbasiert. Sie fragt
// „soll ich gerade long sein?", nicht „ist gerade ein Signal passiert?".
// Ein verpasster Lauf verpasst deshalb kein Signal — der nächste Lauf
// stellt schlicht den richtigen Zustand her. Genau daran hat der alte
// BOT 3 gelitten (missedBars, Freshness-Guard, Drift-Verwerfungen);
// hier entfällt das Problem ersatzlos.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const FS=require('fs');

const P={
  sma:150,                 // der einzige Strategie-Parameter
  // ── Chandelier-Stop, ergaenzt 22.08.2026 auf Williams Wunsch ────
  // Verkauf auch dann, wenn der Kurs mehr als N x ATR(14) unter sein Hoch
  // SEIT EINSTIEG faellt. Anlass: am 22.08. lag der SMA150-Ausstieg bei JEDER
  // der acht Positionen UNTER dem Einstiegskurs — LINK stand +39 %, waere aber
  // erst bei -0,9 % gegenueber Einstieg verkauft worden. Der gesamte
  // unrealisierte Gewinn war geliehen.
  // UNGETESTET. Kein Walk-Forward. N=3 ist der Lehrbuchwert (Chandelier nach
  // Chuck LeBeau), NICHT aus den Daten optimiert — bewusst, weil
  // In-sample-Optimierung in diesem Projekt zweimal den out-of-sample
  // schlechtesten Wert gewaehlt hat.
  chandAtr:3.0,
  initBal:2000,
  slots:10,                // gleichgewichtet: je 1/10 der Equity
  fee:0.0005,              // 0,05 % je Seite
  slip:0.02,               // 0,02 % Slippage
  barMs:24*3600000,
  // Reine Plausibilitätsgrenze, KEIN Freshness-Guard im Sinne von BOT 1/3:
  // ist die letzte geschlossene Tageskerze älter als 48 h, stimmt etwas mit
  // der Datenquelle nicht und der Lauf wird übersprungen.
  maxBarAge:48*3600000
};

// Exakt das getestete Universum aus BOT3-ERSATZ-KRITERIEN.md.
const SYMS=['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'].map(s=>s+'USDT');

const OKX='https://www.okx.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// OKX kennt für Tageskerzen die UTC-Variante '1Dutc' (erst ab 6H verfügbar).
async function candles(sym,limit){
  const inst=sym.replace('USDT','-USDT-SWAP');
  const r=await fetch(OKX+'/api/v5/market/candles?instId='+inst+'&bar=1Dutc&limit='+(limit||200),
    {headers:{'User-Agent':'cloud-bot5/1.0'}});
  const d=await r.json();
  if(d.code!=='0'||!d.data||!d.data.length) return null;
  const now=Date.now();
  const all=[...d.data].reverse().map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4]}));
  // Die laufende Kerze ist noch nicht geschlossen — ihr Schluss IST der aktuelle Kurs.
  return { k: all.filter(b=>b.ts+P.barMs<=now), live: all[all.length-1].c };
}

function sma(arr,n){
  if(arr.length<n) return null;
  let s=0; for(let i=arr.length-n;i<arr.length;i++) s+=arr[i];
  return s/n;
}

// Wilder-ATR(14) auf abgeschlossenen Tageskerzen.
function atr14(k,n){
  n=n||14;
  if(k.length<n+1) return 0;
  const tr=[];
  for(let i=1;i<k.length;i++) tr.push(Math.max(k[i].h-k[i].l,Math.abs(k[i].h-k[i-1].c),Math.abs(k[i].l-k[i-1].c)));
  let a=tr.slice(0,n).reduce((x,y)=>x+y,0)/n;
  for(let i=n;i<tr.length;i++) a=(a*(n-1)+tr[i])/n;
  return a;
}

function loadState(){
  try{ return JSON.parse(FS.readFileSync('state5.json','utf8')); }
  catch(e){ return {bal:P.initBal,peak:P.initBal,positions:[],trades:[],
    started:new Date().toISOString(),runs:0,skipStale:0}; }
}

async function main(){
  const st=loadState(); st.runs=(st.runs||0)+1;
  const log=[]; const px={}; const wanted={};

  // ── 1. Sollzustand je Paar bestimmen ──
  for(const sym of SYMS){
    await sleep(150);
    let res; try{ res=await candles(sym,P.sma+50); }catch(e){ res=null; }
    if(!res||!res.k||res.k.length<P.sma+1){ log.push('· '+sym.replace('USDT','')+': zu wenig Daten'); continue; }
    const k=res.k, last=k[k.length-1];
    if(Date.now()-(last.ts+P.barMs) > P.maxBarAge){
      st.skipStale=(st.skipStale||0)+1;
      log.push('⏭ '+sym.replace('USDT','')+': Daten zu alt, übersprungen');
      continue;
    }
    px[sym]=res.live;
    const line=sma(k.map(b=>b.c),P.sma);
    if(line==null) continue;
    wanted[sym]={long:last.c>line, close:last.c, sma:line, atr:atr14(k), hi:last.h, hiTs:last.ts};
  }

  // ── 2. Ausstiege: Position vorhanden, Sollzustand flach ──
  for(const pos of [...st.positions]){
    const w=wanted[pos.sym]; if(!w) continue;      // ohne frische Daten nichts anfassen
    // Hoch seit Einstieg fortschreiben. Bei Altpositionen ohne `hh` beginnt es
    // beim Einstiegskurs — der Stop startet dadurch weiter weg und zieht sich
    // erst mit neuen Hochs zusammen. Bewusst die vorsichtige Richtung: lieber
    // zu spaet ausgestoppt als eine laufende Position sofort glattgestellt.
    // ⚠️ Fehler vom 22.08., behoben am 24.08.: hier wurde `w.hi` bedingungslos
    // eingerechnet — das Hoch der letzten GESCHLOSSENEN Kerze, auch wenn die
    // noch VOR dem Einstieg lag. Bei Kaeufen nach einem Ruecksetzer war das
    // Vorkerzen-Hoch hoeher als alles danach: DOGE lag dadurch 6,7 % und LTC
    // 2,6 % zu hoch, der Chandelier-Stop entsprechend zu eng — also genau in
    // die gefaehrliche Richtung (vorzeitiger Ausstieg). Jetzt zaehlt die Kerze
    // nur, wenn sie nach dem Einstieg begonnen hat.
    if(w.hiTs>=pos.ts) pos.hh=Math.max(pos.hh||pos.price, w.hi);
    pos.hh=Math.max(pos.hh||pos.price, px[pos.sym]);
    // ⚠️ Sperrklinke, ergaenzt 24.08.2026. Vorher wurde der Stop bei jedem Lauf
    // NEU gerechnet und nirgends gespeichert. Da er `Hoch - 3xATR` ist und die
    // ATR im Abverkauf STEIGT, wanderte der Stop bei Turbulenz nach UNTEN — er
    // wich also genau dann zurueck, wenn er halten muss. Am 24.08. gemessen:
    // alle 8 Positionen hatten binnen einer Woche einen um 3,5-10,5 % tieferen
    // Stop, weil die ATR um 67-210 % gestiegen war (XRP: -10,5 %).
    // Ein nachlaufender Stop darf sich NIE lockern. Deshalb wird er jetzt in
    // `pos.sl` gespeichert und nur noch nach oben nachgezogen.
    const chand = w.atr>0 ? pos.hh-P.chandAtr*w.atr : null;
    if(chand!=null) pos.sl = pos.sl==null ? chand : Math.max(pos.sl, chand);
    const trailAus = pos.sl!=null && px[pos.sym]<=pos.sl;
    // ⚠️ Geaendert 24.08.2026 auf Williams Wunsch: das Abbruchkriterium ist raus.
    // Frueher schloss AUCH ein Tagesschluss unter der SMA150 die Position
    // (Grund 'SMA'). Jetzt schliesst NUR noch der nachlaufende Stop.
    // Die SMA150 ist damit reine EINSTIEGS-Regel.
    // Folge, die man kennen muss: faellt ein Paar unter die SMA150, bleibt die
    // Position offen, bis der Chandelier 3xATR unter dem Hoch erreicht ist —
    // der Ausstieg kommt also spaeter und tiefer als vorher.
    if(!trailAus) continue;
    const grund='TRAIL';
    const price=px[pos.sym]*(1-P.slip/100);
    const proceeds=pos.size*price;
    const fee=proceeds*P.fee;
    const pnl=proceeds-fee-(pos.size*pos.price)-pos.eFee;
    st.bal+=proceeds-fee;
    st.trades.push({ts:Date.now(),sym:pos.sym,side:'LONG',entry:pos.price,
      exit:+price.toPrecision(8),pnl:+pnl.toFixed(2),reason:grund});
    st.positions=st.positions.filter(p=>p.sym!==pos.sym);
    // Nach einem Trail-Ausstieg sagt die SMA-Regel weiterhin "long" — ohne Sperre
    // wuerde der Bot im selben Lauf sofort zurueckkaufen und endlos hin- und
    // herhandeln (im Test am 22.08. exakt so passiert: 10 TRAIL-Ausstiege und
    // 10 sofortige Neukaeufe). Wiedereinstieg erst, wenn das Signal sich
    // zurueckgesetzt hat, also der Kurs einmal unter der SMA150 geschlossen hat.
    if(grund==='TRAIL'){ st.gesperrt=st.gesperrt||{}; st.gesperrt[pos.sym]=true; }
    log.push((pnl>=0?'✅ ':'❌ ')+'CLOSE '+pos.sym.replace('USDT','')+' '+grund+' '+(pnl>=0?'+':'')+pnl.toFixed(2)+'$');
  }

  // ── 3. Einstiege: keine Position, Sollzustand long ──
  // Equity nach den Ausstiegen, damit die Größe zum aktuellen Stand passt.
  const held=()=>st.positions.reduce((a,p)=>a+p.size*(px[p.sym]||p.price),0);
  for(const sym of SYMS){
    const w=wanted[sym]; if(!w) continue;
    // Sperre aufheben, sobald das Signal sich zurueckgesetzt hat.
    if(st.gesperrt&&st.gesperrt[sym]&&!w.long) delete st.gesperrt[sym];
    if(!w.long) continue;
    if(st.gesperrt&&st.gesperrt[sym]) continue;
    if(st.positions.find(p=>p.sym===sym)) continue;
    const equity=st.bal+held();
    let notional=equity/P.slots;
    // Die Gebühren zehren an der Kasse: ohne diese Deckelung reicht das Geld für den
    // zehnten Slot um wenige Cent nicht und er bliebe dauerhaft leer. Dann lieber eine
    // minimal kleinere letzte Position als eine fehlende.
    const maxAff=st.bal/(1+P.fee);
    if(notional>maxAff) notional=maxAff;
    const price=px[sym]*(1+P.slip/100);
    const size=notional/price;
    const eFee=notional*P.fee;
    if(notional<1) continue;                           // kein Hebel: nur mit freier Kasse
    st.bal-=notional+eFee;
    // `margin` ist ohne Hebel schlicht der eingesetzte Betrag. Das Feld heisst so,
    // weil das Dashboard `Equity = bal + Summe margin + Summe unrealisiert` rechnet — ohne
    // dieses Feld wuerde BOT 3 dort mit fast null Equity erscheinen.
    // Stop gleich beim Einstieg setzen, damit die Position nicht einen Lauf lang
    // ohne Stop dasteht (Ausstiege laufen vor den Einstiegen).
    const slNeu = w.atr>0 ? price-P.chandAtr*w.atr : null;
    st.positions.push({sym,side:'LONG',price,size,margin:notional,eFee,hh:price,sl:slNeu,ts:Date.now()});
    log.push('⚡ OPEN '+sym.replace('USDT','')+' @'+price.toPrecision(6)+' ('+notional.toFixed(0)+'$)');
  }

  // ── 4. Report ──
  const value=st.positions.reduce((a,p)=>a+p.size*(px[p.sym]||p.price),0);
  const equity=st.bal+value;
  if(equity>st.peak) st.peak=equity;
  const w=st.trades.filter(t=>t.pnl>0);
  const wr=st.trades.length?w.length/st.trades.length*100:0;
  const gp=w.reduce((a,t)=>a+t.pnl,0);
  const gl=Math.abs(st.trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0));
  FS.writeFileSync('state5.json',JSON.stringify(st,null,1));

  const L=[];
  L.push('# Cloud-Bot 5 — SMA150-Trendfilter (Paper, UNVALIDIERT)');
  L.push('');
  L.push('> ⚠️ **An der Projekt-Hürde gescheitert.** Walk-Forward out-of-sample -2,2 % (50/50)');
  L.push('> und -3,6 % (70/30); 0 von 5 Gitterkombis out-of-sample positiv; der in-sample beste');
  L.push('> Parameter war out-of-sample der schlechteste. Schlägt Kaufen-und-Halten, verliert');
  L.push('> aber gegen Nichtstun. Läuft auf ausdrücklichen Wunsch als Forward-Test.');
  L.push('> Details: BOT3-ERSATZ-KRITERIEN.md');
  L.push('');
  L.push('> Aktualisiert: '+new Date().toISOString().replace('T',' ').slice(0,16)+' UTC · Lauf #'+st.runs+' · 1D · SMA'+P.sma+' · long/flat, kein Hebel');
  L.push('>');
  L.push('> Läufe wegen veralteter Daten übersprungen: '+(st.skipStale||0));
  L.push('');
  L.push('| Equity | PnL | Winrate | PF | Trades | Offen |');
  L.push('|---|---|---|---|---|---|');
  L.push('| $'+equity.toFixed(2)+' | '+(equity-P.initBal>=0?'+':'')+(equity-P.initBal).toFixed(2)+'$ ('+((equity-P.initBal)/P.initBal*100).toFixed(1)+'%) | '+wr.toFixed(0)+'% | '+(gl>0?(gp/gl).toFixed(2):'—')+' | '+st.trades.length+' | '+st.positions.length+'/'+P.slots+' |');
  L.push('');
  const sig=SYMS.filter(s=>wanted[s]);
  if(sig.length){
    L.push('## Signallage'); L.push('');
    L.push('| Pair | Kurs | SMA'+P.sma+' | Soll |'); L.push('|---|---|---|---|');
    sig.forEach(s=>{const w2=wanted[s];
      L.push('| '+s.replace('USDT','')+' | '+w2.close.toPrecision(6)+' | '+w2.sma.toPrecision(6)+' | '+(w2.long?'LONG':'flach')+' |');});
    L.push('');
  }
  if(st.positions.length){
    L.push('## Offene Positionen'); L.push('');
    L.push('| Pair | Entry | Kurs | Wert | PnL |'); L.push('|---|---|---|---|---|');
    st.positions.forEach(p=>{const lp=px[p.sym]||p.price; const v=p.size*lp; const g=v-p.size*p.price;
      L.push('| '+p.sym.replace('USDT','')+' | '+p.price.toPrecision(6)+' | '+lp.toPrecision(6)+' | $'+v.toFixed(0)+' | '+(g>=0?'+':'')+g.toFixed(2)+'$ |');});
    L.push('');
  }
  const recent=[...st.trades].slice(-12).reverse();
  if(recent.length){
    L.push('## Letzte Trades'); L.push('');
    L.push('| Zeit (UTC) | Pair | Entry | Exit | PnL |'); L.push('|---|---|---|---|---|');
    recent.forEach(t=>L.push('| '+new Date(t.ts).toISOString().slice(5,16).replace('T',' ')+' | '+t.sym.replace('USDT','')+' | '+(+t.entry).toPrecision(6)+' | '+(+t.exit).toPrecision(6)+' | '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'$ |'));
    L.push('');
  }
  if(log.length){ L.push('## Dieser Lauf'); L.push(''); log.forEach(m=>L.push('- '+m)); }
  FS.writeFileSync('REPORT5.md',L.join('\n'));
  console.log(log.join('\n')||'(keine Aktionen)');
  console.log('Equity $'+equity.toFixed(2)+' · '+st.trades.length+' Trades · WR '+wr.toFixed(0)+'% · '+st.positions.length+'/'+P.slots+' offen');
}

function selftest(){
  // 1. SMA-Rechnung gegen einen von Hand nachrechenbaren Fall
  const a=[1,2,3,4,5,6,7,8,9,10];
  const m=sma(a,5);                       // Mittel aus 6..10 = 8
  if(Math.abs(m-8)>1e-9) throw new Error('SMA falsch: '+m);
  if(sma([1,2],5)!==null) throw new Error('SMA muss bei zu wenig Daten null liefern');

  // 2. Signallogik: steigende Reihe → long, fallende → flach
  const up=[]; for(let i=0;i<P.sma+10;i++) up.push(100+i);
  const dn=[]; for(let i=0;i<P.sma+10;i++) dn.push(100-i*0.3);
  const upLong=up[up.length-1]>sma(up,P.sma);
  const dnLong=dn[dn.length-1]>sma(dn,P.sma);
  if(!upLong) throw new Error('Aufwärtstrend muss LONG ergeben');
  if(dnLong)  throw new Error('Abwärtstrend muss FLACH ergeben');

  // 3. Positionsgröße: 10 Slots aus $2000 → je $200, ohne Hebel nie mehr als die Equity
  const eq=2000, notional=eq/P.slots;
  if(Math.abs(notional-200)>1e-9) throw new Error('Slot-Größe falsch');
  if(notional*P.slots>eq+1e-9) throw new Error('Gesamt-Notional darf die Equity nicht übersteigen');

  console.log('SELFTEST OK — SMA'+P.sma+' · long bei Aufwärts: '+upLong+' · flach bei Abwärts: '+!dnLong+
    ' · Slot $'+notional.toFixed(2)+' · kein Hebel');
}

if(process.argv.includes('--selftest')) selftest();
else main().catch(e=>{console.error('FEHLER:',e.message);process.exit(1);});
