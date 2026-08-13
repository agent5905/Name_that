# Project status

## Current state

The integrated participant, host-control, and shared-display baseline is deployed at `https://name-that-team-member.pages.dev`. The 175-person production-size and 225-participant engineering-capacity rehearsals passed on 2026-08-13, followed by all 11 production browser journeys after the test honored the image-upload limiter's `Retry-After` window. The sole remaining release evidence is the Cloudflare Functions dashboard checkpoint. See `docs/CAPACITY.md` for the immutable reports and caveat.

## Verified

Verified locally on 2026-08-11 with Node.js 24.18.0 and npm 11.16.0:

- `npm run lint` - passed with zero warnings;
- `npm run typecheck` - passed;
- `npm test` - 104 domain, recovery, API, migration, Realtime, and preload guards passed;
- `npm run build` - passed with Vite 7.3.6 and no production source maps;
- `npm run check:functions` - all API Functions compiled successfully;
- `npm run check:bundle` - public artifacts passed source-map and server-secret checks;
- `npm run test:e2e` - 22 participant, host, display, routing, delayed-answer, and recovery browser journeys passed;
- production integration and capacity gates passed against the configured Supabase project, including receive-only private Broadcast, RLS, Storage, randomized rounds, immutable answers, exact 225 admission/226th rejection, phase-only fan-out, answer/Lock races, and result math;
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

The versioned Supabase migrations, including migration 015 for the 225-participant protocol, are applied to the configured `IceBreaker` project. The revised audience protocol creates no per-attendee Supabase Auth users; integration and capacity runs remove only their exact rooms and limiter records.

Cloudflare Pages project `name-that-team-member` is live with encrypted `SUPABASE_URL` and `SUPABASE_SECRET_KEY` runtime bindings. The stable origin and the exact production deployment passed HTTP and browser smoke checks. A post-run audit found zero matching smoke rooms and zero tagged Realtime users.

## Capacity release gate

The 2026-08-13 audit initially found the Realtime tenant at 200 concurrent users, 100 messages/second, and 100 joins/second. Under the already-approved Supabase Pro entitlement, those tenant settings were raised and read back at 500 concurrent users, 500 messages/second, 500 joins/second, and a 3000 KiB payload ceiling. No billing plan, spend cap, Cloudflare service, or database compute size was changed.

Immutable reports now exist for 5, 10, 25, 50, 100, 175, and 225 participants. The first full 225 run passed with 225/225 joins, exact answer accounting, a successful 226th `ROOM_FULL` boundary test, zero missed/same-phase/malformed Realtime events, 23/23 reconnects, a responsive real host and display, healthy generator metrics, zero Supabase edge 5xx/Realtime errors, and verified exact cleanup. The smaller production browser gauntlet then passed all 11 journeys, including late joins, reconnect/refresh, Play Again, room switching, mobile rendering, participant containment, and sub-500 ms image transitions. Application capacity is **PASS** for the 175-person event with 225-participant headroom. Overall release evidence remains **BLOCKED** only on Cloudflare Functions dashboard visibility; it is not silently waived.
