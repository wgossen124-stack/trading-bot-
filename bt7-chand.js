// Zusatzprüfung zu bt7.js: Was trägt der Chandelier-Stop bei?
// Er läuft seit dem 22.08.2026 live, wurde nie getestet, und N=3 ist der
// Lehrbuchwert — nicht aus den Daten gewählt. Hier out-of-sample geprüft,
// mit den Live-Parametern N30/10 SL2, auf denselben Daten wie bt7.js.
const FS = require('fs');
const src = FS.readFileSync('bt7.js', 'utf8');

const PAIRS = ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','LTC','DOT'];
const data = JSON.parse(FS.readFileSync('bt7-data.json', 'utf8'));
const all = [...new Set(PAIRS.flatMap(s => data[s] ? data[s].map(b => b.ts) : []))].sort((a,b)=>a-b);
const LIVE = { nEntry:30, nExit:10, slMult:2.0 };

// bt7.js als Modul laden, ohne seinen Hauptlauf auszuführen
const body = src.slice(0, src.indexOf('// ── Hauptlauf'));
const mod = { exports: {} };
new Function('module','exports','require', body +
  '\nmodule.exports={runDonchian,FIX};')(mod, mod.exports, require);
const { runDonchian, FIX } = mod.exports;

const out = {};
for (const [name, frac] of [['50/50', 0.5], ['70/30', 0.7]]) {
  const cut = all[Math.floor(all.length * frac)];
  const row = {};
  for (const ch of [3.0, 2.0, 4.0, 6.0, 1e9]) {
    FIX.chandAtr = ch;
    const r = runDonchian(data, LIVE, cut);
    row[ch === 1e9 ? 'ohne' : ch + '×ATR'] =
      { pnl: r.pnl + '%', pf: r.pf, dd: r.dd + '%', n: r.n, paare: `${r.symPos}/${r.symAll}` };
  }
  out[name] = row;
}
console.log(JSON.stringify({
  frage: 'Chandelier-Stop (live seit 22.08.2026, ungetestet) — out-of-sample, Live-Parameter N30/10 SL2',
  ergebnis: out }, null, 1));
