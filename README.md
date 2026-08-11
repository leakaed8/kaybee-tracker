# KayBee Field Tracker

A field sales / inventory tracker for KayBee Pharma: expiry alerts, client tiering
and follow-up cadence, rep check-ins with GPS, route ordering, outreach logging,
and a manager dashboard.

The app is a React frontend + a small Node/Express backend. All data (products,
visits, clients, outreach log, settings) is stored in a Google Sheet via a
service account, so every device — manager's laptop, rep's phone — reads and
writes the same live data.

See **SETUP.md** for the one-time setup (Google Sheet + service account) and
how to deploy this to a live URL on Render.

## Local development

```bash
npm run install:all

# terminal 1
npm run dev:server   # http://localhost:3001

# terminal 2
npm run dev:client   # http://localhost:5173 (proxies /api to :3001)
```

You'll need a `server/.env` file (copy `server/.env.example`) with your Google
service account credentials and Sheet ID — see SETUP.md.

## Production

```bash
npm run build   # builds client/dist and installs server deps
npm start       # serves the built frontend + API on one port (PORT env var)
```

## DailyTasks_LeaBot

This repo also hosts a second, unrelated project: a private Telegram daily
task manager. It's fully independent of the app above (own folder, own
dependencies, own deployment). See
[`daily-tasks-bot/README.md`](./daily-tasks-bot/README.md) and
[`daily-tasks-bot/SETUP.md`](./daily-tasks-bot/SETUP.md).
