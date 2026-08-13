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
| 5 | Protocol correctness and report validation | _pending_ | _pending_ |
| 10 | Early concurrency and duplicate-answer gate | _pending_ | _pending_ |
| 25 | First meaningful ramp and reconnect check | _pending_ | _pending_ |
| 50 | DB/API contention trend | _pending_ | _pending_ |
| 100 | Realtime/Pages trend and dashboard correlation | _pending_ | _pending_ |
| 175 | Real audience target | _pending_ | _pending_ |
| 225 | Engineering headroom; run once after all critical fixes | _pending_ | _pending_ |

Every stage must record the immutable deployed commit/deployment ID, attempted/successful/failed joins, join and answer latency distributions, duplicate-answer integrity, exact authoritative totals, active/peak subscriptions, transition delivery, missed/duplicate/forbidden events, reconnect identity/idempotency, Pages/Supabase request counts, load-generator health, platform dashboard observations, and exact cleanup outcome.

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
