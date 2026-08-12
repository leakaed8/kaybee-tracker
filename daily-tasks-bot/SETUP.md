# Setup: DailyTasks_LeaBot, step by step

You don't need to write or run any code for this. Every step below is
either clicking around a website or pasting one thing into one box. This
version only uses **Render** and **Google** — both of which you already have
accounts for from kaybee-tracker — plus Telegram. No new platform signups.

Budget about 15-20 minutes total, done once.

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

## 1. Reuse your existing Google credentials

If you already have the Google Cloud service account you set up for
kaybee-tracker (the one whose `client_email` and `private_key` you put into
kaybee-tracker's `server/.env` or its Render environment variables), you
don't need to create anything new — just reuse those same two values here.
Find them wherever you saved them (or in kaybee-tracker's Render
Environment tab, under `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
`GOOGLE_PRIVATE_KEY`).

**Only if you don't have one already**, create it (same steps as
kaybee-tracker's setup):
1. console.cloud.google.com → New Project (skip if you already have one).
2. console.cloud.google.com/apis/library/sheets.googleapis.com → **Enable**.
3. console.cloud.google.com/iam-admin/serviceaccounts → **Create Service
   Account** → any name (e.g. `dailytasks-sheets`) → click through defaults
   → Done.
4. Click into it → **Keys** tab → **Add Key** → **Create new key** → JSON →
   Create. A `.json` file downloads. You need two values from it:
   `client_email` and `private_key`.

## 2. Pick (or create) the Google Sheet, and share it

You can reuse the Google Sheet you already linked
(`docs.google.com/spreadsheets/d/1N3T3hYnaFyuppfC4w8KrLxoLJkvj2b_c8iMZBgSNsuo`)
— the bot will add its own `Tasks` and `State` tabs to it automatically and
won't touch anything else in it — or create a brand new blank sheet if
you'd rather keep it separate. Either way:

1. Open the sheet → **Share** button → paste in the service account's
   `client_email` (from step 1) → give it **Editor** access → Share. This
   is the step people usually miss — without it the bot can't write to the
   sheet. (Skip this if it's the *same* service account already shared with
   kaybee-tracker's sheet and you're reusing that exact sheet — it's
   already shared.)
2. Copy the Sheet ID from the URL — the long string between `/d/` and
   `/edit`. This is your `SHEET_ID`.

## 3. Deploy the server on Render

1. Go to **render.com** and sign in (your existing kaybee-tracker account).
2. Click **New +** → **Web Service**.
3. Select the `leakaed8/kaybee-tracker` repository (same repo — this bot
   lives in its own folder and won't touch the existing app).
4. Set these manually:
   - **Root Directory**: `daily-tasks-bot`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Under **Environment Variables**, add:
   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | your bot token from BotFather |
   | `WEBHOOK_SECRET` | the first random string from step 0 |
   | `CRON_SECRET` | the second random string from step 0 |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | from step 1 |
   | `GOOGLE_PRIVATE_KEY` | from step 1 (paste exactly as-is, including `\n` sequences — Render's box handles this fine) |
   | `SHEET_ID` | from step 2 |
   | `TIMEZONE` | `Asia/Beirut` |
   | `ALLOWED_TELEGRAM_USER_ID` | leave **blank** for now — step 5 below fills this in |
6. Click **Create Web Service**. Wait for the build to finish (a couple of
   minutes). When it's done, copy the URL Render gives you, e.g.
   `https://dailytasks-leabot.onrender.com` — this is your
   `PUBLIC_BASE_URL`.

## 4. Tell Telegram where to send messages (register the webhook)

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

## 5. Find and authorize your own Telegram account

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

## 6. Set up the 9:30 AM daily message (Google Apps Script)

This uses a script attached to the same Google Sheet from step 2 — no new
account, just a feature already built into every Google Sheet.

1. Open the Google Sheet from step 2 → **Extensions** menu → **Apps
   Script**. A new tab opens with a code editor.
2. Delete anything in the default `Code.gs` file and paste in the contents
   of this repo's `daily-tasks-bot/apps-script/dailyTrigger.gs`.
3. Click the **gear icon** (Project Settings) in the left sidebar →
   scroll to **Script Properties** → **Add script property**:
   - Property: `CRON_URL`
   - Value: `<PUBLIC_BASE_URL>/cron/daily?key=<CRON_SECRET>` (your own
     values from steps 0 and 3)
4. Go back to the editor (the `<>` icon) → click the **clock icon**
   (Triggers) in the left sidebar → **Add Trigger**:
   - Function to run: `sendDailyTasksDigest`
   - Event source: **Time-driven**
   - Type: **Day timer**
   - Time of day: **9am to 10am** (Apps Script only offers hour windows,
     not an exact minute — see note below)
   - Save. The first time, Google will ask you to authorize the script —
     approve it (it's your own script, running under your own account).
5. **About the exact time**: Apps Script's UI only lets you pick an hour
   window (e.g. "9am to 10am"), not "9:30" precisely, and it fires at a
   randomized minute within that window rather than exactly on the hour.
   For a personal daily reminder this is normally fine (you'll get it
   sometime in that hour, reliably every day, correctly adjusted for
   Lebanon's daylight-saving changes since it runs on your Sheet's own
   time zone). If you want it pinned closer to 9:30 specifically, open
   **File → Project Settings** in the Apps Script editor and set the
   script's time zone explicitly to `Asia/Beirut` (if it isn't already),
   then re-create the trigger — the hour window is still the limit, but
   the window itself will be correctly anchored to Beirut time.

That's it — the bot now messages you every morning on its own, with no
dependence on your phone or computer being on.

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
automatically — no manual steps needed. Your tasks stay put in the Google
Sheet the whole time.

## Notes on the free tier

- Render's free web service sleeps after ~15 minutes with no requests.
  The first message or button tap after a quiet stretch may take up to
  ~50 seconds to respond — that's normal, not broken. The Apps Script
  trigger already retries once if the first ping times out (see
  `dailyTrigger.gs`).
- If you ever want zero delay, the paid Render "Starter" plan ($7/mo)
  removes the sleep entirely — nothing else about this setup would need to
  change.
