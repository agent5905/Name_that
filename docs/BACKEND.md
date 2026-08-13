# Backend and API contract

## Trust boundary

Cloudflare Pages Functions own normal game-state mutations and hold `SUPABASE_SECRET_KEY`. The narrow `host_action_direct` RPC is the exception: a host may submit a phase cue directly with its full capability token, and PostgreSQL authenticates it before changing state. Browsers otherwise receive the publishable key and may fetch the project's public legacy `anon` JWT from `GET /api/realtime-auth`. Room codes are five-character, unambiguous identifiers (`A-H`, `J-N`, `P-Z`, `2-9`) and are never credentials.

Room creation returns an independently generated 256-bit host token. Joining returns a new 256-bit participant token bound to one player and room. Only SHA-256 hashes are stored. Tokens are sent as `Authorization: Bearer <token>` and must be kept out of URLs and logs.

All game tables, including `room_snapshots`, have RLS enabled with no anon/authenticated policies or grants. Clients cannot enumerate snapshots. The Pages snapshot endpoint remains the reconnect source of truth. A database trigger sends one code-scoped, private, sanitized snapshot only when a room snapshot is inserted or changes phase/round; cleanup deletion is silent. Joins, answers, and answer retries do not emit audience Broadcast messages. Participants use slow jittered safety reconciliation; host and display clients poll aggregate progress more frequently without turning every answer into audience fan-out.

The exact client subscription is:

```ts
const response = await fetch('/api/realtime-auth', { cache: 'no-store' });
const { token } = await response.json();
await supabase.realtime.setAuth(token);
const channel = supabase
  .channel(`room:${code}`, { config: { private: true } })
  .on('broadcast', { event: 'room_snapshot_changed' }, ({ payload }) => {
    // Validate roomCode/version/phase and commit the sanitized snapshot.
    // Refetch only when the push is absent, malformed, stale, or has a version gap.
  })
  .subscribe();

// Cleanup: await supabase.removeChannel(channel)
```

The transition payload is `{ roomCode, version, phase, snapshot }`; the snapshot is the same sanitized public projection allowed by the HTTP endpoint. Realtime SELECT authorization permits `anon` reception only for `broadcast` topics matching the exact room-code pattern. A restrictive INSERT policy denies client broadcasts to those topics even if another permissive policy is added later. Hosted Realtime requires a JWT with `role` and `exp` claims for private channels; modern `sb_publishable_*` keys are API keys, not JWTs. `SUPABASE_REALTIME_ANON_KEY` is the project's legacy public `anon` JWT and is returned by the no-store endpoint. It is not the service-role/secret key and grants no game-table or RPC access. Do not create one Supabase Auth user per attendee, call `channel.send`, or subscribe with `postgres_changes`.

## HTTP API

All JSON responses include `cache-control: no-store`. JSON mutation bodies are limited to 8 KiB. Errors have the stable shape `{ "error": { "code": "...", "message": "..." } }`; raw database and storage errors are not returned.

### Create and join

- `POST /api/rooms` (no body) returns `201 { room: { roomId, code }, hostToken }`. Code collisions are retried up to eight times. A source may attempt five creations per fixed 15-minute window; excess attempts return `429`, error code `ROOM_CREATION_RATE_LIMITED`, and `Retry-After` seconds.
- `POST /api/rooms/:code/join`, JSON `{ name }`, returns `201 { participant: { playerId, roomId, displayName }, participantToken }`.
- `GET /api/realtime-auth` returns `200 { token }` with `Cache-Control: no-store`. The token is the public legacy `anon` JWT used only to authorize private Realtime topics.

Room creation uses PostgreSQL `gen_random_bytes` to independently shuffle the correct-member sequence and each round's four choices. Every choice set contains its correct member and exactly three alternatives. Joining locks the room and rejects the 226th player with `ROOM_FULL`, so simultaneous boundary joins cannot exceed 225.

Pages hashes Cloudflare's overwritten `CF-Connecting-IP` value with SHA-256 before calling the atomic limiter RPC. PostgreSQL stores only the 32-byte hash, window timestamps, and counts—never a raw address. Missing or malformed headers share a stable local-development fallback key. The limiter returns rejection instead of raising, so rejected increments commit independently of room creation.

### State reads

- `GET /api/rooms/:code/snapshot` returns `{ snapshot }`. Add participant bearer authorization and `x-player-id` together to receive `{ participant: { playerId, answerEmployeeId } }` as well.
- `GET /api/rooms/:code/host` with the host bearer token returns `{ host: { roomId, code, phase, currentRound, roundCount, isFinalRound, correctEmployee, version } }`. `correctEmployee` is null in the lobby and otherwise contains `{ id, displayName, team }`; it is host-only even before reveal. `isFinalRound` lets the host choose `end` instead of `next_round` after final results.

Snapshot fields are `roomCode`, `phase`, `roundIndex`, `roundCount`, `connectedParticipantCount`, `submittedAnswerCount`, `version`, `choices`, `revealedEmployee`, `results`, and `updatedAt`. Choices expose candidates but never mark the correct choice. `revealedEmployee` remains null until reveal. `results` remains null until `show_results`.

### Commands and media

- `POST /api/rooms/:code/answers` with participant bearer authorization and JSON `{ playerId, choiceId, roundIndex }` returns `{ answer: { accepted, idempotent, employeeId, roundIndex } }`.
- `POST /api/rooms/:code/actions` with host bearer authorization and JSON `{ action }` returns `{ snapshot }`. Actions are `start`, `lock`, `reveal`, `show_results`, `show_leaderboard`, `next_round`, and `end`.
- `GET /api/rooms/:code/media/:memberId` returns `image/webp` only when that member is the current correct answer and the phase is at least reveal; otherwise it returns the generic `MEDIA_NOT_AVAILABLE` 404.

The enforced progression is `lobby -> question_open -> answers_locked -> employee_revealed -> results_displayed`. A non-final Results screen may either advance directly to the next question or enter `leaderboard_displayed`; a final Results screen must enter `leaderboard_displayed` before `end` may produce `complete`. Every transition takes an exclusive per-room advisory gate and then locks the room row. Answer submission takes the shared form of that gate and includes the expected round index, allowing concurrent inserts while preserving an exact answer/lock boundary and preventing a delayed request from scoring a later round. The answer primary key makes one answer immutable. Repeating the same requested-round answer is idempotent even after a phase advance; changing it is rejected.

Scoring is database-authoritative. Each question records its database open time, and each accepted answer stores its accepted timestamp, correctness, bounded authoritative elapsed milliseconds, awarded points, and streak transition. Correct answers receive 750 base points plus a deterministic integer-rounded speed bonus of up to 250 over 20 seconds; wrong answers receive zero. The participant answer response contains no correctness or score. Authenticated participant hydration discloses current-round feedback only from Reveal onward and rank only during Leaderboard or Complete. Public snapshots expose only the bounded Top 5 mid-game or Top 10 final board, ordered by total score, correct-answer count, total correct response time, then player UUID.

## Database and demo content

- Migrations: ordered files in `supabase/migrations/`, including the additive 225-capacity/phase-only Broadcast migration `202608110015_225_participant_capacity.sql`
- Fictional metadata: `supabase/seed.sql`
- Apply: `npm run supabase:apply`
- Upload four tracked WebPs to private `reveal-media`: `npm run content:upload`
- Run live RLS/state/leakage checks: `npm run test:integration`

The apply script refuses to replay the initial schema when `game_phase` already exists, applies every additive hosted patch in order, and then idempotently upserts only the four fictional member rows. It does not delete project resources. The integration script creates uniquely coded test rooms and removes only those rooms and their internal snapshots in `finally`.

The target project was inspected before migration and had zero `storage.objects` policies. The migration keeps `reveal-media` private and adds a bucket-scoped restrictive `SELECT` policy denying anon/authenticated reads even if a future permissive policy is added. It leaves other buckets and policies untouched. Live checks prove anon cannot enumerate snapshots, list reveal objects, download a known reveal path, or execute private RPCs.

## Room lifecycle

Accepted room-creation requests first invoke separate opportunistic cleanup RPCs. Room cleanup locks only eligible rows with `FOR UPDATE SKIP LOCKED`, deletes completed rooms after 12 hours, and deletes any room with no mutation activity for 24 hours. Room deletion cascades only that room's rounds, choices, players, and answers; its matching internal snapshot is deleted explicitly without fanning a cleanup event to old listeners. Active mutations refresh `rooms.updated_at` and either hold or win the same room lock, preserving live event reliability. No attendee Auth-user cleanup is needed because the audience never creates Supabase Auth users. No external scheduler is required. Limiter rows not touched for one day are pruned opportunistically as well.
