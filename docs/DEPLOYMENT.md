# Deployment

Cloudflare Pages serves `dist/` and discovers server routes in `functions/`. `wrangler.toml` is the checked-in local deployment contract.

## Build configuration

- Build command: `npm run build`
- Build output directory: `dist`
- Production runtime: Cloudflare Pages
- Health endpoint: `GET /api/health`

Configure browser-safe `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Pages build variables. Configure secrets such as `SUPABASE_SECRET_KEY` and `HOST_SIGNING_SECRET` as encrypted Pages runtime secrets only. Management and CI credentials are not application runtime variables.

An authenticated operator can deploy with `npm run deploy`. Production readiness additionally requires migrations, host authorization, browser flows, secret scanning, and a deployed smoke test; none are implied by a successful static build.

