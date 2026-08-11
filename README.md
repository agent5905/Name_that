# Name That Team Member

A host-controlled realtime audience game for company icebreakers. The production target is Cloudflare Pages with Pages Functions and Supabase PostgreSQL/Realtime.

The repository currently contains the verified application foundation. Product flows, persistence, authorization, and realtime behavior are intentionally not implemented yet.

## Requirements

- Node.js 22.12 or newer
- npm 11.16.0 (declared in `packageManager`; the lockfile remains the dependency source of truth)

## Local setup

1. Copy `.env.example` to `.env` and replace only the values needed for the task at hand. Never commit `.env`.
2. Install exactly the locked dependency graph: `npm ci`.
3. Start the frontend: `npm run dev`.

For Pages Functions locally, run `npx wrangler pages dev dist` after `npm run build`. The health probe is available at `/api/health` in the Pages runtime.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same checks after a clean `npm ci` on pushes and pull requests. Production source maps are intentionally disabled; public Pages artifacts should not expose original source unless a future private error-reporting workflow requires them.

## Project map

- `src/domain/` — shared, environment-agnostic game vocabulary
- `src/` — React client entry point
- `functions/` — server-side Cloudflare Pages Functions; secrets belong here only
- `docs/ARCHITECTURE.md` — intended system boundaries and decisions still pending
- `docs/TESTING.md` — verification layers and future gates
- `docs/DEPLOYMENT.md` — Cloudflare deployment contract
- `docs/PROJECT_STATUS.md` — concise handoff state

Browser-exposed variables must begin with `VITE_`. Never expose `SUPABASE_SECRET_KEY`, management credentials, Cloudflare tokens, GitHub tokens, database passwords, or `HOST_SIGNING_SECRET` through Vite configuration or client code.
