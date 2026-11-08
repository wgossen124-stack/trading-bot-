# Cloud-Bot 2 — Donchian-Breakout (Paper)

> [!danger] ABGESCHALTET am 08.11.2026 — dieser Report wird nicht mehr fortgeschrieben
>
> Grund: Der Walk-Forward wurde am 26.10.2026 nachgeholt (`bt7.js`) und
> **nicht bestanden** — 50/50: IS +16,1 % → OOS +2,3 % (5/10 Paare);
> 70/30: IS +36,8 % → OOS −15,3 % (3/10 Paare). Alle 12 Gitterkombinationen
> waren in-sample positiv, was das Marktregime beschreibt und nicht die Logik.
>
> **Schlussstand: $1.842,75 (−7,9 %)** nach 92 Trades, PF 0,83, Drawdown 20,8 %.
> Darin −3,15 $ aus drei beim Abschalten offenen Shorts (TIA, LTC, DOGE) — die
> Zahl ist also unabhängig davon, wie man die offenen Positionen bewertet.
> Die vollständige Begründung steht in `.github/workflows/bot.yml`.
> `bot2.js` und `state2.json` bleiben als Archiv liegen.

> Aktualisiert: 2026-11-08 13:12 UTC · Lauf #1276 · 6H · N30/10
>
> Verpasste Kerzen (kein Lauf binnen 4 h nach Schluss): 38 · verworfen wegen Kursdrift >1×ATR: 3

| Equity | PnL | Winrate | Trades | Offen | Drawdown |
|---|---|---|---|---|---|
| $1842.78 | -157.22$ (-7.9%) | 24% | 92 | 3 | 20.8% |

## Offene Positionen

| Pair | Seite | Entry | Stop |
|---|---|---|---|
| TIA | SHORT | 0.414017 | 0.449300 |
| LTC | SHORT | 51.8696 | 53.4200 |
| DOGE | SHORT | 0.0717257 | 0.0733200 |

## Letzte Trades

| Zeit (UTC) | Pair | Seite | PnL | Grund |
|---|---|---|---|---|
| 11-05 10:00 | INJ | LONG | -18.93$ | STOP |
| 11-04 10:00 | ATOM | SHORT | +1.69$ | STOP |
| 10-31 10:00 | FIL | SHORT | -14.63$ | STOP |
| 10-30 10:00 | OP | SHORT | -18.26$ | STOP |
| 10-28 16:00 | FIL | SHORT | +5.77$ | STOP |
| 10-28 16:00 | ARB | SHORT | -3.20$ | STOP |
| 10-27 22:00 | AVAX | SHORT | +6.26$ | STOP |
| 10-24 01:07 | ATOM | LONG | -20.43$ | TRAIL |
| 10-22 04:00 | BNB | LONG | -16.39$ | STOP |
| 10-22 04:00 | BTC | LONG | -17.93$ | STOP |
| 10-20 10:00 | OP | SHORT | -6.37$ | STOP |
| 10-20 10:00 | ADA | SHORT | -2.95$ | STOP |
| 10-19 04:00 | LTC | SHORT | -4.11$ | STOP |
| 10-18 13:54 | INJ | LONG | -9.28$ | TRAIL |
| 10-17 22:00 | TIA | LONG | -17.29$ | STOP |
