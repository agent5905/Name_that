# 175-person capacity checkpoint

> The scoring renewal passed on 2026-08-13. The original pre-scoring checkpoint remains below and under `capacity-results/pre-scoring-baseline-2026-08-13/`; the first scoring run that exposed the latency regression remains under `capacity-results/scoring-before-index-tuning-2026-08-13/`. The current top-level 5/25/100/175/225 reports are the tuned scoring release evidence.

## Release conclusion

**PASS.** The product target is 175 simultaneous real participants. The engineering envelope is 225 participant clients plus one host and one shared display. The scoring-enabled answer path passed fresh ordered 5, 25, 100, 175, and 225 stages, exact score-ledger and rank oracles, the 226th-participant rejection, Realtime/reconnect gates, production browser acceptance, and preload timing. Every isolated room and the shared tiny fixture were removed. Cloudflare GraphQL CPU quantiles remain unavailable to the configured token; retain the conservative one-normal-event/day operational caveat from the prior checkpoint.

## Scoring renewal checkpoint — 2026-08-13

The final release targets Git commit `c3bea99dd14a1b83be8cd2b74ae0a11cf4f82803`, Cloudflare deployment `a78291a2-1e77-4b01-8237-b460e2115f45`, and `https://name-that-team-member.pages.dev`. Production served `index-FPqJcSgv.js`; `/api/health` returned 200; migration `202608110022` was present in the production ledger.

The first scoring ladder was correct but materially slower than the pre-scoring answer baseline. That evidence is preserved rather than overwritten. Investigation identified a wide leaderboard index whose sort columns changed on every accepted answer and repeated full-room window ranking in each personalized hydration. Migrations 021 and 022 removed the write-amplifying index, retained the room lookup index, and materialized deterministic ranks once per Leaderboard transition. The participant client/harness also stopped making redundant Complete/Leaderboard personalized reads. No cache service or alternate authority was introduced.

| Clients | Answer p95 | First scoring p95 | Personal hydration p95 | Exact points | Rank checks | Pages calls | Realtime deliveries | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 5 | 287.2 ms | 230.7 ms | 291.2 ms | 6,818 | 10 | 69 | 74 | **PASS** |
| 25 | 182.2 ms | 175.4 ms | 675.2 ms | 32,766 | 50 | 317 | 373 | **PASS** |
| 100 | 246.4 ms | 656.4 ms | 2,492.9 ms | 130,946 | 200 | 1,165 | 1,495 | **PASS** |
| 175 | 1,173.4 ms | 1,810.1 ms | 4,210.3 ms | 227,348 | 350 | 2,167 | 2,616 | **PASS** |
| 225 | 2,476.4 ms | 3,082.7 ms | 6,524.3 ms | 287,534 | 450 | 2,751 | 3,363 | **PASS** |

At 100 clients, tuned answer p95 is below the 268.7 ms pre-scoring baseline. At 175 and 225 it is respectively 35% and 20% better than the first scoring run, though still 77% and 28% above the pre-scoring answer baseline because scoring adds an authoritative ledger/aggregate update. Personalized hydration has no pre-scoring equivalent: it returns private feedback/rank after Reveal/Leaderboard and is deliberately outside the voting acknowledgement path. Its 4.21 s/6.52 s p95 at 175/225 is an operational latency caveat, not hidden as a baseline regression. One 175-client Leaderboard transition reached 3.14 s p95. All personalized rank checks completed within the harness timeout without missed state.

Across the tuned ladder, every expected score matched the independent answer-ledger oracle, leaderboard mismatches were zero, snapshot failures/channel errors/same-phase events were zero, and reconnect recovery was 1/1, 3/3, 10/10, 18/18, and 23/23. The 225 run accepted 670 answers and correctly classified five deliberate answer-vs-Lock losses as `ANSWERS_CLOSED`; the 226th join returned `ROOM_FULL`. Peak topology was one channel on each of 225 sockets. The load generator remained healthy (223.9 MiB RSS, 32.4 ms event-loop p95), and exact room plus batch fixture cleanup passed.

A post-run read-only database observation found 20 connections, zero lock waiters, zero cumulative deadlocks, and no remaining capacity rooms. Sixteen connections were idle `ClientRead`; the other wait events were replication/extension activity, not lock contention. The removed leaderboard index was absent and the room lookup index remained. This was a post-run observation, not a fabricated continuous pool trace.

The deployed 11-journey Chrome gauntlet passed. Scoring-specific image timings were 187 ms display Reveal click-to-paint, 187 ms participant Reveal click-to-paint, and 192 ms Leaderboard-to-next-Mystery, all below 500 ms. Network assertions proved one fetch for each prepared next-round Mystery/encrypted Reveal, no duplicate fetch through a held Leaderboard, no plaintext Reveal fallback, and per-session crypto isolation. Independent security, preload, deployed visual/mobile/host, and final adversarial critics passed.

## Read-only production audit — 2026-08-13

| Surface | Observed | Required before final rehearsal | Status |
| --- | ---: | ---: | --- |
| Supabase project | `ACTIVE_HEALTHY`, `us-east-1`, PostgreSQL 17.6 | Healthy throughout rehearsal | Informational |
| Realtime concurrent users | 500 | At least 500 | **PASS** |
| Realtime messages/second | 500 | At least 500 | **PASS** |
| Realtime joins/second | 500 | At least 500 | **PASS** |
| Realtime payload ceiling | 3000 KiB | Transition snapshots below the configured ceiling | **PASS** |
| Anonymous Auth sign-ins | Enabled; 120/hour/IP | Not used by the audience protocol | Remove from capacity path |
| Database connection setting | 60; API pool observed at 10 with no waiting/timeouts | No pool waiting/timeouts or database saturation | **PASS IN REHEARSAL** |
| Database compute | No selected compute add-on was visible; approximately 455 MiB VM memory was observed | Confirm effective compute and headroom in dashboard | **UNCONFIRMED** |
| Cloudflare Pages | Production branch `main`; Functions enabled | Worst tested envelope remains within conservative current-plan limits | **PASS WITH DAILY QUOTA CAVEAT** |

The billed organization label alone was not treated as evidence. The live tenant was initially observed at `200/100/100/256`; after the already-approved Pro upgrade, the Realtime configuration was explicitly raised and read back at `500/500/500/3000`. No billing setting, spend cap, Cloudflare service, or database compute size was changed. The final rehearsal then demonstrated that the 227-socket envelope and transition delivery remained healthy in practice.

## Capacity-critical design contract

- PostgreSQL is authoritative and transactionally caps participants at exactly 225; the 226th concurrent join receives `ROOM_FULL`.
- A browser uses one Supabase client, one Realtime WebSocket, and one private `room:<code>` channel.
- `GET /api/realtime-auth` returns `{ "token": "<public legacy anon JWT>" }` with `Cache-Control: no-store`. It never returns the service-role/secret key.
- The audience does not call Supabase Anonymous Sign-In, avoiding a one-IP signup bottleneck and retained Auth-user growth.
- Joins, answers, and idempotent answer retries emit no room Broadcast. Only the initial snapshot insert and phase/round transitions emit one sanitized authoritative push; snapshot deletion is silent.
- HTTP supplies initial/reconnect truth. Participant reconciliation uses a 60-second safety interval with deterministic jitter; host/display poll aggregate progress more frequently. Online, visibility, malformed-push, and version-gap recovery remain active.
- Mystery/reveal asset preload is bounded and staggered. The protocol harness intentionally does not claim browser decode, visual, or CDN-geography coverage.

At 225 participants, a 60-second participant safety poll averages 3.75 Pages Function requests/second. Two host/display clients polling every two seconds add approximately one request/second, before joins, answers, and host actions. That is roughly 17,100 snapshot requests/hour at steady state. The final rehearsal invoked 1,671 Pages Functions in 69.7 seconds, 1.671% of Cloudflare's documented 100,000-request/day Workers Free floor, with zero browser-observed 5xx, server, or resource-limit responses. Static asset requests are free and unlimited under the documented Pages pricing model. Operationally, keep the event to one normal session/day unless the actual Workers plan or dashboard usage is confirmed, and do not run repeated full-capacity rehearsals on event day.

## Staged load matrix

Run the checked-in protocol harness in order. Stop on unexplained errors, failed cleanup, resource saturation, or materially rising p95/max latency. Do not run 175 or 225 repeatedly after unrelated UI-only changes.

For the scoring renewal, use 5 → 25 → 100 → 175 → 225. The three-round fixture shows the optional leaderboard after Round 1, skips it after Round 2, and requires the final leaderboard before completion. Each stage must independently reconstruct points from the question-open/accepted timing ledger, validate player aggregates and streaks, compare deterministic Top 5/Top 10 order and every participant's personal rank, and retain the strict zero same-phase/per-answer Broadcast gate. Record personalized hydration latency because Reveal and Leaderboard now require an authenticated projection in addition to the global phase push.

| Stage | Purpose | Evidence file | Result |
| ---: | --- | --- | --- |
| 5 | Protocol correctness and report validation | [`5-client.json`](capacity-results/5-client.json) | **PASS** |
| 10 | Early concurrency and duplicate-answer gate | [`10-client.json`](capacity-results/10-client.json) | **PASS** |
| 25 | First meaningful ramp and reconnect check | [`25-client.json`](capacity-results/25-client.json) | **PASS** |
| 50 | DB/API contention trend | [`50-client.json`](capacity-results/50-client.json) | **PASS** |
| 100 | Realtime/Pages trend and dashboard correlation | [`100-client.json`](capacity-results/100-client.json) | **PASS** |
| 175 | Real audience target | [`175-client.json`](capacity-results/175-client.json) | **PASS** |
| 225 | Engineering headroom; run once after all critical fixes | [`225-client.json`](capacity-results/225-client.json) | **PASS** |

Every stage must record the immutable deployed commit/deployment ID, attempted/successful/failed joins, join and answer latency distributions, duplicate-answer integrity, exact authoritative totals, active/peak subscriptions, transition delivery, missed/duplicate/forbidden events, reconnect identity/idempotency, Pages/Supabase request counts, load-generator health, platform dashboard observations, and exact cleanup outcome.

### Completed production stages — 2026-08-13

All passing reports target commit `1b3af4d795b21fc08e3c1d56e90aae8a3d6ee0b3`, Cloudflare deployment `1f41ea72-6045-4e46-871d-9b482de63d84`, and the canonical production origin. Each run used a three-round tiny-image fixture and verified exact room cleanup; its enclosing batch then removed the isolated game, media objects, and admin profile.

| Clients | Duration | Join p95 | Ready p95 | Answer p95 | Worst transition | Reconnect | Pages calls | Realtime deliveries | Generator RSS / loop p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 26.4 s | 202.7 ms | 614.2 ms | 201.1 ms | 216.5 ms | 1/1 | 43 | 64 | 82.3 MiB / 32.1 ms |
| 10 | 26.1 s | 214.4 ms | 921.3 ms | 195.8 ms | 218.5 ms | 1/1 | 73 | 129 | 85.9 MiB / 32.1 ms |
| 25 | 59.8 s | 288.5 ms | 646.9 ms | 196.5 ms | 359.7 ms | 3/3 | 185 | 323 | 89.5 MiB / 32.1 ms |
| 50 | 59.4 s | 179.7 ms | 703.2 ms | 179.9 ms | 296.0 ms | 5/5 | 371 | 647 | 100.8 MiB / 32.1 ms |
| 100 | 60.5 s | 220.3 ms | 647.4 ms | 268.7 ms | 252.5 ms | 10/10 | 731 | 1,295 | 133.6 MiB / 32.4 ms |
| 175 | 60.6 s | 208.2 ms | 613.5 ms | 663.3 ms | 336.0 ms | 18/18 | 1,298 | 2,266 | 154.4 MiB / 32.4 ms |
| 225 | 69.7 s | 238.9 ms | 675.8 ms | 1,937.8 ms | 519.2 ms | 23/23 | 1,671 | 2,913 | 207.0 MiB / 32.4 ms |

Every passing stage recorded all intended joins and answers, exact Results totals, one channel per simulated browser, zero missed transitions, zero same-phase events, zero malformed events/channel errors, and zero unexpected error categories. The first 5-client attempt is retained as [`5-client-failed-reconnect-harness.json`](capacity-results/5-client-failed-reconnect-harness.json): it exposed that the simulator waited for a manually removed channel to resurrect, while production replaces a terminal channel lease. The harness was corrected to recreate one channel on the same client and the controlled 5-client rerun passed; no deployed runtime change was made for that harness-only defect.

For the exact 50-client window, Supabase Management telemetry showed 0 edge 5xx responses and 0 Realtime log events. PostgreSQL recorded 16 `P0001` application exceptions, matching the 15 deliberately immutable duplicate-choice probes plus the one expected answer rejected at the Lock boundary; the harness independently recorded no unexpected errors. Minute-bucket usage around the stage was 48 then 5 Realtime requests, 295 then 161 REST requests, and 9 then 1 Storage requests. These vendor counts are aggregate requests, not delivered Realtime messages, and include fixture setup/cleanup in the same minutes.

The configured Cloudflare token can deploy and inspect Pages deployments but its read-only GraphQL Workers analytics query returned `authorization denied`. The missing CPU quantiles are recorded, not fabricated. The Cloudflare gate nevertheless passes for the tested event profile: 1,671 Function calls were only 1.671% of the conservative 100,000/day Free floor, every expected response completed, and the browser observer recorded zero server/5xx/resource-limit responses. A Workers CPU breach would surface as Error 1102 and therefore fail those request gates. The Functions dashboard remains useful operational telemetry, but no longer blocks this release.

For the exact 100-client window, Supabase Management logs again showed 0 edge 5xx responses and 0 Realtime log events. The 33 PostgreSQL `P0001` application exceptions match the 30 deliberate immutable duplicate-choice probes plus three expected answer/Lock-race closures. No other SQL state or infrastructure error was observed. The Management usage endpoint had not yet emitted its delayed minute bucket when queried, so no request count is invented for this stage; the harness directly recorded 731 Pages Function calls and 1,295 delivered transition messages.

The first and only 175-client run passed: 175/175 joined, all 525 logical answers resolved (524 accepted and one valid `ANSWERS_CLOSED` at the Lock boundary), and all 18 reconnect clients recovered identity and idempotent answer state. Delivery had zero misses across 2,266 transition messages, zero same-phase events, zero malformed events/channel errors, and a worst participant transition of 336.0 ms. The exact window again had 0 Supabase edge 5xx and 0 Realtime log events; 55 `P0001` exceptions exactly match 54 immutable duplicate-choice probes plus the one expected Lock-boundary rejection.

The first and only full 225-participant run also passed, with 227 simultaneous product clients after adding one real 1440×900 host and one real 1280×720 display. All 225 participants joined; the single 226th boundary probe was rejected with `ROOM_FULL`. Across three rounds, 667 answers committed and eight requests lost the deliberate answer-vs-Lock race with `ANSWERS_CLOSED`, exactly accounting for all 675 logical attempts. All 23 reconnect clients recovered their original identities and idempotent answer state. The run delivered 2,913 Realtime transition messages with zero misses, same-phase events, malformed events, channel errors, or unexpected error categories. All 359 snapshot requests succeeded. Host controls completed every transition; participant transition p95 was 455.3 ms and the maximum was 519.2 ms. The real host and display produced 13 phase observations with no console, page, unexpected request, or server errors. The load generator remained healthy at 207.0 MiB peak RSS, 32.4 ms event-loop p95, and 1.8% single-core CPU.

The exact Supabase window for the 225 run showed zero edge 5xx responses and zero Realtime log errors. Its 78 `P0001` application exceptions exactly match 69 immutable duplicate probes, eight expected answer/Lock closures, and the one expected `ROOM_FULL`. Minute usage showed no Auth sign-ins, consistent with the public legacy anon JWT capacity path. A post-run Metrics scrape reported zero pool waiting and zero pool timeouts, nine of ten PostgREST connections available, database load averages of 0.12/0.28/0.18, and about 169 MiB available of the observed 455 MiB VM memory. This post-run scrape is not represented as a continuous time series; the exact client, latency, error, and cumulative timeout evidence comes from the harness and platform logs.

The final browser instrumentation was validated separately with the passing [`browser-smoke/5-client.json`](capacity-results/browser-smoke/5-client.json). One real 1440×900 host context drove all 13 controls and one real 1280×720 display context rendered every phase and decoded the tiny Mystery/Reveal images. Host phase UI max was 1,091.9 ms; display phase UI max was 496.2 ms. There were no console/page/unexpected request/5xx errors. Thirteen `ERR_ABORTED` requests were the expected cancellation of stale HTTP recovery when a newer phase push won; they are recorded separately from failures. A prior nondeterministic smoke with four same-phase notifications is retained as a failure; the subsequent instrumented run had zero, and the 225 rehearsal retains a strict zero gate rather than waiving it.

The 225 rehearsal captured the shared display at question, reveal, results, and completion, plus the host completion state. These screenshots are checked in beside the JSON report. They show decoded Mystery/Reveal media, the expected results presentation, and the host's final `225 Players / 225 Answers` state. The smaller all-browser acceptance suite initially stopped at its first media upload with an expected source limiter response (`429`, `Retry-After: 1395` seconds); it created no room and its exact isolated admin/game teardown completed. The limiter was not bypassed or reset. After its stated window expired, one controlled retry passed all 11 serial journeys in 2.4 minutes. Coverage included two-image/Fun Fact authoring, host/display/mobile participant rendering, Play Again and cross-session crypto isolation, late join in every active phase, refresh recovery, same-tab room switching, participant containment, editor stability, and immutable multi-session history. Production image timings were 165 ms display reveal, 149 ms participant reveal, and 140 ms next-round Mystery against a 500 ms target. The fail-closed teardown passed, and an independent Management SQL audit found zero matching games and zero empty test admin profiles afterward. The concise checkpoint is [`browser-gauntlet-2026-08-13.md`](capacity-results/browser-gauntlet-2026-08-13.md).

## Hard pass/fail gates

A stage fails if any of the following occurs:

- any intended join or answer fails;
- the database contains more than 225 participants or answer totals are not exact;
- join/answer activity emits a same-phase audience message;
- any client misses a phase transition or receives it more than once through duplicate channels;
- reconnect changes participant identity, loses accepted state, or breaks idempotent retry;
- host/display controls become materially unresponsive or a client needs a manual refresh;
- Supabase shows connection/message/join-limit rejection, pool waiting/timeouts, or database saturation;
- Cloudflare shows Function errors, CPU-limit failures, or an unaccounted request spike;
- the load generator saturates, invalidating latency evidence; or
- exact test-room cleanup cannot be verified.

## Final rehearsal and browser gauntlet

The final production rehearsal combines the 225-client protocol run with one real host browser and one real shared display. Observe host controls, aggregate counts, transition timing, display decode/render, and dashboard metrics while the runner is active. Then run a smaller real-browser gauntlet across desktop/laptop, mobile dimensions, 100%/125% zoom, and corporate-like network constraints. Cover lobby arrival, active late join, answer submit/retry, lock/reveal/results, reconnect, completion, and Play Again. Inspect Mystery/Reveal image quality and verify preload behavior does not create a lobby request storm.

## Permanent checkpoint template

Copy this section for each completed capacity-critical release. Do not replace blanks with estimates.

```text
Date/time (timezone):
Production origin:
Cloudflare deployment ID:
Git commit:
Supabase project/region:
Observed Realtime limits (connections/messages/joins/payload):
Observed database compute/pool settings:
Observed Cloudflare Workers/Pages plan behavior:

Harness report paths (5/10/25/50/100/175/225):
Participant count / late-join cohort:
Rounds / join ramp:
Join success and p50/p95/max:
Answer success and p50/p95/max:
Authoritative result integrity:
Peak Realtime subscriptions:
Transition delivery p50/p95/max:
Missed / duplicate / same-phase events:
Reconnect identity/idempotency:
Pages and Supabase request totals:
Dashboard errors, limits, pool, CPU, memory:
Approximate asset traffic / CDN observations:
Load-generator CPU, memory, event-loop delay:
Real host/display observations:
Real-browser gauntlet results:
Cleanup verification:
Known limitations:
Conclusion (PASS / FAIL / BLOCKED):
Evidence reviewed by:
```

A PASS expires when capacity-critical backend, Realtime, answer, hydration, lifecycle, polling, or preload behavior changes. It does not expire for an unrelated copy-only or styling-only change, but the smaller browser gauntlet should still be rerun when presentation behavior changes.

## Authoritative platform references

- [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [Supabase Realtime message accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)
- [Cloudflare Pages Functions metrics](https://developers.cloudflare.com/pages/functions/metrics/)
- [Cloudflare GraphQL Analytics authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/)
- [Cloudflare Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
