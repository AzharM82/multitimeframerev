# WhatsApp Sidecar

Long-running Node process that drains WhatsApp alerts from the Azure Storage Queue (`whatsapp-alerts`) and sends them via [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), logged in as the **sender** WhatsApp number. Messages arrive at the **receiver** number naturally as if you texted yourself.

## One-time setup

```bash
cd tools/whatsapp-sidecar
npm install
cp .env.example .env          # fill AZURE_STORAGE_CONNECTION_STRING
node src/index.js
```

When the QR code prints, open WhatsApp on the **sender** phone:
**Settings → Linked Devices → Link a device** and scan.

The session is cached under `.wwebjs_auth/` and survives restarts. Re-scan is required ~every 14 days when WhatsApp expires the link.

## Running on boot (Windows Task Scheduler)

```powershell
# As your normal user (not admin), so it can show the tray)
schtasks /create /tn "WA Sidecar" /tr "node C:\Users\reach\MultiTimeframeReversal\tools\whatsapp-sidecar\src\index.js" /sc onlogon /rl highest
```

Or via the GUI: Task Scheduler → Create Task → Triggers: At log on → Actions: Start a program → Program: `node`, Arguments: `C:\Users\reach\MultiTimeframeReversal\tools\whatsapp-sidecar\src\index.js`.

## Health check

When healthy, the console prints:

```
WhatsApp client ready. Draining queue every 60 s.
```

If you see auth_failure or repeated disconnects, the QR has expired — kill the process, delete `.wwebjs_auth/`, and re-scan.

## Failure handling

* If the sidecar is offline, the day-trade timer falls back to Pushover (alerts still arrive on phone).
* Failed sends are NOT deleted from the queue — they re-appear after the visibility timeout.
* Crashes exit with non-zero so Task Scheduler restarts the process.
