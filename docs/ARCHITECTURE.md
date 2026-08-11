# Architecture

## Approved boundaries

- **React + TypeScript + Vite:** participant, host, and shared-display clients.
- **Cloudflare Pages:** static application delivery.
- **Cloudflare Pages Functions:** trusted HTTP operations, including host authorization and privileged Supabase calls.
- **Supabase PostgreSQL:** authoritative room, participant, round, and answer state.
- **Supabase Realtime:** low-latency invalidation/synchronization. Realtime events are never the sole source of truth; clients recover from an authoritative snapshot.

`src/domain/` contains shared terminology only and must remain independent of React and infrastructure SDKs. Server-only values must never be imported by client modules.

## Decisions not yet made

The persistence schema, row-level security policies, host credential format, participant session token format, transition command contract, realtime channel policy, and image/content pipeline must be designed and independently security-reviewed before implementation. Their future documentation belongs close to migrations and functions rather than in speculative detail here.

