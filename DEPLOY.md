# Deploy Memory Vault (Render Free)

## 1. Push to GitHub
- Commit this project and push to your repo.

## 2. Create Render Web Service
- Render Dashboard -> New -> Blueprint
- Select your repo (Render will read `render.yaml`), or create Web Service manually:
  - Root Directory: *(leave empty)* or `.`
  - Build Command: `npm install`
  - Start Command: `npm start`
  - Health Check Path: `/api/health`

Important:
- If you see `Couldn't find a package.json file in "/opt/render/project/src"`, your Root Directory is wrong.
- Fix it by setting Root Directory to blank (repo root) and redeploy.

## 3. Set Environment Variables
- `JWT_SECRET` (required in production)
- `DATABASE_URL` (recommended for persistent production data)
- `OPENAI_API_KEY` (if AI route is enabled)
- `OPENAI_MODEL` (optional)
- `ADMIN_API_KEY` (optional, for admin API)
- `ADMIN_OWNER_EMAIL` (optional, for owner checks)
- `CORS_ORIGINS` (optional, comma-separated, e.g. `https://blossom.42web.io`)

Notes:
- If `CORS_ORIGINS` is empty, server allows all origins (development-friendly).
- Frontend API uses same-origin by default: `window.location.origin + /api`.
- When `DATABASE_URL` is set and `pg` is available, server uses Postgres mode.
- On first Postgres boot, JSON data is imported if the DB is empty.

## 4. Auto Updates
- Auto deploy is enabled.
- Every push to your tracked branch triggers redeploy automatically.

## 5. Data Persistence
- With `DATABASE_URL` configured, users/memories/admin activities are stored in Postgres.
- Without `DATABASE_URL`, app falls back to local JSON files (`users.json`, `admin_activities.json`).

## Netlify Frontend Support (Split Hosting)
- This project can run frontend on Netlify and backend on Render/Railway.

### Netlify setup
1. Connect repo to Netlify.
2. Build command: *(leave empty)*.
3. Publish directory: `src` (already set in `netlify.toml`).
4. After first deploy, edit `src/netlify-config.js`:
   - `window.MEMORY_VAULT_API_URL = 'https://your-backend-domain';`
5. Redeploy.

### Backend requirement
- Netlify does not run this Express server as a long-running backend.
- Keep backend deployed on Render/Railway and point `netlify-config.js` to it.

## Vercel Support (Frontend + API)
- This repo supports Vercel with:
  - Static frontend from `src`
  - Serverless API handler from `api/index.js`

### Vercel setup
1. Import repo into Vercel.
2. Framework preset: Other.
3. Build command: *(leave empty)*.
4. Output directory: *(leave empty)*.
5. Deploy.

### Vercel environment variables
- `JWT_SECRET` (required)
- `DATABASE_URL` (recommended)
- `OPENAI_API_KEY` (optional)
- `OPENAI_MODEL` (optional)
- `ADMIN_API_KEY` (optional)
- `ADMIN_OWNER_EMAIL` (optional)
- `CORS_ORIGINS` (optional, include your Vercel domain)

Notes:
- Routing is controlled by `vercel.json`.
- API requests go to `/api/*` and are handled by `api/index.js`.

