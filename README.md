# Cloud-Bot v6 — Paper-Trading (GitHub Actions)

Backtest-validierte Strategie (identische Logik wie der Trading-Assistent v6):
**1h-Entries · nur CANDLE+BOUNCE · Score ≥90 · SL 1,5×ATR (min 0,8%) · TP 3×ATR (RRR 2:1)**
Regime-Gate, 4h-Trendfilter, Momentum-Guards, Cooldown, Fees + Slippage simuliert.

Läuft **stündlich automatisch und kostenlos** über GitHub Actions (öffentliches Repo).

## Dateien
- `bot.js` — der Bot (Node 20, keine Abhängigkeiten)
- `state.json` — Kontostand, Positionen, Trades (vom Bot verwaltet)
- `REPORT.md` — **hier reinschauen**: aktueller Stand, Positionen, letzte Trades
- `.github/workflows/bot.yml` — der Stundenplan

## Einrichten (einmalig, ~5 Minuten)
1. Auf github.com einloggen → **New repository** → Name z.B. `trading-bot` → **Public** → Create
2. **Add file → Upload files** → `bot.js` und `README.md` hochladen → Commit
3. **Add file → Create new file** → als Dateinamen exakt eintippen:
   `.github/workflows/bot.yml` → Inhalt der `bot.yml` aus diesem Ordner hineinkopieren → Commit
   (dieser Umweg, weil versteckte Ordner sich per Upload schlecht übertragen)
4. Tab **Actions** → ggf. „I understand… enable workflows" bestätigen
5. Links **cloud-bot** anklicken → **Run workflow** → erster Lauf startet sofort

Danach läuft er jede Stunde von selbst. Stand checken: einfach `REPORT.md` im Repo öffnen (geht vom Handy).

## Hinweise
- GitHub deaktiviert Zeitpläne nach 60 Tagen ohne Repo-Aktivität — der Bot committet
  aber bei jedem Lauf, dadurch bleibt er aktiv.
- Stoppen: Actions-Tab → Workflow → „…" → Disable workflow.
- Papiergeld — keine echten Trades, keine API-Keys, keine Secrets.
