#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// CLOUD-BOT v6 — Paper-Trading, backtest-validierte Strategie
// Identische Signal-Logik wie trading-assistant.html (v6):
// 1h-Entries · nur CANDLE+BOUNCE · Score ≥90 · SL 1.5×ATR (min 0.8%)
// TP 3×ATR (RRR 2:1) · Regime-Gate · 4h-Trendfilter · Momentum-Guards
// Läuft stündlich via GitHub Actions. State in state.json, Report in REPORT.md.
// Datenquelle: OKX (öffentlich, keine Geo-Sperre auf US-Runnern).
// ═══════════════════════════════════════════════════════════════════
'use strict';
const FS=require('fs');

const P={minScore:90,entryTypes:['CANDLE','BOUNCE'],slMult:1.5,tpMult:3.0,minSlPct:0.8,
  riskPct:1.0,leverage:6,maxPositions:5,maxHeatPct:55,maxMarginPct:12,
  cooldownMin:60,feeRate:0.0005,slipPct:0.02,initBal:2000};

const SYMS=['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','LINK','AVAX','DOT','LTC','UNI',
  'ATOM','NEAR','APT','ARB','OP','INJ','FET','SUI','TIA','SEI','WLD','PEPE','SHIB',
  'FIL','TRX','XLM','ETC','JUP','ONDO'].map(s=>s+'USDT');

let _marketRegime={bias:'neutral',btcChg:0}; // wird pro Lauf gesetzt (lohnScore nutzt es)

// ── Extrahierte Signal-Logik (1:1 aus trading-assistant.html) ──────
function fmt(v){
  if(v == null || isNaN(v)) return '–';
  if(v < 0.01) return '$' + v.toFixed(6);
  if(v < 1)    return '$' + v.toFixed(4);
  if(v < 100)  return '$' + v.toFixed(3);
  return '$' + v.toLocaleString('de-DE', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function ema(data, n){
  const k = 2/(n+1); let e = data[0];
  return data.map(v => (e = v*k + e*(1-k)));
}
function rsi(closes, n=14){
  const d = closes.slice(1).map((v,i) => v-closes[i]);
  let g = d.slice(0,n).filter(x=>x>0).reduce((a,b)=>a+b,0)/n;
  let l = d.slice(0,n).filter(x=>x<0).reduce((a,b)=>a+Math.abs(b),0)/n;
  const o = Array(n+1).fill(null);
  for(let i=n; i<d.length; i++){
    g = (g*(n-1) + (d[i]>0?d[i]:0))/n;
    l = (l*(n-1) + (d[i]<0?Math.abs(d[i]):0))/n;
    o.push(l===0 ? 100 : 100 - 100/(1+g/l));
  }
  return o;
}
function macd(closes, f=12, s=26, sg=9){
  const ef=ema(closes,f), es=ema(closes,s);
  const line = ef.map((v,i) => v-es[i]);
  const sl = ema(line.slice(s-1), sg);
  const sf = Array(s-1).fill(null).concat(sl);
  return {line, signal:sf, hist:line.map((v,i) => sf[i]!=null ? v-sf[i] : null)};
}
function atr(candles, n=14){
  const tr = candles.slice(1).map((c,i) => Math.max(c.h-c.l, Math.abs(c.h-candles[i].c), Math.abs(c.l-candles[i].c)));
  let a = tr.slice(0,n).reduce((x,y)=>x+y)/n;
  const o = [a];
  for(let i=n; i<tr.length; i++){ a=(a*(n-1)+tr[i])/n; o.push(a); }
  return o;
}
function adx(candles, n=14){
  if(candles.length < n*2) return 15;
  const tr=[], pdm=[], ndm=[];
  for(let i=1; i<candles.length; i++){
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c)));
    const u=c.h-p.h, dn=p.l-c.l;
    pdm.push(u>dn&&u>0?u:0); ndm.push(dn>u&&dn>0?dn:0);
  }
  const sm=(a,n)=>{ let s=a.slice(0,n).reduce((x,y)=>x+y); const o=[s]; for(let i=n;i<a.length;i++){s=s-s/n+a[i];o.push(s);} return o; };
  const sT=sm(tr,n), sP=sm(pdm,n), sN=sm(ndm,n);
  const DX = sT.map((t,i)=>{ const p=100*sP[i]/(t||1), q=100*sN[i]/(t||1); return 100*Math.abs(p-q)/((p+q)||1); });
  // ADX = Wilder-Glättung von DX / n (sm gibt Summe zurück, kein Durchschnitt)
  return (sm(DX,n).at(-1) / n) || 15;
}
function supertrend(candles, period=10, mult=3){
  if(candles.length < period+2) return {trend:1, line:candles.at(-1).c};
  const aV = atr(candles, period);
  let ub=0, lb=0, trend=1;
  for(let i=period; i<candles.length; i++){
    const a=aV[i-period], hl2=(candles[i].h+candles[i].l)/2;
    const rU=hl2+mult*a, rL=hl2-mult*a;
    const nU = (i===period||rU<ub||candles[i-1].c>ub) ? rU : ub;
    const nL = (i===period||rL>lb||candles[i-1].c<lb) ? rL : lb;
    ub=nU; lb=nL;
    if(candles[i].c>ub) trend=1; else if(candles[i].c<lb) trend=-1;
  }
  return {trend, line: trend===1?lb:ub};
}
function bbands(closes, n=20, mult=2){
  const o=[];
  for(let i=n-1; i<closes.length; i++){
    const s=closes.slice(i-n+1,i+1), mean=s.reduce((a,b)=>a+b)/n;
    const std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/n);
    o.push({upper:mean+mult*std, lower:mean-mult*std, mid:mean, width:(4*std)/(mean||1)});
  }
  return o;
}
function calcOBV(candles){
  const obv=[0];
  for(let i=1;i<candles.length;i++){
    const d=candles[i].c>candles[i-1].c?candles[i].v:candles[i].c<candles[i-1].c?-candles[i].v:0;
    obv.push(obv[i-1]+d);
  }
  return obv;
}

function rsiDiv(rsiArr, closes, lookback=20){
  // Bullish div: price LL, RSI HL over last `lookback` bars
  // Bearish div: price HH, RSI LH
  const n=closes.length-1;
  if(n<lookback) return {bull:false,bear:false};
  let priceLow=closes[n], priceHigh=closes[n], rsiAtPriceLow=rsiArr[n], rsiAtPriceHigh=rsiArr[n];
  let prevPriceLow=closes[n-lookback], prevPriceHigh=closes[n-lookback];
  let prevRsiAtLow=rsiArr[n-lookback], prevRsiAtHigh=rsiArr[n-lookback];
  for(let i=n-lookback+1;i<=n;i++){
    if(closes[i]<priceLow){priceLow=closes[i];rsiAtPriceLow=rsiArr[i];}
    if(closes[i]>priceHigh){priceHigh=closes[i];rsiAtPriceHigh=rsiArr[i];}
  }
  for(let i=n-lookback*2;i<n-lookback;i++){
    if(i<0) continue;
    if(closes[i]<prevPriceLow){prevPriceLow=closes[i];prevRsiAtLow=rsiArr[i];}
    if(closes[i]>prevPriceHigh){prevPriceHigh=closes[i];prevRsiAtHigh=rsiArr[i];}
  }
  const bull = priceLow < prevPriceLow && rsiAtPriceLow > prevRsiAtLow + 2;
  const bear = priceHigh > prevPriceHigh && rsiAtPriceHigh < prevRsiAtHigh - 2;
  return {bull, bear};
}

function candleStruct(candles){
  const N=candles.length-1;
  const c=candles[N], p=candles[N-1];
  const body=Math.abs(c.c-c.o);
  const range=c.h-c.l||0.0001;
  const lowerWick=(Math.min(c.o,c.c)-c.l);
  const upperWick=(c.h-Math.max(c.o,c.c));
  const isBull=c.c>c.o;
  const isBear=c.c<c.o;
  // Hammer: small body, lower wick >= 2x body, upper wick small, appears after downtrend
  const hammer = lowerWick>=body*2 && upperWick<=body*0.5 && body/range<0.4;
  // Shooting star: opposite of hammer
  const shootingStar = upperWick>=body*2 && lowerWick<=body*0.5 && body/range<0.4;
  // Bullish engulfing
  const bullEngulf = isBull && p.c<p.o && c.o<=p.c && c.c>=p.o;
  // Bearish engulfing
  const bearEngulf = isBear && p.c>p.o && c.o>=p.c && c.c<=p.o;
  // Bull pin bar: long lower wick rejection
  const bullPin = lowerWick>range*0.6 && body<range*0.35;
  // Bear pin bar: long upper wick rejection
  const bearPin = upperWick>range*0.6 && body<range*0.35;
  return {hammer, shootingStar, bullEngulf, bearEngulf, bullPin, bearPin,
    bullCandle: hammer||bullEngulf||bullPin,
    bearCandle: shootingStar||bearEngulf||bearPin};
}

function emaBounceLong(candles, e20arr){
  // Last 3 candles: did price touch EMA20 and bounce up?
  const N=candles.length-1;
  for(let i=N-2;i<=N;i++){
    if(i<1) continue;
    const c=candles[i], e=e20arr[i];
    const touched = c.l <= e*1.002;
    const closed  = c.c > e*1.001;
    if(touched && closed) return true;
  }
  return false;
}

function emaBounceShort(candles, e20arr){
  const N=candles.length-1;
  for(let i=N-2;i<=N;i++){
    if(i<1) continue;
    const c=candles[i], e=e20arr[i];
    const touched = c.h >= e*0.998;
    const closed  = c.c < e*0.999;
    if(touched && closed) return true;
  }
  return false;
}

function calcInds(candles){
  if(!candles || candles.length<60) return null;
  const closes = candles.map(c=>c.c);
  const e20=ema(closes,20), e50=ema(closes,50);
  const e200c = closes.length>=200 ? ema(closes,200) : null;
  const r=rsi(closes,14), m=macd(closes), a=atr(candles,14);
  const N=closes.length-1;
  const volAvg = candles.slice(-20).reduce((s,c)=>s+c.v,0)/20;
  const bb=bbands(closes,20), bbL=bb.at(-1);
  const bbW=bb.map(b=>b.width);
  const bbSq = bbL && bbL.width < Math.min(...bbW.slice(-20))*1.05;
  const st=supertrend(candles);
  // OBV
  const obvArr=calcOBV(candles);
  const obvE10=ema(obvArr,10), obvE20=ema(obvArr,20);
  const obvBull = obvE10[N]>obvE20[N];
  // RSI Divergenz
  const rDiv=rsiDiv(r,closes,20);
  // Kerzenstruktur
  const cs=candleStruct(candles);
  // EMA Bounce
  const emaBL=emaBounceLong(candles,e20);
  const emaBS=emaBounceShort(candles,e20);
  // Volume spike on last candle
  const volSpike=candles[N].v > volAvg*1.5;
  return {
    price:closes[N], e20:e20[N], e50:e50[N], e200:e200c?e200c[N]:null,
    rsi:r[N]||50, macdL:m.line[N]||0, macdS:m.signal[N]||0,
    macdH:m.hist[N]||0, macdHP:m.hist[N-1]||0,
    atr:a.at(-1)||0, adx:adx(candles,14),
    volR:candles[N].v/(volAvg||1),
    chg:(closes[N]/closes[0]-1)*100,
    bb:bbL, bbSq, stT:st.trend, stL:st.line,
    obvBull, rsiDivBull:rDiv.bull, rsiDivBear:rDiv.bear,
    cs, emaBL, emaBS, volSpike,
    e20arr:e20  // for limit price calc
  };
}

// ── Signal ─────────────────────────────────────────────────
function calcSig(en, htf, d1, fg, fund, lsr, oi){
  let bull=0, bear=0, rs=[];
  const add=(ic,tx,s)=>{ rs.push({ic,tx,s}); if(s>0)bull++; else if(s<0)bear++; };
  const p=en.price, a=en.atr;

  if(d1){ const ref=d1.e200||d1.e50; d1.price>ref?add('✅','1D Bull — über EMA200',1):add('❌','1D Bear — unter EMA200',-1); }
  else if(en.e200){ p>en.e200?add('✅','Über EMA200 ✓',1):add('❌','Unter EMA200 ✗',-1); }

  if(htf){
    if(htf.adx>20&&htf.e20>htf.e50) add('✅','HTF Trend UP — ADX '+htf.adx.toFixed(0),1);
    else if(htf.adx>20&&htf.e20<htf.e50) add('❌','HTF Trend DOWN — ADX '+htf.adx.toFixed(0),-1);
    else add('➡️','HTF Ranging — ADX '+htf.adx.toFixed(0),0);
  }

  en.e20>en.e50 ? add('✅','EMA20 über EMA50',1) : add('❌','EMA20 unter EMA50',-1);
  en.stT===1 ? add('✅','Supertrend GRÜN — '+fmt(en.stL),1) : add('❌','Supertrend ROT — '+fmt(en.stL),-1);

  if(en.rsi>70) add('⚠️','RSI '+en.rsi.toFixed(0)+' — Überkauft',-1);
  else if(en.rsi<30) add('✅','RSI '+en.rsi.toFixed(0)+' — Überverkauft',1);
  else if(en.rsi>50) add('✅','RSI '+en.rsi.toFixed(0)+' — Bull Zone',1);
  else add('⚠️','RSI '+en.rsi.toFixed(0)+' — Bear Zone',-1);

  // RSI Divergenz
  if(en.rsiDivBull) add('✅','RSI Bullische Divergenz ↗',1);
  if(en.rsiDivBear) add('⚠️','RSI Bärische Divergenz ↘',-1);

  en.macdL>en.macdS ? add('✅','MACD über Signal',1) : add('❌','MACD unter Signal',-1);
  if(en.macdH>en.macdHP&&en.macdH>0) add('✅','MACD Hist steigt',1);
  else if(en.macdH<en.macdHP&&en.macdH>0) add('⚠️','MACD Hist schwächt',-1);
  else if(en.macdH>en.macdHP) add('✅','MACD Hist dreht hoch',1);
  else add('⚠️','MACD Hist fällt',-1);

  // OBV Trend
  en.obvBull ? add('✅','OBV steigt — Kaufdruck',1) : add('❌','OBV fällt — Verkaufsdruck',-1);

  if(en.volR>1.4) add('✅','Volumen '+en.volR.toFixed(1)+'× Ø',1);
  else if(en.volR<0.6) add('⚠️','Volumen schwach',-1);
  else add('➡️','Volumen '+Math.round(en.volR*100)+'% vom Ø',0);

  if(fg){
    if(fg.val>=80) add('🚨','F&G '+fg.val+' — Extreme Gier',-1);
    else if(fg.val<=20) add('✅','F&G '+fg.val+' — Extreme Angst',1);
    else add('➡️','F&G '+fg.val+' — '+fg.label,0);
  }
  if(fund!=null){
    const fp=fund*100;
    fp>0.05?add('⚠️','Funding +'+fp.toFixed(3)+'% überhitzt',-1):fp<-0.01?add('⚠️','Funding '+fp.toFixed(3)+'%',-1):add('✅','Funding normal',1);
  }
  if(lsr){
    const bp=lsr.buy*100;
    bp>65?add('⚠️','L/S '+bp.toFixed(0)+'% Long',-1):bp<40?add('✅','L/S '+bp.toFixed(0)+'% Long',1):add('➡️','L/S ausgewogen',0);
  }
  if(oi){
    oi.change>2?add('✅','OI +'+oi.change.toFixed(1)+'%',1):oi.change<-2?add('⚠️','OI '+oi.change.toFixed(1)+'%',-1):add('➡️','OI stabil',0);
  }

  const tot=bull+bear, r=tot>0?bull/tot:0.5;

  // MTF-Konflikt: Signal gegen höheren Zeitrahmen?
  const htfBull = htf && htf.e20 > htf.e50;
  const htfBear = htf && htf.e20 < htf.e50;
  const d1Bull  = d1 && d1.price > (d1.e200||d1.e50);
  const d1Bear  = d1 && d1.price < (d1.e200||d1.e50);

  // Regime-aware Schwelle: Mit HTF+D1 Bestätigung 65%, ohne 70%
  const htfLongConf  = htfBull && d1Bull;
  const htfShortConf = htfBear && d1Bear;
  const longThresh  = htfLongConf  ? 0.65 : 0.70;
  const shortThresh = htfShortConf ? 0.65 : 0.70;
  const sig = r>=longThresh?'LONG':r<=(1-shortThresh)?'SHORT':'WAIT';

  const mtfConflict = (sig==='LONG'&&(htfBear||d1Bear)) || (sig==='SHORT'&&(htfBull||d1Bull));

  // Signal-Qualität 0–3 Sterne
  const sigN = sig==='LONG'?bull:sig==='SHORT'?bear:0;
  const quality = sig==='WAIT'?0 : mtfConflict?1 : sigN>=6?3 : sigN>=4?2 : 1;

  // ── Einstiegs-Timing + präzise Trigger ─────────────────────
  let entryType='NOW', entryHint='', entryTrigger='', entryInvalid='';
  let limitPrice=null, limitNote='';
  const cs=en.cs||{};
  const volOK = en.volR>1.2 || en.volSpike;

  // Kerzenstruktur-Bestätigung
  const candleConfirmLong  = cs.hammer||cs.bullEngulf||cs.bullPin;
  const candleConfirmShort = cs.shootingStar||cs.bearEngulf||cs.bearPin;
  const candleName = cs.hammer?'Hammer':cs.bullEngulf?'Bullisches Engulfing':cs.bullPin?'Bull Pin Bar':
                     cs.shootingStar?'Shooting Star':cs.bearEngulf?'Bärisches Engulfing':cs.bearPin?'Bear Pin Bar':'';

  if(en.bbSq){
    entryType='SQUEEZE';
    entryHint='BB Squeeze aktiv — auf Ausbruchskerze warten';
    if(sig==='LONG'){
      limitPrice=en.bb?en.bb.upper:null;
      entryTrigger='Limit Buy bei '+fmt(limitPrice||p)+' (BB Oberes Band) — Vol-Bestätigung nötig';
    } else if(sig==='SHORT'){
      limitPrice=en.bb?en.bb.lower:null;
      entryTrigger='Limit Short bei '+fmt(limitPrice||p)+' (BB Unteres Band) — Vol-Bestätigung nötig';
    }
    entryInvalid='Ungültig: Kerze schließt zurück innerhalb der Bänder';

  } else if(sig==='LONG' && p > en.e20*1.003){
    if(en.stT===1){ // Supertrend grün → Momentum-Einstieg erlaubt
      entryType='TREND';
      limitPrice=+(p*1.0005).toFixed(6);
      entryHint='Trend LONG — Preis '+((p/en.e20-1)*100).toFixed(1)+'% über EMA20 · Supertrend ✅'+(volOK?' · Vol ✓':'');
      entryTrigger='Market Buy bei ~'+fmt(limitPrice)+' | SL: '+fmt(en.stL>p-2*a?en.stL:p-2*a);
      entryInvalid='Ungültig: Supertrend dreht rot';
    } else {
      entryType='PULLBACK'; // kein Supertrend → warten
      limitPrice=+(en.e20*1.001).toFixed(6);
      entryHint='Preis '+((p/en.e20-1)*100).toFixed(1)+'% über EMA20 — Rücksetzer abwarten';
      entryTrigger='Limit Buy bei '+fmt(limitPrice)+' (EMA20+0.1%) — warten auf grüne Bestätigungskerze';
      entryInvalid='Ungültig: Schlusskurs unter EMA50 ('+fmt(en.e50)+')';
    }

  } else if(sig==='SHORT' && p < en.e20*0.997){
    if(en.stT===-1){ // Supertrend rot → Momentum-Einstieg erlaubt
      entryType='TREND';
      limitPrice=+(p*0.9995).toFixed(6);
      entryHint='Trend SHORT — Preis '+((1-p/en.e20)*100).toFixed(1)+'% unter EMA20 · Supertrend ✅'+(volOK?' · Vol ✓':'');
      entryTrigger='Market Short bei ~'+fmt(limitPrice)+' | SL: '+fmt(en.stL<p+2*a?en.stL:p+2*a);
      entryInvalid='Ungültig: Supertrend dreht grün';
    } else {
      entryType='PULLBACK'; // kein Supertrend → warten
      limitPrice=+(en.e20*0.999).toFixed(6);
      entryHint='Preis '+((1-p/en.e20)*100).toFixed(1)+'% unter EMA20 — Rally abwarten';
      entryTrigger='Limit Short bei '+fmt(limitPrice)+' (EMA20-0.1%) — warten auf rote Bestätigungskerze';
      entryInvalid='Ungültig: Schlusskurs über EMA50 ('+fmt(en.e50)+')';
    }

  } else if(sig==='LONG' && en.emaBL){
    entryType='BOUNCE';
    limitPrice=+(p*1.0005).toFixed(6);
    entryHint='EMA20-Bounce bestätigt'+(candleConfirmLong?' + '+candleName:'');
    entryTrigger='Market/Limit Buy bei '+fmt(limitPrice)+(volOK?' — Vol ✓':' — Vol schwach ⚠')+' | SL: '+fmt(p-2*a);
    entryInvalid='Ungültig: Kerze unter EMA20 ('+fmt(en.e20)+') schließt';

  } else if(sig==='SHORT' && en.emaBS){
    entryType='BOUNCE';
    limitPrice=+(p*0.9995).toFixed(6);
    entryHint='EMA20-Rejection bestätigt'+(candleConfirmShort?' + '+candleName:'');
    entryTrigger='Market/Limit Short bei '+fmt(limitPrice)+(volOK?' — Vol ✓':' — Vol schwach ⚠')+' | SL: '+fmt(p+2*a);
    entryInvalid='Ungültig: Kerze über EMA20 ('+fmt(en.e20)+') schließt';

  } else if(sig==='LONG' && candleConfirmLong){
    entryType='CANDLE';
    limitPrice=+(p*1.001).toFixed(6);
    entryHint=candleName+' erkannt'+(volOK?' + Vol-Bestätigung':'');
    entryTrigger='Limit Buy bei '+fmt(limitPrice)+' | SL: '+fmt(p-2*a)+(en.rsiDivBull?' | RSI-Div ✅':'');
    entryInvalid='Ungültig: Nächste Kerze schließt unter '+fmt(Math.min(en.e20,p-a));

  } else if(sig==='SHORT' && candleConfirmShort){
    entryType='CANDLE';
    limitPrice=+(p*0.999).toFixed(6);
    entryHint=candleName+' erkannt'+(volOK?' + Vol-Bestätigung':'');
    entryTrigger='Limit Short bei '+fmt(limitPrice)+' | SL: '+fmt(p+2*a)+(en.rsiDivBear?' | RSI-Div ✅':'');
    entryInvalid='Ungültig: Nächste Kerze schließt über '+fmt(Math.max(en.e20,p+a));

  } else if(en.stT===1 && sig==='LONG'){
    entryType='TREND';
    limitPrice=+(p*1.0005).toFixed(6);
    entryHint='Supertrend grün ✓ — Momentum LONG'+(volOK?' | Vol ✓':'');
    entryTrigger='Market Buy bei ~'+fmt(limitPrice)+' | SL: '+fmt(Math.min(en.stL,p-2*a))+(en.rsiDivBull?' | RSI-Div ✅':'');
    entryInvalid='Ungültig: Supertrend dreht rot oder Preis unter '+fmt(en.stL);

  } else if(en.stT===-1 && sig==='SHORT'){
    entryType='TREND';
    limitPrice=+(p*0.9995).toFixed(6);
    entryHint='Supertrend rot ✓ — Momentum SHORT'+(volOK?' | Vol ✓':'');
    entryTrigger='Market Short bei ~'+fmt(limitPrice)+' | SL: '+fmt(Math.max(en.stL,p+2*a))+(en.rsiDivBear?' | RSI-Div ✅':'');
    entryInvalid='Ungültig: Supertrend dreht grün oder Preis über '+fmt(en.stL);

  } else {
    limitPrice=p;
    entryHint=sig==='WAIT'?'Kein klares Setup — warten':'Einstieg bei Marktpreis';
    entryTrigger=sig==='LONG'?'Buy bei '+fmt(p)+' | SL: '+fmt(p-2*a):sig==='SHORT'?'Short bei '+fmt(p)+' | SL: '+fmt(p+2*a):'';
    entryInvalid='';
  }

  // Stärkste Gründe für/gegen das Signal
  const topR   = rs.filter(x=>sig==='LONG'?x.s>0:sig==='SHORT'?x.s<0:false).slice(0,3).map(x=>x.tx);
  const againR = rs.filter(x=>sig==='LONG'?x.s<0:sig==='SHORT'?x.s>0:false).slice(0,2).map(x=>x.tx);

  const sl  = sig==='SHORT' ? p+2.0*a : p-2.0*a;
  const tp1 = sig==='SHORT' ? p-2.0*a : p+2.0*a;
  const tp2 = sig==='SHORT' ? p-4.0*a : p+4.0*a;
  const rrr = Math.abs(tp2-p)/Math.abs(sl-p)||0;
  return {sig, bull, bear, max:tot, pct:r, rs,
    sl, tp1, tp2, rrr,
    slP:(sl-p)/p*100, tp1P:(tp1-p)/p*100, tp2P:(tp2-p)/p*100,
    quality, mtfConflict, entryType, entryHint, entryTrigger, entryInvalid,
    limitPrice, candleConfirmLong, candleConfirmShort, candleName,
    topR, againR};
}


function lohnScore(inds, res){
  // Composite "Lohnt sich" score 0-100
  let s = 0;
  // Signal quality (0-3 stars) → up to 30pts
  s += (res.quality||0) * 10;
  // Signal strength % → up to 20pts
  const sigPct = res.sig==='LONG' ? res.bull/Math.max(res.max,1) : res.sig==='SHORT' ? res.bear/Math.max(res.max,1) : 0;
  s += Math.round(sigPct * 20);
  // Entry type: CANDLE/BOUNCE/SQUEEZE sind starke strukturierte Setups
  const eBonus = {NOW:10, BOUNCE:15, CANDLE:14, PULLBACK:8, SQUEEZE:14};
  s += eBonus[res.entryType]||0;
  // RRR (skaliert)
  if(res.rrr>=3.5) s+=14; else if(res.rrr>=2.5) s+=10; else if(res.rrr>=2) s+=7; else if(res.rrr>=1.5) s+=4;
  // No MTF conflict
  if(!res.mtfConflict) s+=8;
  // ADX Trendstärke (skaliert – starke Trends = mehr Verlässlichkeit)
  if(inds.adx>40) s+=14; else if(inds.adx>30) s+=10; else if(inds.adx>25) s+=6;
  // Entry confirmations
  if(inds.obvBull && res.sig==='LONG')  s+=5;
  if(!inds.obvBull && res.sig==='SHORT') s+=5;
  if(inds.rsiDivBull && res.sig==='LONG')  s+=6;
  if(inds.rsiDivBear && res.sig==='SHORT') s+=6;
  if(inds.emaBL && res.sig==='LONG')  s+=6;
  if(inds.emaBS && res.sig==='SHORT') s+=6;
  const cs=inds.cs||{};
  if((cs.hammer||cs.bullEngulf||cs.bullPin)   && res.sig==='LONG')  s+=5;
  if((cs.shootingStar||cs.bearEngulf||cs.bearPin) && res.sig==='SHORT') s+=5;
  if(inds.volSpike) s+=5;
  // BB-Position: Einstieg nahe an der Bandkante = besseres R/R
  if(inds.bb){
    if(res.sig==='LONG'  && inds.price<=inds.bb.lower*1.006) s+=5;
    if(res.sig==='SHORT' && inds.price>=inds.bb.upper*0.994) s+=5;
  }
  // RSI in gesunder Zone für die Richtung (nicht überhitzt)
  if(res.sig==='LONG'  && inds.rsi>=38 && inds.rsi<=65) s+=3;
  if(res.sig==='SHORT' && inds.rsi>=35 && inds.rsi<=62) s+=3;
  // ── Markt-Regime Bonus: Signal mit globalem Trend = Tailwind ─
  const reg=(typeof _marketRegime!=='undefined')?_marketRegime:{bias:'neutral'};
  if(reg.bias==='bearish'&&res.sig==='SHORT') s+=10; // bearisher Markt + SHORT
  if(reg.bias==='bullish'&&res.sig==='LONG')  s+=10; // bullisher Markt + LONG
  if(reg.bias==='weak'   &&res.sig==='SHORT') s+=5;
  if(reg.bias==='strong' &&res.sig==='LONG')  s+=5;
  if(reg.bias==='bearish'&&res.sig==='LONG')  s-=8;  // Headwind: long im Bären
  if(reg.bias==='bullish'&&res.sig==='SHORT') s-=8;  // Headwind: short im Bullen
  return Math.min(Math.max(s,0), 100);
}


// ═══ RUNNER ═══════════════════════════════════════════════════════

const OKX='https://www.okx.com';
const H=3600000;

async function okxK(sym,bar,limit){
  const inst=sym.replace('USDT','-USDT-SWAP');
  const r=await fetch(OKX+'/api/v5/market/candles?instId='+inst+'&bar='+bar+'&limit='+(limit||120),
    {headers:{'User-Agent':'cloud-bot/1.0'}});
  const d=await r.json();
  if(d.code!=='0'||!d.data||!d.data.length) return null;
  return [...d.data].reverse().map(c=>({ts:+c[0],o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}));
}
// Nur ABGESCHLOSSENE Kerzen (laufende Bar am Ende droppen)
function closedOnly(arr,barMs){ if(!arr)return null; const now=Date.now();
  return arr.filter(b=>b.ts+barMs<=now); }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadState(){
  try{ return JSON.parse(FS.readFileSync('state.json','utf8')); }
  catch(e){ return {bal:P.initBal,peak:P.initBal,positions:[],trades:[],cd:{},started:new Date().toISOString(),runs:0}; }
}

function stats(st,prices){
  const locked=st.positions.reduce((a,p)=>a+p.margin,0);
  const unreal=st.positions.reduce((a,p)=>{const lp=(prices&&prices[p.sym])||p.price;
    return a+(p.side==='LONG'?(lp-p.price):(p.price-lp))*p.size;},0);
  const equity=st.bal+locked+unreal;
  const w=st.trades.filter(t=>t.pnl>0);
  return {locked,unreal,equity,n:st.trades.length,wins:w.length,
    wr:st.trades.length?w.length/st.trades.length*100:0,
    pnl:equity-P.initBal, pct:(equity-P.initBal)/P.initBal*100};
}

async function main(){
  const st=loadState(); st.runs=(st.runs||0)+1;
  const log=[];
  // ── BTC-Kontext ──
  const btcAll=closedOnly(await okxK('BTCUSDT','1H',120),H);
  if(!btcAll||btcAll.length<30){ console.log('BTC-Daten fehlen — Lauf übersprungen'); return; }
  const bi=btcAll.length-1;
  const chg24=(btcAll[bi].c/btcAll[Math.max(0,bi-24)].c-1)*100;
  const mom1h=(btcAll[bi].c/btcAll[bi].o-1)*100;
  _marketRegime.bias=chg24<=-1.5?'bearish':chg24<=-0.5?'weak':chg24>=1.5?'bullish':chg24>=0.5?'strong':'neutral';
  _marketRegime.btcChg=+chg24.toFixed(2);
  log.push('Regime: '+_marketRegime.bias+' (BTC 24h '+chg24.toFixed(1)+'% · 1h '+mom1h.toFixed(2)+'%)');

  const prices={};
  // ── Pro Symbol: Daten + Exits + Entry-Kandidat ──
  const candidates=[];
  for(const sym of SYMS){
    await sleep(150);
    let h1;
    try{ h1=closedOnly(await okxK(sym,'1H',120),H); }catch(e){ h1=null; }
    if(!h1||h1.length<80) continue;
    prices[sym]=h1[h1.length-1].c;

    // Exits: alle neuen abgeschlossenen Bars seit letztem Check
    const pos=st.positions.find(p=>p.sym===sym);
    if(pos){
      const newBars=h1.filter(b=>b.ts>(pos.lastCheck||pos.ts));
      for(const bar of newBars){
        let exit=null,reason='';
        if(pos.side==='LONG'){ if(bar.l<=pos.sl){exit=pos.sl*(1-P.slipPct/100);reason='SL';}
          else if(bar.h>=pos.tp){exit=pos.tp;reason='TP';} }
        else { if(bar.h>=pos.sl){exit=pos.sl*(1+P.slipPct/100);reason='SL';}
          else if(bar.l<=pos.tp){exit=pos.tp;reason='TP';} }
        if(exit!=null){
          const diff=pos.side==='LONG'?exit-pos.price:pos.price-exit;
          const pnl=diff*pos.size-exit*pos.size*P.feeRate-pos.eFee;
          st.bal+=pos.margin+pnl+pos.eFee;
          st.trades.push({ts:bar.ts,sym,side:pos.side,entry:pos.price,exit:+exit.toPrecision(8),
            pnl:+pnl.toFixed(2),reason,entryType:pos.entryType,score:pos.score});
          if(reason==='SL') st.cd[sym]=bar.ts;
          st.positions=st.positions.filter(p=>p.sym!==sym);
          log.push((pnl>=0?'✅ ':'❌ ')+pos.side+' '+sym+' '+reason+' '+(pnl>=0?'+':'')+pnl.toFixed(2)+'$');
          break;
        }
        pos.lastCheck=bar.ts;
      }
    }

    // Entry-Kandidat?
    if(st.positions.length>=P.maxPositions) continue;
    if(st.positions.find(p=>p.sym===sym)) continue;
    if(st.cd[sym]&&Date.now()-st.cd[sym]<P.cooldownMin*60000) continue;
    try{
      const inds=calcInds(h1.slice(-200));
      if(!inds||!inds.atr||inds.atr<=0) continue;
      if(inds.atr/inds.price<0.0008) continue;
      if(inds.adx<16) continue;
      await sleep(150);
      const h4=closedOnly(await okxK(sym,'4H',120),4*H);
      if(!h4||h4.length<60) continue;
      const htf=calcInds(h4);
      if(!htf) continue;
      const res=calcSig(inds,htf,null,null,null,null,null);
      if(!res||res.sig==='WAIT') continue;
      if(!P.entryTypes.includes(res.entryType)) continue;
      if(res.sig==='LONG'  && !(htf.e20>htf.e50)) continue;
      if(res.sig==='SHORT' && !(htf.e20<htf.e50)) continue;
      if(res.sig==='LONG'  && _marketRegime.bias==='bearish') continue;
      if(res.sig==='SHORT' && _marketRegime.bias==='bullish') continue;
      if(res.sig==='LONG'  && mom1h<=-0.4) continue;
      if(res.sig==='SHORT' && mom1h>= 0.4) continue;
      if(res.sig==='LONG'  && inds.rsi>78) continue;
      if(res.sig==='SHORT' && inds.rsi<22) continue;
      const score=lohnScore(inds,res);
      if(score<P.minScore) continue;
      candidates.push({sym,sig:res.sig,entryType:res.entryType,score,price:inds.price,atr:inds.atr});
    }catch(e){}
  }

  // ── Entries (beste Scores zuerst) ──
  candidates.sort((a,b)=>b.score-a.score);
  for(const c of candidates){
    if(st.positions.length>=P.maxPositions) break;
    const locked=st.positions.reduce((a,p)=>a+p.margin,0);
    const eq=st.bal+locked;
    if(eq<=0||locked/eq*100>=P.maxHeatPct) break;
    const price=c.sig==='LONG'?c.price*(1+P.slipPct/100):c.price*(1-P.slipPct/100);
    const slDist=Math.max(P.slMult*c.atr, price*P.minSlPct/100);
    if(2*P.feeRate*price/slDist>0.25) continue;
    const sl=c.sig==='LONG'?price-slDist:price+slDist;
    const tp=c.sig==='LONG'?price+2*slDist:price-2*slDist;
    let size=(st.bal*P.riskPct/100)/slDist, margin=size*price/P.leverage;
    const cap=eq*P.maxMarginPct/100;
    if(margin>cap){size*=cap/margin;margin=cap;}
    const eFee=size*price*P.feeRate;
    if(margin+eFee>st.bal||margin<1) continue;
    st.bal-=margin+eFee;
    st.positions.push({sym:c.sym,side:c.sig,price,sl,tp,size,margin,eFee,
      entryType:c.entryType,score:c.score,ts:Date.now(),lastCheck:Date.now()});
    log.push('⚡ OPEN '+c.sig+' '+c.sym+' @'+price.toPrecision(6)+' ['+c.entryType+' '+c.score+']');
  }

  // ── Peak/Report/State ──
  const s=stats(st,prices);
  if(s.equity>st.peak) st.peak=s.equity;
  FS.writeFileSync('state.json',JSON.stringify(st,null,1));

  const recent=[...st.trades].slice(-15).reverse();
  const lines=[];
  lines.push('# Cloud-Bot v6 — Live-Report');
  lines.push('');
  lines.push('> Aktualisiert: '+new Date().toISOString().replace('T',' ').slice(0,16)+' UTC · Lauf #'+st.runs+' · gestartet '+String(st.started).slice(0,10));
  lines.push('');
  lines.push('| Equity | PnL | Winrate | Trades | Offen | Drawdown | Regime |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push('| $'+s.equity.toFixed(2)+' | '+(s.pnl>=0?'+':'')+s.pnl.toFixed(2)+'$ ('+(s.pct>=0?'+':'')+s.pct.toFixed(1)+'%) | '+s.wr.toFixed(0)+'% | '+s.n+' | '+st.positions.length+' | '+(st.peak>0?((st.peak-s.equity)/st.peak*100).toFixed(1):'0')+'% | '+_marketRegime.bias+' |');
  lines.push('');
  if(st.positions.length){
    lines.push('## Offene Positionen');
    lines.push('');
    lines.push('| Pair | Seite | Entry | SL | TP | Typ | Score |');
    lines.push('|---|---|---|---|---|---|---|');
    st.positions.forEach(p=>lines.push('| '+p.sym.replace('USDT','')+' | '+p.side+' | '+p.price.toPrecision(6)+' | '+p.sl.toPrecision(6)+' | '+p.tp.toPrecision(6)+' | '+p.entryType+' | '+p.score+' |'));
    lines.push('');
  }
  if(recent.length){
    lines.push('## Letzte Trades');
    lines.push('');
    lines.push('| Zeit (UTC) | Pair | Seite | PnL | Grund | Typ |');
    lines.push('|---|---|---|---|---|---|');
    recent.forEach(t=>lines.push('| '+new Date(t.ts).toISOString().slice(5,16).replace('T',' ')+' | '+t.sym.replace('USDT','')+' | '+t.side+' | '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'$ | '+t.reason+' | '+t.entryType+' |'));
    lines.push('');
  }
  if(log.length){ lines.push('## Dieser Lauf'); lines.push(''); log.forEach(m=>lines.push('- '+m)); lines.push(''); }
  FS.writeFileSync('REPORT.md',lines.join('\n'));
  console.log(log.join('\n')||'(keine Aktionen)');
  console.log('Equity $'+s.equity.toFixed(2)+' · '+s.n+' Trades · WR '+s.wr.toFixed(0)+'%');
}

// ── Selbsttest mit synthetischen Kerzen (kein Netz nötig) ──
function selftest(){
  const arr=[];let p=100;
  for(let i=0;i<300;i++){const drift=Math.sin(i/20)*0.6+0.05;const o=p;p=p*(1+drift/100+(Math.random()-0.5)*0.004);
    arr.push({ts:i*3600000,o,h:Math.max(o,p)*1.003,l:Math.min(o,p)*0.997,c:p,v:1000+Math.random()*500});}
  const inds=calcInds(arr.slice(-200));
  if(!inds) throw new Error('calcInds null');
  const htf=calcInds(arr.slice(-240).filter((_,i)=>i%4===0));
  const res=calcSig(inds,htf,null,null,null,null,null);
  const score=lohnScore(inds,res);
  console.log('SELFTEST OK — sig:'+res.sig+' type:'+res.entryType+' score:'+score+' atr:'+inds.atr.toFixed(4)+' adx:'+inds.adx.toFixed(1));
}

if(process.argv.includes('--selftest')) selftest();
else main().catch(e=>{console.error('FEHLER:',e.message);process.exit(1);});
