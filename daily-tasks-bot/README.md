# DailyTasks_LeaBot

A private Telegram daily to-do list. Every morning at 9:30 AM Beirut time it
sends you today's tasks (carried-over tasks first, then new ones), with
inline buttons to mark them done, push them to tomorrow, or delete them.
Anything left unfinished at day's end automatically carries forward to the
next day — same task record, not a duplicate.

Only one Telegram account (yours) can ever use this bot. Everyone else gets
a generic "not authorized" reply.

Runs entirely on platforms already used elsewhere in this repo — **Render**
for hosting and **Google** (Sheets + Apps Script) for storage and
scheduling. No Turso, no third-party cron service, no extra signups.

**Not a programmer?** Skip straight to [SETUP.md](./SETUP.md) — it's a
step-by-step, copy-paste checklist with nothing that requires reading code.

## How it works

```
Telegram  <-->  Render (free web service, Express)  <-->  Google Sheets (source of truth)
                        ^
                        |
              Google Apps Script time-driven trigger
              pings /cron/daily at 09:30 Asia/Beirut
```

- **Telegram → server**: Telegram delivers messages/button-taps to this
  server via a *webhook* (not polling), at a secret, unguessable URL.
- **Server → Google Sheets**: all task data lives in a Google Sheet, read
  and written via the same service-account pattern kaybee-tracker already
  uses (`server/sheetsDb.js`). This is the source of truth — nothing is
  stored only in memory or only in Telegram. Two tabs are created
  automatically the first time the bot runs: `Tasks` and `State` (a tiny
  key/value tab used only to remember "did today's digest already go out").
- **The 9:30 AM message**: Render's free tier isn't guaranteed to be awake
  at any given moment, so a Google Apps Script time-driven trigger (bound to
  the same Google account, free, and timezone-aware) pings a protected
  endpoint on the server at 09:30 `Asia/Beirut` every day, which triggers
  the send. The endpoint is idempotent (checks whether today's digest
  already went out) so a duplicate ping never double-sends. See
  `apps-script/dailyTrigger.gs`.
- **Carry-over**: computed on read, not by a separate midnight job. Any time
  "today's tasks" are computed (the 9:30 send, or `/today`), pending tasks
  whose `due_date` is in the past get rolled forward to today and their
  `carryover_count` incremented. This makes it self-healing — if a day's
  trigger is ever missed, the next read catches everything up correctly.

## Project layout

```
daily-tasks-bot/
  src/
    server.js         Express app: webhook + cron endpoints
    config.js          Reads/validates environment variables
    sheetsStore.js     Google Sheets-backed task store (the database)
    dateUtils.js       Beirut-timezone date helpers + tiny NL date parser
    taskService.js     All task business logic (carry-over, add, complete, ...)
    messageBuilder.js  Renders the Telegram message text + inline keyboard
    telegramClient.js  Thin wrapper over the Telegram Bot API
    auth.js            Single-user whitelist check
    botHandlers.js     Dispatches incoming commands / button taps
    logger.js           console logger that redacts secret-looking fields
  apps-script/
    dailyTrigger.gs    Paste into Extensions > Apps Script on your Sheet
  scripts/
    setWebhook.js      Run once locally after deploying, to register the webhook
    deleteWebhook.js   Run locally to stop the bot receiving updates
  test/
    memoryStore.js     In-memory stand-in for sheetsStore.js, used by tests
    *.test.js           node --test unit tests (carry-over, auth, dates)
```

`taskService.js` never talks to Google APIs directly — it only calls a
small store interface (`listTasks` / `insertTask` / `updateTask` /
`batchUpdateTasks` / `getState` / `setState`). `sheetsStore.js` implements
that interface for real; `test/memoryStore.js` implements the same
interface in plain memory, which is what the unit tests use instead of
hitting the real Sheets API — no Google credentials needed to run `npm test`.

## Data model (`Tasks` tab)

| column | meaning |
|---|---|
| `id` | primary key (`t` + a random UUID) |
| `title` | task text |
| `status` | `pending` \| `completed` \| `deleted` |
| `priority` | reserved for future use, defaults to `normal` |
| `created_at` / `updated_at` | timestamps |
| `due_date` | current due date (`YYYY-MM-DD`, Beirut calendar date) — this is what moves on carry-over |
| `original_due_date` | set once at creation, never changes — used to tell "carried over" from "new today" |
| `completed_at` | set when marked done |
| `carryover_count` | incremented each time the *automatic* daily rollover moves this task forward |
| `telegram_message_id` / `telegram_chat_id` | the last Telegram message this task was rendered in |

## Local development

```bash
cd daily-tasks-bot
npm install
cp .env.example .env   # then fill in real values, see SETUP.md
npm test                # run the unit tests (no network / real Google needed)
npm start                # starts the server on http://localhost:3000
```

Telegram webhooks require a public HTTPS URL, so for real end-to-end local
testing you'd need a tunnel (e.g. `ngrok http 3000`) and to point
`PUBLIC_BASE_URL` at the tunnel URL before running `npm run set-webhook`.
Day-to-day, testing against the deployed Render URL is simpler — see
SETUP.md.

## Commands

- `/start`, `/help` — usage
- `/add <task>` — add a task, due today by default. Optionally end with
  `tomorrow`, a weekday name (`friday`), or an explicit `YYYY-MM-DD`.
- `/today` — show today's tasks (carried-over + new) with buttons

Buttons on every task: `✅ Done`, `↩️ Tomorrow` (reschedule without
completing), `🗑` (asks for confirmation, then soft-deletes).

## Security

- `ALLOWED_TELEGRAM_USER_ID` is checked on *every* message and *every*
  button press before touching the database. Leave it blank on first boot:
  the bot replies to whoever messages it with their numeric Telegram ID (and
  does nothing else) so you can find your own ID and configure it.
- The webhook URL includes a long random secret path segment, and every
  incoming request is also checked against the `X-Telegram-Bot-Api-Secret-Token`
  header Telegram sends — set via `WEBHOOK_SECRET`.
- The daily cron endpoint requires a separate secret (`CRON_SECRET`) as a
  query parameter, kept out of the Apps Script source itself (read from a
  Script Property instead — see `apps-script/dailyTrigger.gs`).
- The bot token, webhook secret, cron secret, and Google credentials are
  only ever read from environment variables — never hardcoded, never logged
  (`logger.js` redacts any field whose key looks like `token`/`secret`/`key`/`password`).

## Future features (not built yet, but the code is structured for them)

Recurring tasks, priorities/categories, weekly summaries, overdue warnings,
`/list` / `/delete` / `/edit`, search, voice-to-task, and hooking into other
business systems. `taskService.js` and `sheetsStore.js` are the places to
extend first — e.g. `priority` already exists as a column, just unused by
any command yet.
