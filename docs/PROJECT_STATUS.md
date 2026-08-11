# Project status

## Current state

Foundation implemented: pinned React/TypeScript/Vite dependencies and npm runtime, tracked npm lockfile, strict type checking, ESLint, Vitest, GitHub Actions CI, Cloudflare Pages configuration, a minimal health Function, shared game-phase terminology, and environment/documentation contracts.

## Verified

Verified on 2026-08-11 with Node.js 24.18.0 and npm 11.16.0:

- `npm run lint` - passed with zero warnings;
- `npm run typecheck` - passed;
- `npm test` - 12 tests passed;
- `npm run build` - passed with Vite 7.3.6 and no production source maps;
- `npm audit` - zero known vulnerabilities;
- `wrangler pages functions build` - health Function bundle compiled successfully.

CI is configured to repeat a clean install, lint, typecheck, tests, and build on pushes and pull requests. Its first hosted run remains pending until the workflow is pushed.

## Foundation decisions

- npm 11.16.0 is declared exactly in `packageManager`; CI installs that version before `npm ci` to keep local and hosted dependency resolution aligned.
- Production sourcemaps are disabled because Cloudflare Pages serves build artifacts publicly. Enable them only for a future error-reporting service that supports private map upload.
- CI uses read-only repository permissions and runs each quality gate explicitly, so failures identify the broken layer.

## Not yet implemented

- participant, host, and shared-display product experiences;
- Supabase migrations, RLS policies, and version-controlled game content;
- room/session APIs, host authorization, idempotent answers, authoritative transitions;
- realtime subscription and reconnect recovery;
- integration, browser, security, visual, load, and deployed smoke tests;
- Cloudflare/Supabase deployment setup and the first hosted GitHub Actions run.

## Risks / next decisions

The host authorization and participant isolation design are the first security-critical decisions. No product backend should ship before those contracts and database policies receive adversarial review.

