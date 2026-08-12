# Deployment

Cloudflare Pages serves `dist/` and discovers server routes in `functions/`. `wrangler.toml` is the checked-in local deployment contract.

## Build configuration

- Build command: `npm run build`
- Build output directory: `dist`
- Production runtime: Cloudflare Pages
- Health endpoint: `GET /api/health`

Configure browser-safe `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Pages build variables. Configure `SUPABASE_URL` as a runtime variable and `SUPABASE_SECRET_KEY` as an encrypted Pages runtime secret. No host signing secret is used. Management and CI credentials are not application runtime variables.

`npm run supabase:apply` idempotently enables Supabase Auth Anonymous Sign-Ins and sets its bounded IP limit to 120 per hour so a 100-person corporate audience behind one NAT can join with retry headroom. Keep that limit bounded and monitor Auth growth. The browser persists and reuses its anonymous session and tags it `application=name-that-realtime`. The scoped cleanup RPC deletes only tagged anonymous users older than 30 days. CAPTCHA/Turnstile is recommended future hardening once its client flow and secret are provisioned, but is not part of the current deployment contract.

Run `npm run verify` before deployment. `npm run deploy` rebuilds, compiles Pages Functions, scans public artifacts, and deploys `dist/` to the project named in `wrangler.toml`. For local production-equivalent verification, use `.dev.vars.example`, `npx wrangler pages dev dist --port 8788`, and `npm run test:smoke`; the smoke refuses non-local origins and always removes its test room. Production readiness additionally requires the versioned migration, private content upload, live integration/security gate, and a deployed-origin smoke.
