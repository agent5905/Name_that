# Deployment

Cloudflare Pages serves `dist/` and discovers server routes in `functions/`. `wrangler.toml` is the checked-in deployment and Functions compatibility contract. Encrypted values remain in the Pages project; the configuration contains names and paths only.

## Build configuration

- Build command: `npm run build`
- Build output directory: `dist`
- Production runtime: Cloudflare Pages
- Health endpoint: `GET /api/health`

Configure browser-safe `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as Pages build variables. Configure `SUPABASE_URL` as a runtime variable and `SUPABASE_SECRET_KEY` plus `SUPABASE_REALTIME_ANON_KEY` as encrypted Pages runtime values. `SUPABASE_REALTIME_ANON_KEY` is the project's legacy public `anon` JWT; `/api/realtime-auth` returns it with `Cache-Control: no-store` because Supabase Realtime private channels require JWT claims that a modern publishable API key does not contain. It must never be confused with or replaced by a service-role/secret key. No host signing secret is used. Management and CI credentials are not application runtime variables.

Use `npm run cloudflare:configure` to transmit the Supabase runtime values from `.env` to Pages through Wrangler's in-memory bulk-secret input. This avoids Windows shell encoding pitfalls and never writes or prints secret values.

The audience does not call Supabase Anonymous Sign-In. One public legacy `anon` JWT authorizes receive-only private Realtime channels, so 175 attendees behind one corporate NAT do not compete for an anonymous-signup token bucket and do not create retained Auth users. RLS continues to deny `anon` access to every game table and mutation RPC, and the restrictive Realtime INSERT policy denies client Broadcast sends.

Before a 175-person event, verify the live Supabase Realtime tenant configuration—not merely the billing label—supports at least 500 concurrent connections, 500 messages per second, and 500 channel joins per second. The engineering rehearsal uses 225 participant connections plus one host and one display. A tenant still reporting 200/100/100 is a release blocker. Confirm database compute/pool headroom and Cloudflare Pages Functions request/error behavior from their dashboards; do not change a paid plan automatically. Record the observed settings and dashboard evidence in `docs/CAPACITY.md`.

Run `npm run verify` before deployment. `npm run deploy` rebuilds, compiles Pages Functions, scans public artifacts, and deploys `dist/` to the project named in `wrangler.toml`. For local production-equivalent verification, use `.dev.vars.example`, `npx wrangler pages dev dist --port 8788`, and `npm run test:smoke`. A deployed smoke additionally requires `SMOKE_ALLOW_REMOTE=true` and an exact `SMOKE_EXPECTED_HOST` match; every smoke removes only its own room. Production readiness additionally requires the versioned migration, private content upload, live integration/security gate, deployed-origin smoke, staged capacity reports, and a final 225-client rehearsal with a real host and display.
