# Architecture

## Approved boundaries

- **React + TypeScript + Vite:** participant, host, and shared-display clients.
- **Cloudflare Pages:** static application delivery.
- **Cloudflare Pages Functions:** trusted HTTP operations, including host authorization and privileged Supabase calls.
- **Supabase PostgreSQL:** authoritative room, participant, round, and answer state.
- **Supabase Realtime:** low-latency invalidation/synchronization. Realtime events are never the sole source of truth; clients recover from an authoritative snapshot.

`src/domain/` contains shared terminology only and must remain independent of React and infrastructure SDKs. Server-only values must never be imported by client modules.

## Authoritative backend decisions

PostgreSQL functions own every mutation. Joins and host transitions lock the room row; answer inserts take a shared per-room transaction advisory gate while host phase changes take its exclusive form. This admits concurrent answers without allowing an answer/lock race to cross the phase boundary. Opaque host and participant tokens are independently generated; PostgreSQL stores only SHA-256 hashes. Participant hashes bind a credential to exactly one player and room. The room code is discovery data only.

Private tables, including `room_snapshots`, expose no anon/authenticated policies. Pages Functions return a sanitized snapshot over HTTP as the initial/reconnect source of truth. A code-scoped private Supabase Broadcast carries that same sanitized projection only on phase or round transitions. Same-phase joins and answers emit no audience event, avoiding answer-count fan-out across 225 listeners. Realtime authorization uses the project's public legacy `anon` JWT, permits receive-only access to exact room topics, and restrictively denies client inserts. This removes the corporate-NAT bottleneck and retained-user growth caused by one anonymous Auth signup per browser while preserving RLS. The API withholds the correct member and media until reveal, and aggregate results until the results phase. Reveal bytes live in a private Storage bucket and are streamed through a phase-checking Pages Function. See `docs/BACKEND.md` for the contract.

Each browser owns one Supabase client, one Realtime socket, and one room channel. Participants reconcile against HTTP on a slow jittered safety interval plus online/visibility/version-gap recovery. Host and display clients use a faster aggregate-progress poll because join/answer updates are intentionally absent from audience Broadcast. A reconnect hydrates HTTP first and then resumes the phase channel; Realtime accelerates state changes but is never the only recovery mechanism.

The transactional participant ceiling is 225. The release envelope is 225 participant clients plus one host and one shared display. Capacity evidence must therefore cover database locking, Pages request volume, Realtime connection/join/message limits, reconnect identity/idempotency, and asset delivery separately; a protocol runner is not proof of browser rendering or CDN geography.

Room creation admission is an atomic PostgreSQL fixed-window counter keyed only by a SHA-256 hash of Cloudflare's source-IP header. A separate opportunistic cleanup transaction bounds retained room graphs without requiring a scheduler: completed rooms retain a 12-hour recovery window and otherwise inactive rooms expire after 24 hours.
