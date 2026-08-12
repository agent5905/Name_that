# Project status

## Current state

Integrated participant, host-control, and shared-display product plus the authoritative Supabase/Cloudflare backend are deployed at `https://name-that-team-member.pages.dev`. Host credentials survive transient verification failures, private Broadcast accelerates updates, and HTTP snapshot polling/recovery remains authoritative.

## Verified

Verified locally on 2026-08-11 with Node.js 24.18.0 and npm 11.16.0:

- `npm run lint` - passed with zero warnings;
- `npm run typecheck` - passed;
- `npm test` - 36 domain, recovery, API, and migration guards passed;
- `npm run build` - passed with Vite 7.3.6 and no production source maps;
- `npm run check:functions` - all API Functions compiled successfully;
- `npm run check:bundle` - public artifacts passed source-map and server-secret checks;
- `npm run test:e2e` - 12 participant, host, and display browser journeys passed, including HTTP 500/network preservation and 401 host-session invalidation;
- `npm run test:integration` - passed against the configured Supabase project, including private Broadcast delivery/forgery denial, RLS, Storage, randomized rounds, immutable answers, result math, and the transactional 100-player cap;
- `npm run test:smoke` - passed through local Wrangler Pages/Functions against the live Supabase project, from health and room creation through protected portrait reveal and results; the exact test room was removed afterward;
- `npm run test:smoke` with exact remote-host opt-in - passed the same HTTP lifecycle on the stable production Pages alias;
- `npm run test:smoke:browser` - real Chrome passed a deployed host/participant event through answer, lock, reveal, protected portrait decode, results, and the 1280x720 shared display;
- independent mobile, host-control, shared-display, and backend/security reviews passed after their findings were fixed.

## Backend delivered

- Five-character collision-retried room codes are identifiers only. Random 256-bit host and participant credentials are distinct, and only SHA-256 hashes persist.
- Joins, answers, and transitions are transactional security-definer RPCs. Room row locks serialize answer/lock races and a primary key enforces one immutable answer per player/round.
- RLS is enabled everywhere and anon/authenticated cannot enumerate `room_snapshots`. Code-scoped private, receive-only Broadcast carries only revision invalidation; authoritative sanitized snapshots come from the Pages API.
- The private `reveal-media` Storage bucket and phase/current-member endpoint protect bytes before reveal.
- The authenticated host projection includes the current correct member and final-round indicator without adding either to the public pre-reveal snapshot.
- Four fictional members and tracked WebP files have idempotent metadata/upload tooling.
- Room creation requires at least four active employees; each round contains exactly four choices and always includes its correct employee.
- Correct-member order and choice layout use database CSPRNG bytes per room. A locked 100-player join cap returns stable `ROOM_FULL` at the boundary.
- RPC response parsers validate and allowlist create, join, answer, and host payloads before returning them.
- Room creation is limited atomically to five attempts per hashed Cloudflare source in 15 minutes; rejected attempts persist and return `429` with `Retry-After`.
- Opportunistic locked cleanup retains completed rooms for 12 hours and expires otherwise inactive room graphs after 24 hours, with no scheduler dependency.

The versioned Supabase migrations and four private fictional portraits are applied to the configured `IceBreaker` project. The live integration suite cleaned its tagged Auth users, limiter rows, and rooms back to zero; the later Pages smoke also removed its exact room.

Cloudflare Pages project `name-that-team-member` is live with encrypted `SUPABASE_URL` and `SUPABASE_SECRET_KEY` runtime bindings. The stable origin and the exact production deployment passed HTTP and browser smoke checks. A post-run audit found zero matching smoke rooms and zero tagged Realtime users.

## Risk

The deployed origin is production-verified for the scoped game flow. Continue monitoring Cloudflare/Supabase quotas and Auth growth before a larger event; CAPTCHA/Turnstile remains optional future abuse hardening.
