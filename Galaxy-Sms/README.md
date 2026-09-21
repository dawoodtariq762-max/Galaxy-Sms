# POWER X SMS — VPS Deployment

POWER X SMS is a multi-level SMS/OTP panel served by a Node.js backend on a VPS.

## Production path

VPS project directory:

```bash
/root/Power X-sms
```

PM2 process:

```bash
powerx-sms
```

Backend local URL:

```txt
http://localhost:4000
```

## Start / Restart

```bash
cd ~/Power X-sms
npm install
pm2 restart powerx-sms --update-env
pm2 list
```

## Deployment workflow

Push from Windows local repo, then pull on VPS:

```bash
cd ~/Power X-sms
git pull --ff-only origin main
npm install && pm2 flush powerx-sms && pm2 restart powerx-sms --update-env && pm2 list
```

## Health check

```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health %{time_total}s\n" http://127.0.0.1:4000/api/health; sleep 1; done
```

## Main routes

```txt
/panel-login        <- main login (Admin / Manager / Agent / Client)
/admin
/management-login
/management
/payment-login
/payment
/panel-sharing-login
/panel-sharing
/test-login
/test
```

### Login URL notes

- The main panel login is **`/panel-login`** (used by Admin, Manager, Agent and Client).
- Legacy `/login` and `/login.html` are kept as permanent `301` redirects to
  `/panel-login`, so existing bookmarks and links keep working.
- `/` redirects to `/panel-login`.
- Dedicated module logins are unchanged: `/management-login`, `/payment-login`,
  `/panel-sharing-login`, `/test-login`.
- The authentication API endpoint is unchanged: `POST /api/login`.

## HTTP incoming integration

Main production incoming endpoint:

```txt
POST /api/incoming-sms
```

Accepted content types:

```txt
application/json
application/x-www-form-urlencoded
multipart/form-data
```

## Database

Default DB file:

```txt
backend/data.sqlite
```

Optional override:

```bash
DB_FILE=/root/Power X-sms/backend/data.sqlite
```

## Backups

Recommended backup folder outside app directory:

```bash
BACKUP_DIR=/root/powerx-sms-backups
```

## Notes

- API polling module has been removed/disabled. HTTP incoming remains active.
- SMPP runtime has been removed.
- Notification/news placeholder modules have been removed.
- Use `.docx/.xlsx/.pptx` for Office files if future documents are generated.

## Branding & theme

Power X SMS ships the **Aurora Dark** theme. Brand assets and styles live in `/assets`:

```txt
assets/powerx-logo.png       master logo / login hero
assets/powerx-logo-192.png   192px app icon
assets/powerx-favicon.png    browser favicon
assets/powerx-theme.css      panel design system (all dashboards)
assets/powerx-login.css      login screen styling
```

Both stylesheets are linked last in each page `<head>`, so they take precedence
over the older inline `<style>` blocks. To restyle the panel, edit the CSS custom
properties at the top of `assets/powerx-theme.css` — no markup changes required.

Backup files are named `powerx-sms-backup-<timestamp>.sqlite`; the backup service
only lists and restores files matching that prefix.
