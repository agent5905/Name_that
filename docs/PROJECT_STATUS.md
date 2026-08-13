# Project status

## Current state

The integrated participant, host-control, and shared-display baseline is deployed at `https://name-that-team-member.pages.dev`. The 175-person capacity hardening is in progress and must not be represented as release-ready until the live tenant limit blocker, updated integration gate, staged reports, final 225-client rehearsal, and real-browser gauntlet recorded in `docs/CAPACITY.md` are complete.

## Verified

Verified locally on 2026-08-11 with Node.js 24.18.0 and npm 11.16.0:

- `npm run lint` - passed with zero warnings;
- `npm run typecheck` - passed;
- `npm test` - 36 domain, recovery, API, and migration guards passed;
- `npm run build` - passed with Vite 7.3.6 and no production source maps;
- `npm run check:functions` - all API Functions compiled successfully;
- `npm run check:bundle` - public artifacts passed source-map and server-secret checks;
- `npm run test:e2e` - 12 participant, host, and display browser journeys passed, including HTTP 500/network preservation and 401 host-session invalidation;
- historical `npm run test:integration` baseline - passed against the configured Supabase project, including private Broadcast delivery/forgery denial, RLS, Storage, randomized rounds, immutable answers, result math, and the former 100-player cap; the new 225-capacity/phase-only test must pass after deployment;
- `npm run test:smoke` - passed through local Wrangler Pages/Functions against the live Supabase project, from health and room creation through protected portrait reveal and results; the exact test room was removed afterward;
- `npm run test:smoke` with exact remote-host opt-in - passed the same HTTP lifecycle on the stable production Pages alias;
- `npm run test:smoke:browser` - real Chrome passed a deployed host/participant event through answer, lock, reveal, protected portrait decode, results, and the 1280x720 shared display;
- independent mobile, host-control, shared-display, and backend/security reviews passed after their findings were fixed.

## Backend delivered

- Five-character collision-retried room codes are identifiers only. Random 256-bit host and participant credentials are distinct, and only SHA-256 hashes persist.
- Joins, answers, and transitions are transactional security-definer RPCs. Joins use the exact room-row admission lock; concurrent answers use a shared per-room advisory gate and host transitions use its exclusive form, preserving the answer/lock boundary without serializing all answers. A primary key enforces one immutable answer per player/round.
- RLS is enabled everywhere and anon/authenticated cannot enumerate `room_snapshots`. The capacity design uses a public legacy `anon` JWT for one receive-only private room channel per browser; it carries sanitized state only on phase/round transitions, while HTTP remains authoritative for initial hydration and recovery.
- The private `reveal-media` Storage bucket and phase/current-member endpoint protect bytes before reveal.
- The authenticated host projection includes the current correct member and final-round indicator without adding either to the public pre-reveal snapshot.
- Four fictional members and tracked WebP files have idempotent metadata/upload tooling.
- Room creation requires at least four active employees; each round contains exactly four choices and always includes its correct employee.
- Correct-member order and choice layout use database CSPRNG bytes per room. The additive capacity migration raises the locked join ceiling to 225 and preserves stable `ROOM_FULL` behavior for the 226th concurrent join.
- RPC response parsers validate and allowlist create, join, answer, and host payloads before returning them.
- Room creation is limited atomically to five attempts per hashed Cloudflare source in 15 minutes; rejected attempts persist and return `429` with `Retry-After`.
- Opportunistic locked cleanup retains completed rooms for 12 hours and expires otherwise inactive room graphs after 24 hours, with no scheduler dependency.

The baseline versioned Supabase migrations and four private fictional portraits are applied to the configured `IceBreaker` project. The capacity migration and runtime configuration require fresh live verification. The revised audience protocol creates no per-attendee Supabase Auth users; integration and capacity runs still remove only their exact rooms and limiter records.

Cloudflare Pages project `name-that-team-member` is live with encrypted `SUPABASE_URL` and `SUPABASE_SECRET_KEY` runtime bindings. The stable origin and the exact production deployment passed HTTP and browser smoke checks. A post-run audit found zero matching smoke rooms and zero tagged Realtime users.

## Capacity release gate

The 2026-08-13 read-only audit found the Realtime tenant still configured for 200 concurrent users, 100 messages/second, and 100 joins/second. That cannot support 225 participants plus host/display and is a hard blocker even if the organization is billed as Pro. Verify at least the Pro 500/500/500 limits in the live tenant and confirm database compute/pool and Cloudflare Functions headroom before any final rehearsal. No paid-plan change is authorized by this status document.

Capacity completion requires immutable reports for 5, 10, 25, 50, 100, 175, and 225 stages; zero failed joins/answers; exact answer totals; no same-phase audience broadcasts; no missed phase transitions; reconnect identity/idempotency success; host/display responsiveness; production dashboard observations; and verified cleanup. Until those artifacts exist, the conclusion is **NOT YET PROVEN**.
