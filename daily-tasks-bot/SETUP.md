# Setup: DailyTasks_LeaBot, step by step

You don't need to write or run any code for this. Every step below is
either clicking around a website or pasting one thing into one box.
Budget about 20-25 minutes total, done once.

You already have your bot token from @BotFather for @DailyTasks_LeaBot —
keep it somewhere private (a notes app, a password manager). **Never paste
it into a chat, email, or anywhere public. Never share it with anyone,
including me (Claude) in future conversations — only ever paste it into the
private boxes described below.**

## 0. Create two secret strings

You'll need two random secret strings of your own (not the bot token) —
one to secure the connection between Telegram and your server, one to
secure the daily 9:30 AM trigger. They just need to be long and
unguessable; nothing to memorize.

Easiest way: use your password manager (1Password, Bitwarden, Chrome's
built-in password generator, etc.) to generate two random 40-character
passwords. Save them somewhere private, labeled e.g. `WEBHOOK_SECRET` and
`CRON_SECRET`.

(If you're comfortable with a terminal, `openssl rand -hex 24` generates
one instantly — run it twice for two different values.)

## 1. Create a free Turso database (this is where your tasks live)

Turso stores your task list permanently — it survives your server
restarting or redeploying, unlike a plain file would on the hosting plan
we're using.

1. Go to **turso.tech** and sign up (GitHub login is easiest) — it's free
   for a personal to-do list's worth of data.
2. From the dashboard, create a new database (button usually says **Create
   Database**). Any name is fine, e.g. `dailytasks`.
3. Once created, open the database and find its **connection URL** — it
   looks like `libsql://dailytasks-yourname.turso.io`. Copy it somewhere
   private; this is your `TURSO_DATABASE_URL`.
4. Create an auth token for it (usually a **Create Token** button on the
   database page). Copy the token somewhere private; this is your
   `TURSO_AUTH_TOKEN`.

## 2. Deploy the server on Render

1. Go to **render.com** and sign in (you likely already have an account
   from kaybee-tracker).
2. Click **New +** → **Web Service**.
3. Select the `leakaed8/kaybee-tracker` repository (same repo, don't
   worry — this bot lives in its own folder and won't touch the existing
   app).
4. Render will ask for settings. Set them manually (this project has its
   own `render.yaml`-free setup since it's a second, independent service in
   the same repo):
   - **Root Directory**: `daily-tasks-bot`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Under **Environment Variables**, add each of these (values from steps
   0-1, plus your bot token):
   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | your bot token from BotFather |
   | `WEBHOOK_SECRET` | the first random string from step 0 |
   | `CRON_SECRET` | the second random string from step 0 |
   | `TURSO_DATABASE_URL` | from step 1 |
   | `TURSO_AUTH_TOKEN` | from step 1 |
   | `TIMEZONE` | `Asia/Beirut` |
   | `ALLOWED_TELEGRAM_USER_ID` | leave **blank** for now — step 4 below fills this in |
6. Click **Create Web Service**. Wait for the build to finish (a couple of
   minutes). When it's done, copy the URL Render gives you, e.g.
   `https://dailytasks-leabot.onrender.com` — this is your
   `PUBLIC_BASE_URL`.

## 3. Tell Telegram where to send messages (register the webhook)

This is one link you visit in your own browser, once. It tells Telegram
"send updates for this bot to my server." Build the link by filling in
your own values below (replace the `<...>` parts, keep everything else
exactly as-is):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<PUBLIC_BASE_URL>/webhook/<WEBHOOK_SECRET>&secret_token=<WEBHOOK_SECRET>
```

Paste the finished link into your browser's address bar and press Enter.
You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

This link contains your bot token — it's safe to type into your own
browser address bar, but don't paste it into a chat, email, or screenshot,
and don't bookmark/share it anywhere.

## 4. Find and authorize your own Telegram account

1. Open Telegram and message **@DailyTasks_LeaBot** anything (e.g. "hi").
2. It should reply within a few seconds (the very first message after
   deploy can take up to ~50 seconds — the free server is waking up) with
   something like:
   > Your Telegram user ID is: `123456789`
   > Set this as the `ALLOWED_TELEGRAM_USER_ID` environment variable...
3. Copy that number.
4. In Render, go to your service → **Environment** → add
   `ALLOWED_TELEGRAM_USER_ID` = that number → **Save Changes**. Render
   redeploys automatically (about a minute).
5. Message the bot again (e.g. `/start`). It should now respond normally —
   you're authorized, and no one else can be.

## 5. Set up the 9:30 AM daily message

We use a free external scheduler so the message goes out reliably even
when the free Render server has been idle and asleep.

1. Go to **cron-job.org** and sign up (free).
2. Create a new cron job:
   - **URL**: `<PUBLIC_BASE_URL>/cron/daily?key=<CRON_SECRET>` (your own
     values from steps 0 and 2)
   - **Schedule**: every day, **09:30**
   - **Timezone**: `Asia/Beirut` — pick it from the dropdown. Do **not**
     manually convert to UTC; picking the named timezone means Lebanon's
     daylight-saving changes are handled automatically.
   - Enable "notify on failure" if offered, so you'd know if a send ever
     failed.
3. (Recommended) Add a second cron job hitting
   `<PUBLIC_BASE_URL>/health` at **09:25** (same Asia/Beirut timezone). This
   just wakes the free server up a few minutes early so the 09:30 request
   doesn't have to wait through a cold start.
4. Save. That's it — the bot now messages you every morning at 9:30 Beirut
   time on its own, with no dependence on your phone or computer being on.

## Everyday use

- `/add Call supplier` — due today
- `/add Call supplier tomorrow`
- `/add Call supplier Friday`
- `/add Call supplier 2026-08-15`
- `/today` — see today's list with buttons any time
- On any task: **✅ Done**, **↩️ Tomorrow**, **🗑** (asks you to confirm)

## Updating later

Any time new commits are pushed to this branch (or you merge it to `main`
and point Render at `main`), Render rebuilds and redeploys the bot
automatically — no manual steps needed. Your tasks stay put in Turso the
whole time.

## Notes on the free tier

- Render's free web service sleeps after ~15 minutes with no requests.
  The first message or button tap after a quiet stretch may take up to
  ~50 seconds to respond — that's normal, not broken.
- If you ever want zero delay, the paid Render "Starter" plan ($7/mo)
  removes the sleep entirely — nothing else about this setup would need to
  change.
