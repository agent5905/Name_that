# Name That Team Member

A host-controlled realtime audience game for company icebreakers. The production target is Cloudflare Pages with Pages Functions and Supabase PostgreSQL/Realtime.

The repository contains integrated participant, host-control, and shared-display experiences plus the authoritative Supabase/Cloudflare backend. Private Realtime accelerates updates; authoritative HTTP snapshots recover missed events.

## Requirements

- Node.js 22.12 or newer
- npm 11.16.0 (declared in `packageManager`; the lockfile remains the dependency source of truth)

## Local setup

1. Copy `.env.example` to `.env` and replace only the values needed for the task at hand. Never commit `.env`.
2. Install exactly the locked dependency graph: `npm ci`.
3. Start the frontend: `npm run dev`.

For production-equivalent Pages Functions, copy `.dev.vars.example` to `.dev.vars`, run `npm run build`, then `npx wrangler pages dev dist --port 8788`. Run `npm run test:smoke` in another shell; it requires the same server credentials in `.env` so it can delete its uniquely identified test room.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run check:functions
npm run check:bundle
npm run test:e2e
```

`npm run verify` runs the complete local gate. GitHub Actions repeats its stages after `npm ci` and installs the lockfile-matched Chromium revision. Production source maps are disabled, and the public bundle is scanned for server credentials.

## Project map

- `src/domain/` — shared, environment-agnostic game vocabulary
- `src/` — React client entry point
- `functions/` — server-side Cloudflare Pages Functions; secrets belong here only
- `docs/ARCHITECTURE.md` — system boundaries and authoritative-state design
- `docs/BACKEND.md` — credentials, API contract, state machine, and content operations
- `docs/TESTING.md` — verification layers and future gates
- `docs/DEPLOYMENT.md` — Cloudflare deployment contract
- `docs/PROJECT_STATUS.md` — concise handoff state

Browser-exposed variables must begin with `VITE_`. Never expose `SUPABASE_SECRET_KEY`, management credentials, Cloudflare tokens, GitHub tokens, or database passwords through Vite configuration or client code. Private Realtime uses a persisted Supabase Anonymous Auth session, not an exposed signing key. Host and participant tokens are independently random; there is no shared host-signing secret.
