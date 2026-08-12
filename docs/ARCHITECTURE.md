# Architecture

## Approved boundaries

- **React + TypeScript + Vite:** participant, host, and shared-display clients.
- **Cloudflare Pages:** static application delivery.
- **Cloudflare Pages Functions:** trusted HTTP operations, including host authorization and privileged Supabase calls.
- **Supabase PostgreSQL:** authoritative room, participant, round, and answer state.
- **Supabase Realtime:** low-latency invalidation/synchronization. Realtime events are never the sole source of truth; clients recover from an authoritative snapshot.

`src/domain/` contains shared terminology only and must remain independent of React and infrastructure SDKs. Server-only values must never be imported by client modules.

## Authoritative backend decisions

PostgreSQL functions own every mutation and lock the room row to serialize answers with host transitions. Opaque host and participant tokens are independently generated; PostgreSQL stores only SHA-256 hashes. Participant hashes bind a credential to exactly one player and room. The room code is discovery data only.

Private tables, including `room_snapshots`, expose no anon/authenticated policies. Pages Functions return a sanitized snapshot over HTTP as the reconnect source of truth. A code-scoped private Supabase Broadcast carries only `{ roomCode, version }` invalidation, never a row image. Realtime authorization permits receive-only access to exact room topics and restrictively denies client inserts. The API withholds the correct member and media until reveal, and aggregate results until the results phase. Reveal bytes live in a private Storage bucket and are streamed through a phase-checking Pages Function. See `docs/BACKEND.md` for the contract.

Room creation admission is an atomic PostgreSQL fixed-window counter keyed only by a SHA-256 hash of Cloudflare's source-IP header. A separate opportunistic cleanup transaction bounds retained room graphs without requiring a scheduler: completed rooms retain a 12-hour recovery window and otherwise inactive rooms expire after 24 hours.
