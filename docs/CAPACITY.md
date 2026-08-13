# 175-person capacity checkpoint

## Release conclusion

**NOT YET PROVEN.** The product target is 175 simultaneous real participants. The engineering envelope is 225 participant clients plus one host and one shared display. The Realtime tenant limit blocker has been cleared, but no release claim is valid until the staged production reports, final rehearsal, platform evidence, real-browser gauntlet, and cleanup are recorded here.

## Read-only production audit — 2026-08-13

| Surface | Observed | Required before final rehearsal | Status |
| --- | ---: | ---: | --- |
| Supabase project | `ACTIVE_HEALTHY`, `us-east-1`, PostgreSQL 17.6 | Healthy throughout rehearsal | Informational |
| Realtime concurrent users | 500 | At least 500 | **READY FOR STAGED TEST** |
| Realtime messages/second | 500 | At least 500 | **READY FOR STAGED TEST** |
| Realtime joins/second | 500 | At least 500 | **READY FOR STAGED TEST** |
| Realtime payload ceiling | 3000 KiB | Transition snapshots below the configured ceiling | **READY FOR STAGED TEST** |
| Anonymous Auth sign-ins | Enabled; 120/hour/IP | Not used by the audience protocol | Remove from capacity path |
| Database connection setting | 60; API pool observed at 10 with no waiting/timeouts | No pool waiting/timeouts or database saturation | Verify under staged load |
| Database compute | No selected compute add-on was visible; approximately 455 MiB VM memory was observed | Confirm effective compute and headroom in dashboard | **UNCONFIRMED** |
| Cloudflare Pages | Production branch `main`; Functions enabled | Confirm Workers plan, request/error/CPU behavior | **UNCONFIRMED** |

The billed organization label alone was not treated as evidence. The live tenant was initially observed at `200/100/100/256`; after the already-approved Pro upgrade, the Realtime configuration was explicitly raised and read back at `500/500/500/3000`. No billing setting, spend cap, Cloudflare service, or database compute size was changed. The staged tests must still demonstrate that the final 227-socket envelope and one transition delivered to the audience remain healthy in practice.

## Capacity-critical design contract

- PostgreSQL is authoritative and transactionally caps participants at exactly 225; the 226th concurrent join receives `ROOM_FULL`.
- A browser uses one Supabase client, one Realtime WebSocket, and one private `room:<code>` channel.
- `GET /api/realtime-auth` returns `{ "token": "<public legacy anon JWT>" }` with `Cache-Control: no-store`. It never returns the service-role/secret key.
- The audience does not call Supabase Anonymous Sign-In, avoiding a one-IP signup bottleneck and retained Auth-user growth.
- Joins, answers, and idempotent answer retries emit no room Broadcast. Only the initial snapshot insert and phase/round transitions emit one sanitized authoritative push; snapshot deletion is silent.
- HTTP supplies initial/reconnect truth. Participant reconciliation uses a 60-second safety interval with deterministic jitter; host/display poll aggregate progress more frequently. Online, visibility, malformed-push, and version-gap recovery remain active.
- Mystery/reveal asset preload is bounded and staggered. The protocol harness intentionally does not claim browser decode, visual, or CDN-geography coverage.

At 225 participants, a 60-second participant safety poll averages 3.75 Pages Function requests/second. Two host/display clients polling every two seconds add approximately one request/second, before joins, answers, and host actions. That is roughly 17,100 snapshot requests/hour at steady state. Confirm the actual Cloudflare plan and event duration against its included request allowance; static asset requests follow Cloudflare's separate static delivery behavior.

## Staged load matrix

Run the checked-in protocol harness in order. Stop on unexplained errors, failed cleanup, resource saturation, or materially rising p95/max latency. Do not run 175 or 225 repeatedly after unrelated UI-only changes.

| Stage | Purpose | Evidence file | Result |
| ---: | --- | --- | --- |
| 5 | Protocol correctness and report validation | [`5-client.json`](capacity-results/5-client.json) | **PASS** |
| 10 | Early concurrency and duplicate-answer gate | [`10-client.json`](capacity-results/10-client.json) | **PASS** |
| 25 | First meaningful ramp and reconnect check | [`25-client.json`](capacity-results/25-client.json) | **PASS** |
| 50 | DB/API contention trend | [`50-client.json`](capacity-results/50-client.json) | **PASS** |
| 100 | Realtime/Pages trend and dashboard correlation | [`100-client.json`](capacity-results/100-client.json) | **PASS** |
| 175 | Real audience target | [`175-client.json`](capacity-results/175-client.json) | **PASS** |
| 225 | Engineering headroom; run once after all critical fixes | _pending_ | _pending_ |

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

Every passing stage recorded all intended joins and answers, exact Results totals, one channel per simulated browser, zero missed transitions, zero same-phase events, zero malformed events/channel errors, and zero unexpected error categories. The first 5-client attempt is retained as [`5-client-failed-reconnect-harness.json`](capacity-results/5-client-failed-reconnect-harness.json): it exposed that the simulator waited for a manually removed channel to resurrect, while production replaces a terminal channel lease. The harness was corrected to recreate one channel on the same client and the controlled 5-client rerun passed; no deployed runtime change was made for that harness-only defect.

For the exact 50-client window, Supabase Management telemetry showed 0 edge 5xx responses and 0 Realtime log events. PostgreSQL recorded 16 `P0001` application exceptions, matching the 15 deliberately immutable duplicate-choice probes plus the one expected answer rejected at the Lock boundary; the harness independently recorded no unexpected errors. Minute-bucket usage around the stage was 48 then 5 Realtime requests, 295 then 161 REST requests, and 9 then 1 Storage requests. These vendor counts are aggregate requests, not delivered Realtime messages, and include fixture setup/cleanup in the same minutes.

The configured Cloudflare token can deploy and inspect Pages deployments but its read-only GraphQL Workers analytics query returned `authorization denied`. Cloudflare's Functions Metrics dashboard evidence—successful/error invocations, subrequests, and CPU/resource outcomes—therefore remains a mandatory human/dashboard checkpoint before 175/225 can be accepted; it is not inferred from the harness.

For the exact 100-client window, Supabase Management logs again showed 0 edge 5xx responses and 0 Realtime log events. The 33 PostgreSQL `P0001` application exceptions match the 30 deliberate immutable duplicate-choice probes plus three expected answer/Lock-race closures. No other SQL state or infrastructure error was observed. The Management usage endpoint had not yet emitted its delayed minute bucket when queried, so no request count is invented for this stage; the harness directly recorded 731 Pages Function calls and 1,295 delivered transition messages.

The first and only 175-client run passed: 175/175 joined, all 525 logical answers resolved (524 accepted and one valid `ANSWERS_CLOSED` at the Lock boundary), and all 18 reconnect clients recovered identity and idempotent answer state. Delivery had zero misses across 2,266 transition messages, zero same-phase events, zero malformed events/channel errors, and a worst participant transition of 336.0 ms. The exact window again had 0 Supabase edge 5xx and 0 Realtime log events; 55 `P0001` exceptions exactly match 54 immutable duplicate-choice probes plus the one expected Lock-boundary rejection.

The final browser instrumentation was validated separately with the passing [`browser-smoke/5-client.json`](capacity-results/browser-smoke/5-client.json). One real 1440×900 host context drove all 13 controls and one real 1280×720 display context rendered every phase and decoded the tiny Mystery/Reveal images. Host phase UI max was 1,091.9 ms; display phase UI max was 496.2 ms. There were no console/page/unexpected request/5xx errors. Thirteen `ERR_ABORTED` requests were the expected cancellation of stale HTTP recovery when a newer phase push won; they are recorded separately from failures. A prior nondeterministic smoke with four same-phase notifications is retained as a failure; the subsequent instrumented run had zero, and the 225 rehearsal retains a strict zero gate rather than waiving it.

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
