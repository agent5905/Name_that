# Testing strategy

## Backend gates

`functions/_lib/api.test.ts` exercises request validation, typed error redaction, room-code generation, distinct 256-bit credentials, hashing, and snapshot field allowlisting.

After migration and content upload, `npm run test:integration` verifies private-table/snapshot/RPC denial for anon, anonymous sign-in plus private room Broadcast reception and denied direct client send, reveal-media list/download denial, CSPRNG sequence/choice invariants, atomic five-attempt creation limiting with a persisted sixth rejection, a simultaneous 100th-vs-101st join race, scoped expiry with active-room preservation, absence of plaintext credentials, wrong-host and cross-player rejection, legal/illegal transitions, idempotent replay, immutable changed answers, answer-after-lock rejection, leakage boundaries, protected media release, and result totals. Supabase Auth Anonymous Sign-Ins must be enabled. The test deletes its anonymous Auth user, uniquely coded rooms, and limiter key in `finally`.

`npm run verify` is the complete local gate: lint, typecheck, Vitest, production build, Pages Functions compilation, bundle/source-map scan, and Playwright participant/host/display journeys. Browser tests include narrow phones, presentation viewports, QR decoding, a real portrait fixture, and host-session recovery after HTTP 500 and network failures; a 401 test proves definitive authorization rejection clears the session.

## Pages HTTP and browser smoke

After copying `.dev.vars.example` to `.dev.vars`, build and start `npx wrangler pages dev dist --port 8788`. In another shell, run `npm run test:smoke`. It refuses non-local target hosts and exercises health, create/join/snapshot, participant and host authorization, idempotent answer, lock, media secrecy, reveal, protected WebP delivery, and results through actual Functions. It uses the server credential only to delete its exact snapshot and room in `finally`.

For a deployed-origin smoke, set `SMOKE_BASE_URL` to the exact HTTPS origin, set `SMOKE_ALLOW_REMOTE=true`, and set `SMOKE_EXPECTED_HOST` to that URL's exact hostname. The double opt-in prevents an accidental run against an arbitrary destination; cleanup remains limited to the room created by that run.

The configured Supabase project has passed the checked-in integration/security suite, including two authenticated private listeners, forged-event non-delivery, database-triggered invalidation, and the 100-player boundary race. Local Wrangler and the stable deployed Pages origin both passed the HTTP smoke. `npm run test:smoke:browser` additionally passed a real deployed Chrome flow spanning host, participant, private Realtime recovery, protected portrait decode, results, and the shared display; its exact room and tagged Auth user are removed in `finally`.

Mocks can isolate unit tests, but do not count as proof of deployed realtime or authorization behavior.
