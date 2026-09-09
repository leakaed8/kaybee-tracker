# Al Chark Patient CRM

A role-based patient CRM for Al Chark: staff log visits and follow-ups,
patients get a portal for their own care history and notifications.

This is a separate app from the KayBee Field Tracker that lives at the repo
root — it has its own client/server, its own database (Postgres, not Google
Sheets), and its own deploy. See the top-level spec this was scaffolded from
for the full build order; **this scaffold covers steps 1-4 only**: schema,
auth (staff username/password + patient phone/PIN), staff patient
search/visit entry/timeline, and the follow-up dashboard. Web push,
node-cron scheduling, Telegram alerts, progress photos, and the shop are not
built yet.

## Stack

- Client: React + Vite, role-based routing (`/staff/*`, `/patient/*`)
- Server: Node/Express, JWT auth, role middleware
- Database: PostgreSQL

## Local development

1. Create a Postgres database and put its connection string in
   `server/.env` (copy `server/.env.example` — at this stage you only need
   `DATABASE_URL`, `JWT_SECRET`, and `PORT`).
2. Install dependencies:
   ```bash
   npm run install:all
   ```
3. Run the schema migration, then seed a test staff/patient/products:
   ```bash
   npm run migrate
   npm run seed
   ```
   This creates staff login `staff` / `staff123` and patient login
   `+96170123456` / `1234`.
4. Start both dev servers:
   ```bash
   npm run dev:server   # http://localhost:3000
   npm run dev:client   # http://localhost:5173 (proxies /api to :3000)
   ```

## Production

```bash
npm run build   # builds client/dist, installs server deps
npm start       # serves the built frontend + API on one port (PORT env var)
```
