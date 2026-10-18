# Runner: Takt und Wächter

> Stand 18.10.2026. Warum das nötig ist: Der GitHub-Schedule (`*/15`) lief ab dem
> 24.08.2026 — dem letzten Commit von Hand — nur noch ~5× am Tag (Median 4,6 h,
> Maximum 9,9 h) statt 96×. GitHub drosselt geplante Workflows in Repos ohne
> menschliche Aktivität und schaltet sie nach 60 Tagen ganz ab. Niemand hat es
> gemerkt, weil nichts Alarm schlug. Deshalb zwei Dinge von außen: ein Taktgeber
> und ein Wächter. Beides kostenlos, kein eigener Server.

## 1. Taktgeber: cron-job.org → `workflow_dispatch`

Der Workflow hat `workflow_dispatch` schon drin. Von außen angestoßene Läufe
werden nicht gedrosselt wie Schedule-Läufe.

### a) Fine-grained PAT bei GitHub erzeugen

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token

| Feld | Wert |
|---|---|
| Token name | `cron-job-trading-bot` |
| Expiration | 1 Jahr (Erinnerung in den Kalender) |
| Repository access | **Only select repositories** → `trading-bot-` |
| Repository permissions | **Actions: Read and write** — sonst nichts |

Mehr darf der Token nicht. Mit `Actions: write` kann er Workflows starten, aber
keinen Code ändern, keine Secrets lesen, nichts anderes im Konto anfassen.
Den Token einmal kopieren; GitHub zeigt ihn nie wieder.

### b) Cronjob bei cron-job.org anlegen

Konto bei <https://cron-job.org> (kostenlos), dann **Create cronjob**:

| Feld | Wert |
|---|---|
| Title | `trading-bot dispatch` |
| URL | `https://api.github.com/repos/wgossen124-stack/trading-bot-/actions/workflows/bot.yml/dispatches` |
| Schedule | **Every hour**, Minute **3** (Kerzen schließen zur vollen Stunde; 3 Minuten später sind die Daten da) |
| Request method | **POST** |
| Request body | `{"ref":"main"}` |
| Headers | `Accept: application/vnd.github+json` |
| | `Authorization: Bearer <der PAT>` |
| | `X-GitHub-Api-Version: 2022-11-28` |
| Treat as success | HTTP **204** (GitHub antwortet ohne Body) |
| Notifications | bei Fehlschlag E-Mail an |

Die Einstellungen stehen bei cron-job.org unter *Advanced*. Nach dem Speichern
einmal **Test run** klicken: In GitHub → Actions muss innerhalb von Sekunden ein
Lauf mit Auslöser `workflow_dispatch` erscheinen.

Für 6h- und 1D-Kerzen reicht stündlich. Wer die 4h-Frische von Bot 2 enger
haben will, stellt auf alle 30 Minuten; cron-job.org erlaubt bis zu jede Minute.

Der Schedule `*/15` bleibt im Workflow als Fallback. `concurrency: group: bot`
sorgt dafür, dass sich ein Schedule-Lauf und ein Dispatch-Lauf nicht
überlappen.

## 2. Wächter: healthchecks.io

Der Schritt *Wächter-Ping* in `bot.yml` ruft am Ende jedes Laufs eine
Ping-URL auf. Bleibt der Ping aus, schlägt healthchecks.io Alarm.

1. Konto bei <https://healthchecks.io> (kostenlos bis 20 Checks).
2. **Add Check** → Name `trading-bot run`.
3. Schedule: **Period 1 hour, Grace 1 hour** → Alarm, wenn länger als 2 h kein
   Lauf ankam. (Bei Umstellung auf 30-Minuten-Takt: Period 30 min, Grace 1 h.)
4. Integrations: E-Mail ist voreingestellt; Telegram lässt sich dort in zwei
   Klicks ergänzen.
5. Die Ping-URL kopieren (`https://hc-ping.com/<uuid>`).
6. GitHub → Repo → Settings → Secrets and variables → Actions → **New repository
   secret**: Name `HC_PING_URL`, Value die Ping-URL.

Ein schlecht gelaufener Job (etwa Push nach 5 Versuchen gescheitert) pingt
`/fail` — healthchecks.io meldet das sofort, nicht erst nach der Frist.
Fehlt das Secret, warnt der Schritt nur; der Bot-Lauf hängt nicht daran.

## 3. Sofort: 60-Tage-Zähler zurücksetzen

Der Push dieser beiden Dateien ist bereits ein Commit von Hand. Falls GitHub den
Schedule trotzdem schon deaktiviert hat (Banner im Actions-Tab: *"This
scheduled workflow is disabled because there has been no activity"*), dort auf
**Enable workflow** klicken.

## Kontrolle nach vier Wochen

Abstände zwischen `run`-Commits messen (Skript im Vault-Tagebuch vom
18.10.2026). Ziel: Median ≤ 1 h, Maximum ≤ 2 h. Wenn das nicht erreicht wird,
ist cron-job.org nicht die Lösung, und die Bots gehören auf einen kleinen VPS
mit systemd-Timer (GitHub dann nur noch als Zustandsspeicher).

## Was wo liegt

| Geheimnis | Ort | Rechte |
|---|---|---|
| Fine-grained PAT | cron-job.org, Header des Cronjobs | nur `Actions: write` auf dieses Repo |
| Ping-URL | GitHub Repo-Secret `HC_PING_URL` | nur Pings auslösen |

Keines davon gehört in den Vault, in `.env`-Dateien oder in den Code.
