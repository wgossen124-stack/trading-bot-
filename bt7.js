// ═══════════════════════════════════════════════════════════════════
// BT7 — Walk-Forward für Bot 1 (Donchian-Breakout 6h, bot2.js)
//
// Nachgeholt am 26.10.2026. Bot 1 gilt im Vault als "der einzige Bot mit
// Evidenz", wurde aber nur auf 3 Paaren über 218 Tage geprüft. Bot 2 und 3
// mussten 10 Paare über 2 Jahre überstehen und sind daran gescheitert.
// Dieser Lauf legt denselben Maßstab an.
//
// REGEL — VOR dem Lauf festgelegt, wortgleich zu BOT34-KRITERIEN.md/bt6.js:
//   Parameter im ersten Datenteil wählen, im zweiten UNVERÄNDERT testen.
//   Bestanden = OOS-Rendite > 0 UND >= 6/10 Paare positiv UND MaxDD < 30 %
//   — in BEIDEN Schnitten (50/50 und 70/30).
//
// Aufruf:  node bt7.js            (Daten laden + rechnen)
//          node bt7.js --cache    (zuvor geladene Daten aus bt7-data.json)
// ═══════════════════════════════════════════════════════════════════

const FS = require('fs');

// Dieselben 10 Paare wie bt6.js — sonst ist es nicht derselbe Maßstab.
const PAIRS = ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'];

const BAR_MS = 6 * 3600000;
const NEED    = 3200;        // ~2 Jahre 6h-Bars (2920) + Warmlauf
const WARMUP  = 205;         // EMA200 + Reserve

// Feste Einstellungen aus bot2.js — nicht Teil des Gitters.
const FIX = {
  initBal:2000, riskPct:1.0, leverage:3,
  maxPositions:8, maxSameSide:3, maxHeatPct:40, marginCapPct:12,
  feeRate:0.0005, slipPct:0.02, cooldownBars:2,
  chandAtr:3.0,                // seit 22.08.2026 live, ungetestet
  // timeoutBars gibt es seit dem 24.08.2026 nicht mehr (bewusst entfernt).
};

// ── Das Gitter. Steht fest, bevor irgendeine Zahl gerechnet wurde. ──
const GRID = [];
for (const nEntry of [20, 30, 40])
  for (const nExit of [10, 20])
    for (const slMult of [2.0, 3.0])
      GRID.push({ nEntry, nExit, slMult });

const LIVE = { nEntry:30, nExit:10, slMult:2.0 };   // was gerade wirklich läuft
const tag = P => `N${P.nEntry}/${P.nExit} SL${P.slMult}`;

// ── Daten ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPair(sym) {
  const inst = sym + '-USDT-SWAP';
  const r0 = await (await fetch(
    `https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=6H&limit=300`)).json();
  if (r0.code !== '0' || !r0.data) throw new Error(sym + ': ' + (r0.msg || 'keine Daten'));
  let all = r0.data.map(c => ({ ts:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4] }));
  let guard = 0;
  while (all.length < NEED && guard++ < 60) {
    const oldest = all[all.length - 1].ts;
    await sleep(120);
    const r = await (await fetch(
      `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=6H&after=${oldest}&limit=100`)).json();
    if (r.code !== '0' || !r.data || !r.data.length) break;
    all = all.concat(r.data.map(c => ({ ts:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4] })));
  }
  all.sort((a, b) => a.ts - b.ts);
  const now = Date.now();
  return all.filter(b => b.ts + BAR_MS <= now);   // nur abgeschlossene Kerzen
}

// ── Indikatoren, identisch zu bot2.js ────────────────────────────────
function emaSeries(vals, n) {
  const k = 2 / (n + 1); let e = vals[0];
  return vals.map(v => (e = v * k + e * (1 - k)));
}
function atrSeries(c, n = 14) {
  // Index i des Ergebnisses gehört zur Kerze i (ab i>=n), davor null.
  const out = new Array(c.length).fill(null);
  if (c.length < n + 1) return out;
  const tr = c.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - c[i].c), Math.abs(x.l - c[i].c)));
  let a = tr.slice(0, n).reduce((x, y) => x + y) / n;
  out[n] = a;
  for (let i = n; i < tr.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i + 1] = a; }
  return out;
}

// ── Simulation ───────────────────────────────────────────────────────
// data: {SYM: [bars]}, tradeFrom: ab diesem ts darf gehandelt werden.
// Alles davor ist reiner Warmlauf für EMA200/ATR/Donchian — kein Blick in
// die Zukunft, sondern genau das, was der Bot live auch zur Verfügung hat.
function runDonchian(data, P, tradeFrom) {
  const syms = PAIRS.filter(s => data[s] && data[s].length > WARMUP + 10);
  const pre = {};
  for (const s of syms) {
    const k = data[s];
    pre[s] = { k, ema: emaSeries(k.map(x => x.c), 200), atr: atrSeries(k, 14),
               idx: new Map(k.map((b, i) => [b.ts, i])) };
  }
  const axis = [...new Set(syms.flatMap(s => data[s].map(b => b.ts)))].sort((a, b) => a - b);

  let bal = FIX.initBal, peak = FIX.initBal, maxdd = 0;
  let open = [], trades = [], bySym = {}, cd = {}, pending = [];

  for (const ts of axis) {
    // ── 1. Ausstiege prüfen ──────────────────────────────────────────
    // Stop wird aus Bars BIS EINSCHLIESSLICH der VORIGEN Kerze nachgezogen,
    // erst dann wird das Tief/Hoch der aktuellen geprüft. bot2.js zieht den
    // Chandelier mit dem Hoch DERSELBEN Kerze nach und testet dann ihr Tief —
    // das kann nur schmeicheln. Hier bewusst die strengere Reihenfolge.
    for (const pos of [...open]) {
      const p = pre[pos.sym]; if (!p) continue;
      const i = p.idx.get(ts); if (i == null) continue;
      const bar = p.k[i];

      // Turtle-Kanal aus den letzten nExit abgeschlossenen Bars davor
      const from = Math.max(0, i - P.nExit);
      const prev = p.k.slice(from, i);
      if (prev.length) {
        const tstop = pos.side === 'LONG'
          ? Math.min(...prev.map(x => x.l)) : Math.max(...prev.map(x => x.h));
        pos.sl = pos.side === 'LONG' ? Math.max(pos.sl, tstop) : Math.min(pos.sl, tstop);
      }
      // Chandelier aus dem Extrem seit Einstieg, Stand vorige Kerze
      const aPrev = p.atr[i - 1];
      if (aPrev > 0) {
        const ch = pos.side === 'LONG'
          ? pos.hh - FIX.chandAtr * aPrev : pos.ll + FIX.chandAtr * aPrev;
        pos.sl = pos.side === 'LONG' ? Math.max(pos.sl, ch) : Math.min(pos.sl, ch);
      }

      const hit = pos.side === 'LONG' ? bar.l <= pos.sl : bar.h >= pos.sl;
      if (hit) {
        const exit = pos.side === 'LONG'
          ? pos.sl * (1 - FIX.slipPct / 100) : pos.sl * (1 + FIX.slipPct / 100);
        const diff = pos.side === 'LONG' ? exit - pos.price : pos.price - exit;
        const pnl = diff * pos.size - exit * pos.size * FIX.feeRate - pos.eFee;
        bal += pos.margin + pnl + pos.eFee;
        trades.push({ ts, sym: pos.sym, pnl });
        bySym[pos.sym] = (bySym[pos.sym] || 0) + pnl;
        cd[pos.sym] = ts;
        open = open.filter(x => x !== pos);
        continue;
      }
      // Extrem seit Einstieg fortschreiben (für die nächste Kerze)
      pos.hh = Math.max(pos.hh, bar.h);
      pos.ll = Math.min(pos.ll, bar.l);
    }

    // ── 2. Aufgelaufene Signale der Vorkerze eröffnen ────────────────
    // Fill zur Eröffnung der Folgekerze. Live füllt bot2.js zum Live-Kurs bis
    // 4 h nach Kerzenschluss — das liegt mitten in dieser Kerze. Der Schluss
    // der Ausbruchskerze selbst wäre der schmeichelhaftere Preis.
    if (pending.length) {
      pending.sort((a, b) => b.strength - a.strength);
      for (const c of pending) {
        if (open.length >= FIX.maxPositions) break;
        if (open.filter(p => p.side === c.sig).length >= FIX.maxSameSide) continue;
        if (open.some(p => p.sym === c.sym)) continue;
        const p = pre[c.sym]; const i = p.idx.get(ts); if (i == null) continue;
        const locked = open.reduce((a, x) => a + x.margin, 0);
        const eq = bal + locked;
        if (eq <= 0 || locked / eq * 100 >= FIX.maxHeatPct) break;

        const base = p.k[i].o;
        // Drift-Guard wie live: mehr als 1×ATR seit dem Signal → vorbei.
        if (Math.abs(base - c.price) / c.atr > 1.0) continue;
        const price = c.sig === 'LONG'
          ? base * (1 + FIX.slipPct / 100) : base * (1 - FIX.slipPct / 100);
        const slDist = P.slMult * c.atr;
        if (slDist <= 0) continue;
        const sl = c.sig === 'LONG' ? price - slDist : price + slDist;
        let size = (bal * FIX.riskPct / 100) / slDist;
        let margin = size * price / FIX.leverage;
        const cap = eq * FIX.marginCapPct / 100;
        if (margin > cap) { size *= cap / margin; margin = cap; }
        const eFee = size * price * FIX.feeRate;
        if (margin + eFee > bal || margin < 1) continue;
        bal -= margin + eFee;
        open.push({ sym:c.sym, side:c.sig, price, sl, size, margin, eFee, hh:price, ll:price });
      }
      pending = [];
    }

    // ── 3. Neue Signale auf dieser (abgeschlossenen) Kerze sammeln ───
    if (ts >= tradeFrom) {
      for (const s of syms) {
        const p = pre[s]; const i = p.idx.get(ts);
        if (i == null || i < Math.max(P.nEntry + 2, WARMUP)) continue;
        if (open.some(x => x.sym === s)) continue;
        if (cd[s] && ts - cd[s] < FIX.cooldownBars * BAR_MS) continue;
        const a = p.atr[i]; if (!(a > 0)) continue;
        const bar = p.k[i], e200 = p.ema[i];
        const win = p.k.slice(i - P.nEntry, i);
        const hh = Math.max(...win.map(x => x.h)), ll = Math.min(...win.map(x => x.l));
        let sig = null;
        if (bar.c > hh && bar.c > e200) sig = 'LONG';
        else if (bar.c < ll && bar.c < e200) sig = 'SHORT';
        if (!sig) continue;
        const strength = (sig === 'LONG' ? bar.c - hh : ll - bar.c) / a;
        pending.push({ sym:s, sig, price:bar.c, atr:a, strength });
      }
    }

    // ── 4. Equity inkl. unrealisiert, für den Drawdown ──────────────
    let float = 0;
    for (const pos of open) {
      const p = pre[pos.sym]; const i = p.idx.get(ts); if (i == null) continue;
      const px = p.k[i].c;
      float += (pos.side === 'LONG' ? px - pos.price : pos.price - px) * pos.size;
    }
    const locked = open.reduce((a, x) => a + x.margin, 0);
    const cur = bal + locked + float;
    if (cur > peak) peak = cur;
    if (peak > 0) maxdd = Math.max(maxdd, (peak - cur) / peak * 100);
  }

  // Offene Positionen zum letzten Kurs glattstellen
  for (const pos of open) {
    const p = pre[pos.sym]; const last = p.k[p.k.length - 1].c;
    const diff = pos.side === 'LONG' ? last - pos.price : pos.price - last;
    const pnl = diff * pos.size - last * pos.size * FIX.feeRate - pos.eFee;
    bal += pos.margin + pnl + pos.eFee;
    trades.push({ ts: null, sym: pos.sym, pnl });
    bySym[pos.sym] = (bySym[pos.sym] || 0) + pnl;
  }

  const win = trades.filter(t => t.pnl > 0);
  const gw = win.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    pnl: +((bal - FIX.initBal) / FIX.initBal * 100).toFixed(1),
    n: trades.length,
    wr: trades.length ? +(win.length / trades.length * 100).toFixed(0) : 0,
    pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0),
    dd: +maxdd.toFixed(1),
    symPos: Object.values(bySym).filter(v => v > 0).length,
    symAll: syms.length,
  };
}

// ── Walk-Forward ─────────────────────────────────────────────────────
function cutAt(data, frac) {
  const all = [...new Set(PAIRS.flatMap(s => data[s] ? data[s].map(b => b.ts) : []))].sort((a, b) => a - b);
  return { cut: all[Math.floor(all.length * frac)], first: all[0], last: all[all.length - 1] };
}
function sliceTo(data, to) {
  const o = {}; for (const s of PAIRS) o[s] = data[s] ? data[s].filter(b => b.ts < to) : null;
  return o;
}

function walkForward(data, frac) {
  const { cut, first } = cutAt(data, frac);
  // IS: nur Daten bis zum Schnitt, Handel ab Ende des Warmlaufs.
  const IS = sliceTo(data, cut);
  const isFrom = (IS[PAIRS[0]] || [])[WARMUP]?.ts ?? first;
  let best = null;
  const alle = [];
  for (const P of GRID) {
    const r = runDonchian(IS, P, isFrom);
    alle.push({ p: tag(P), pnl: r.pnl, paare: `${r.symPos}/${r.symAll}` });
    if (!best || r.pnl > best.r.pnl) best = { P, r };
  }
  // OOS: volle Historie als Warmlauf, gehandelt wird erst ab dem Schnitt.
  const oos = runDonchian(data, best.P, cut);
  return {
    schnitt: `${Math.round(frac * 100)}/${Math.round((1 - frac) * 100)}`,
    cut: new Date(cut).toISOString().slice(0, 10),
    gewaehlt: tag(best.P),
    IS: { pnl: best.r.pnl + '%', dd: best.r.dd + '%', paare: `${best.r.symPos}/${best.r.symAll}` },
    OOS: { pnl: oos.pnl + '%', pf: oos.pf, dd: oos.dd + '%', n: oos.n, wr: oos.wr + '%',
           paare: `${oos.symPos}/${oos.symAll}` },
    bestanden: oos.pnl > 0 && oos.symPos >= 6 && oos.dd < 30,
    gitter_IS: alle.sort((a, b) => b.pnl - a.pnl),
  };
}

function liveOOS(data, frac) {
  const { cut } = cutAt(data, frac);
  const r = runDonchian(data, LIVE, cut);
  return { pnl: r.pnl + '%', pf: r.pf, dd: r.dd + '%', n: r.n, wr: r.wr + '%',
           paare: `${r.symPos}/${r.symAll}` };
}

// ── Hauptlauf ────────────────────────────────────────────────────────
(async () => {
  let data;
  if (process.argv.includes('--cache') && FS.existsSync('bt7-data.json')) {
    data = JSON.parse(FS.readFileSync('bt7-data.json', 'utf8'));
    console.error('Daten aus bt7-data.json');
  } else {
    data = {};
    for (const s of PAIRS) {
      process.stderr.write(`Lade ${s} 6H … `);
      try { data[s] = await fetchPair(s); process.stderr.write(data[s].length + ' Bars\n'); }
      catch (e) { data[s] = null; process.stderr.write('FEHLER ' + e.message + '\n'); }
      await sleep(150);
    }
    FS.writeFileSync('bt7-data.json', JSON.stringify(data));
  }

  const ok = PAIRS.filter(s => data[s] && data[s].length > WARMUP + 10);
  const b = data[ok[0]];
  const meta = { paare: ok.length, bars: b.length,
    von: new Date(b[0].ts).toISOString().slice(0, 10),
    bis: new Date(b[b.length - 1].ts).toISOString().slice(0, 10) };

  const w50 = walkForward(data, 0.5);
  const w70 = walkForward(data, 0.7);

  console.log(JSON.stringify({
    strategie: 'Bot 1 — Donchian-Breakout 6h (bot2.js), EMA200-Filter, Turtle-Exit, Chandelier 3×ATR, kein Timeout',
    regel: 'OOS-Rendite>0 UND >=6/10 Paare UND DD<30% — in BEIDEN Schnitten',
    daten: meta,
    gitter: GRID.length + ' Kombinationen: nEntry 20/30/40 × nExit 10/20 × SL 2/3×ATR',
    schnitte: [w50, w70],
    BESTANDEN: w50.bestanden && w70.bestanden,
    live_N30_10_SL2_oos: { s50: liveOOS(data, 0.5), s70: liveOOS(data, 0.7) },
  }, null, 1));
})();
