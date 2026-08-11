# Testing strategy

The foundation gate is `npm run lint && npm run typecheck && npm test && npm run build`.

Later work must add verification at the boundary where behavior lives:

- unit tests for deterministic domain rules and state transitions;
- Pages Function integration tests for validation, authorization, and idempotency;
- migration/RLS tests against a disposable Supabase-compatible database;
- browser tests for participant, host, and display journeys, reconnect recovery, and viewport/accessibility behavior;
- concurrency tests representing at least 100 participants;
- deployment smoke tests, including `/api/health` and a browser-bundle secret scan.

Mocks can isolate unit tests, but do not count as proof of deployed realtime or authorization behavior.

