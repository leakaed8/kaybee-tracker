# Setup: Google Sheet backend + live deploy on Render

Two one-time steps: (1) give the app a Google Sheet to read/write, (2) deploy it
on Render so your team gets a phone-friendly link. Neither step requires
sharing any password or API key with anyone else — you do this yourself in
your own Google and Render accounts.

Budget about 10–15 minutes.

## 1. Create the Google Sheet + service account

The app talks to Google Sheets as a "service account" (a robot user), not as
your personal Google login. This keeps your real Google password out of it
entirely.

1. **Create a Google Sheet.** Go to sheets.google.com, create a new blank
   spreadsheet, name it whatever you like (e.g. "KayBee Tracker Data"). Leave
   it empty — the app creates its own tabs (Products, Visits, Clients,
   OutreachLog, Settings) automatically the first time it runs.
2. **Copy the Sheet ID.** It's the long string in the URL between `/d/` and
   `/edit`, e.g. for
   `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit`
   the ID is `1AbCdEfGhIjKlMnOpQrStUvWxYz`. Save it somewhere.
3. **Create a Google Cloud project** (skip if you already have one): go to
   console.cloud.google.com → the project dropdown (top left) → "New Project"
   → give it a name → Create.
4. **Enable the Google Sheets API**: with your project selected, go to
   console.cloud.google.com/apis/library/sheets.googleapis.com → click
   "Enable".
5. **Create a service account**: go to
   console.cloud.google.com/iam-admin/serviceaccounts → "Create Service
   Account" → give it any name (e.g. `kaybee-sheets`) → click through the
   remaining steps with defaults → Done.
6. **Create a key for it**: click into the service account you just made →
   "Keys" tab → "Add Key" → "Create new key" → choose **JSON** → Create. A
   `.json` file downloads — keep it, you'll need two values out of it:
   - `client_email` (looks like `kaybee-sheets@your-project.iam.gserviceaccount.com`)
   - `private_key` (a long string starting with `-----BEGIN PRIVATE KEY-----`)
7. **Share the Sheet with the service account.** Open your Google Sheet from
   step 1 → "Share" button → paste in the `client_email` from the JSON file →
   give it **Editor** access → Send/Share. This is the step people usually
   miss — without it the app can't write to the sheet.

You now have everything the app needs: `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`
(the `client_email`), and `GOOGLE_PRIVATE_KEY` (the `private_key`, including
the `\n` characters exactly as they appear in the JSON file).

## 2. Deploy on Render

1. Go to render.com and sign up / log in (GitHub login is easiest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account if prompted, then select the
   `leakaed8/kaybee-tracker` repository.
4. Render should auto-detect `render.yaml` in the repo and pre-fill the
   settings (build command `npm run build`, start command `npm start`). If it
   doesn't, set them manually and set **Branch** to
   `claude/field-sales-tracker-app-5r165a` (or `main` once you've merged it).
5. Under **Environment Variables**, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = the `client_email` from your JSON key
   - `GOOGLE_PRIVATE_KEY` = the `private_key` from your JSON key (paste it
     exactly as-is, including the quotes and `\n` sequences — Render's text
     box handles this fine)
   - `SHEET_ID` = the Sheet ID from step 1
6. Choose the **Free** instance type and click **Create Web Service**.
7. Render will build and deploy — takes 2-3 minutes. When it's done you'll get
   a URL like `https://kaybee-tracker.onrender.com`. That's the live link for
   your team.

Notes on the free tier: the free Render instance spins down after 15 minutes
of no traffic and takes ~30-50 seconds to wake back up on the next request —
so the first open of the day might feel slow, then it's fast. If that's
annoying for your team, Render's cheapest paid tier ($7/mo) removes the
spin-down.

## Sharing the link with your team

Send the Render URL to your reps — they can open it on their phone browser and
add it to their home screen (Share → "Add to Home Screen" on iOS, or the
install-app prompt on Android Chrome) so it behaves like an app icon.

## Updating the app later

Any time you (or Claude) push new commits to the connected branch, Render
automatically rebuilds and redeploys — no manual steps needed.
