# Capacity harness operator guide

`scripts/load-capacity.mjs` is a protocol-level load generator for the staged 5, 10, 25, 50, 100, 175, and 225 participant checks. Dry-run is the default and performs no network requests.

```powershell
npm run capacity:dry
node scripts/load-capacity.mjs --participants=25 --rounds=3
```

## Remote execution guard

Remote execution is intentionally difficult to trigger accidentally. It requires `--execute`, an exact client-count acknowledgement, exact Pages and Supabase hostnames, separate acknowledgements for remote application and remote data access, and operator-recorded immutable deployment evidence.

```text
CAPACITY_ORIGIN=https://<pages-host>
CAPACITY_EXPECTED_HOSTNAME=<pages-host>
CAPACITY_EXPECTED_SUPABASE_HOSTNAME=<project-ref>.supabase.co
CAPACITY_ALLOW_REMOTE=1
CAPACITY_ALLOW_REMOTE_DATA=1
CAPACITY_ALLOW_CLIENTS=<exact stage>
CAPACITY_GAME_ID=<saved-game UUID dedicated to the rehearsal>
CAPACITY_ADMIN_TOKEN=<admin token for that game>
CAPACITY_GIT_COMMIT=<full 40-character deployed commit SHA>
CAPACITY_DEPLOYMENT_ID=<Cloudflare deployment UUID>
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<browser-safe key>
SUPABASE_SECRET_KEY=<server-only secret key>
```

The harness cannot independently derive a Cloudflare deployment UUID or Git commit from the served application. The report therefore labels both values as operator-recorded. Correlate them with the Cloudflare deployment dashboard before accepting the evidence; their presence alone is not verification.

Run stages in order and stop on the first failure:

```powershell
node --env-file=.env scripts/load-capacity.mjs --execute --participants=5 --rounds=3 --output=docs/capacity-results/5-client.json
```

Change `CAPACITY_ALLOW_CLIENTS` and the output filename for each subsequent stage. Report files use exclusive creation and will not overwrite prior evidence.

For an approved sequential production batch, `scripts/run-capacity-stages.mjs` creates one isolated three-round fixture with tiny PNG pairs, runs only the explicitly listed increasing stages, and then exact-deletes every fixture room, media row/object, game, and admin profile. It keeps the admin token in process memory and never writes it to a report. Example: `npm run capacity:stages -- 5 10 25`.

## What one simulated client does

Each participant performs its own join, fetches `/api/realtime-auth` once, creates one Supabase client, opens one Realtime WebSocket with one private `room:<code>` channel, hydrates via HTTP, answers each round, and runs the same 60-second jittered safety reconciliation pattern. No Supabase Anonymous Sign-In is used.

A bounded cohort exercises retry-stable joins. Another cohort races concurrent same-choice answer requests and verifies one fresh plus one idempotent result, followed by an immutable-choice rejection. On round one, a bounded tail cohort answers concurrently with Lock. Every raced answer must either be accepted or return `ANSWERS_CLOSED`; all requests are drained before cleanup, Lock transition latency is recorded, and the authoritative Results total must equal the number of unique accepted answers. At 225, an additional 226th join must receive `ROOM_FULL`.

At least five percent of participants join during the first open question when the run has more than one round. Reconnect clients must retain identity and accepted answer state and must receive an idempotent retry response.

## Automated PASS invariants

PASS requires all intended participants to join and reach Realtime, exactly one channel per simulated browser, the expected join/answer/reconnect operations, no failed snapshots, no malformed or same-phase audience events, no Realtime channel errors, exact transition delivery, exact authoritative result totals, successful cleanup, and a healthy load generator. Generator thresholds are p95 event-loop delay at most 100 ms, max event-loop delay at most 1,000 ms, and peak RSS at most 1.5 GiB. CPU time and single-core utilization are recorded for review.

The report fails when any unexpected error category is present. Expected `ANSWER_IMMUTABLE`, `ANSWERS_CLOSED`, and `ROOM_FULL` responses are counted by their dedicated assertions and are not treated as infrastructure errors.

## Deliberate exclusions

This harness does not download frontend bundles or Mystery/Reveal image bytes, render or decode UI, simulate browser storage, or validate host/display responsiveness. It also does not open a second browser tab for the same participant. Duplicate-tab identity, socket lifecycle, UI state, media quality, preload traffic, accessibility, and real host/shared-display behavior belong to the final real-browser gauntlet. Platform dashboard metrics are not inferred from client observations and must be correlated separately.

Use one load-generator machine only when its recorded CPU, memory, and event-loop metrics remain comfortably below the gates. A passing client report is not sufficient if Supabase or Cloudflare dashboards show limits, errors, pool waits, saturation, or unexplained request volume.
