# MTF Reversal Cron Functions

Native Azure scheduler — replaces cron-job.org. Four timer-triggered functions in a Consumption-plan Function App, each posting to a SWA endpoint with the timer secret.

## Schedules (Eastern Time, via `WEBSITE_TIME_ZONE`)

| Function          | NCRONTAB             | Fires                                            | Calls                          |
|-------------------|----------------------|--------------------------------------------------|--------------------------------|
| `avwapEodCron`    | `0 15 16 * * 1-5`    | Weekdays 4:15 PM ET                              | `POST /api/avwap-eod-timer`    |
| `bullEmailCron`   | `0 0 * * * *`        | Every hour, 24/7                                 | `POST /api/bull-email-timer`   |
| `bullMonitorCron` | `0 0,30 9-16 * * 1-5`| Every 30 min, 9:00 AM–4:30 PM ET, weekdays       | `POST /api/bull-monitor-timer` |
| `dayTradeCron`    | `0 */10 9-15 * * 1-5`| Every 10 min, 9:00 AM–3:50 PM ET, weekdays       | `POST /api/day-trade-timer`    |

## Deploy

```bash
# One-time create (uses existing mtfrevstorage)
az functionapp create \
  --name mtfrev-cron \
  --resource-group rg-mtfrev \
  --storage-account mtfrevstorage \
  --consumption-plan-location eastus2 \
  --runtime node --runtime-version 20 \
  --functions-version 4 \
  --os-type linux

az functionapp config appsettings set --name mtfrev-cron --resource-group rg-mtfrev --settings \
  TIMER_SECRET="<from rg-mtfrev/mtfrev-app>" \
  WEBSITE_TIME_ZONE="Eastern Standard Time" \
  SITE_URL="https://salmon-river-0a7a0c30f.1.azurestaticapps.net"

# Deploy code
cd tools/cron-functions
func azure functionapp publish mtfrev-cron --javascript
```

## Cost

Consumption plan free tier covers it: ~2,000 executions/month, 100 GB-seconds. Well below the 1M execution / 400k GB-second free grant.

## Verify

```bash
# Tail live logs:
func azure functionapp logstream mtfrev-cron

# Or check via az:
az monitor app-insights events show --app <ai-name> -g rg-mtfrev --type traces --offset 1h
```
