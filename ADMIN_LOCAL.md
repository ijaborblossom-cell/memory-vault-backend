# Local Admin Dashboard

The admin dashboard is now a separate local app and is not served from the main web app routes.

## Run

1. In the project root, run:
   - `npm run admin:local`
2. Open:
   - `http://localhost:3000`

## Sign in on admin dashboard

Use the fields on the page:
- API base: `https://memory-vault-coral-seven.vercel.app/api` (default)
- Owner email/username
- Owner password
- Admin API key

Then click **Sign In & Start Realtime**.

The dashboard shows realtime activity and account metrics without exposing vault memory content.
